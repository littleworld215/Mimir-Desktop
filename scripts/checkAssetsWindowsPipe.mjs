#!/usr/bin/env node
// Probe ONLY the explicit build/package; no source fallback, real user store, or model.
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { createConnection, createServer } from 'node:net'
import { resolve, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { spawn } from 'node:child_process'
import { hostname } from 'node:os'

const root = resolve(process.argv[2] ?? '.')
const { startWindowsPipeRelay } = await import(pathToFileURL(join(root, 'out/main/assetsWindowsPipe.js')).href)
const endpoint = `\\\\.\\pipe\\mimir-assets-${randomUUID()}`
const sockets = new Set()
const server = createServer(s => { sockets.add(s); s.once('close', () => sockets.delete(s)); s.pipe(s) })
await new Promise(r => server.listen(0, '127.0.0.1', r))
const audits = []
let relay
async function connect(path, timeout = 2000) {
  const socket = createConnection(path)
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { socket.destroy(); reject(Object.assign(new Error('TIMEOUT'), {code: 'TIMEOUT'})) }, timeout)
    socket.once('connect', () => { clearTimeout(timer); socket.setTimeout(2000, () => socket.destroy(Object.assign(new Error('TIMEOUT'), {code: 'TIMEOUT'}))); resolve(socket) })
    socket.once('error', error => { clearTimeout(timer); reject(error) })
  })
}
async function remoteProbe() {
  // An unrestricted control distinguishes SMB transport absence from remote denial.
  const name = `mimir-control-${randomUUID()}`
  const script = '$ErrorActionPreference="Stop"; $s=New-Object System.IO.Pipes.PipeSecurity; $sid=New-Object System.Security.Principal.SecurityIdentifier("S-1-1-0"); $r=New-Object System.IO.Pipes.PipeAccessRule($sid,"FullControl","Allow"); $s.AddAccessRule($r); $p=New-Object System.IO.Pipes.NamedPipeServerStream($env:CONTROL,"InOut",1,"Byte","Asynchronous",65536,65536,$s); [Console]::Out.WriteLine("READY"); [Console]::Out.Flush(); $t=$p.WaitForConnectionAsync(); $t.Wait(4000) | Out-Null; $p.Dispose()'
  const child = spawn('C:/Windows/System32/WindowsPowerShell/v1.0/powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')], {
    windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'], env: {SystemRoot: 'C:\\Windows', WINDIR: 'C:\\Windows', TEMP: process.env.TEMP, CONTROL: name}
  })
  child.stderr.resume()
  const exited = new Promise(r => child.once('close', r))
  try {
    const ready = await new Promise(r => {
      const timeout = setTimeout(() => r(false), 5000)
      child.stdout.once('data', b => { clearTimeout(timeout); r(b.toString().includes('READY')) })
      child.once('error', () => { clearTimeout(timeout); r(false) })
    })
    if (!ready) return 'REMOTE_PATH_UNAVAILABLE'
    let control
    try { control = await connect(`\\\\${hostname()}\\pipe\\${name}`) } catch { return 'REMOTE_PATH_UNAVAILABLE' }
    control.destroy()
    try {
      const remote = await connect(endpoint.replace('\\\\.\\', `\\\\${hostname()}\\`))
      remote.destroy(); throw new Error('REMOTE_WAS_ACCEPTED')
    } catch (error) {
      if (error.message === 'REMOTE_WAS_ACCEPTED') throw error
      return ['EACCES', 'EPERM'].includes(error.code) ? 'REMOTE_DENIED' : 'REMOTE_RESULT_UNVERIFIED'
    }
  } finally { child.kill(); await exited }
}
try {
  relay = await startWindowsPipeRelay({endpoint, port: server.address().port, onAudit: a => audits.push(a)})
  for (let i = 0; i < 3; i++) {
    const socket = await connect(endpoint)
    const body = Buffer.from(`逐字转发-${i}\r\n`)
    const echoed = new Promise((r, e) => { socket.once('data', r); socket.once('error', e) })
    socket.write(body)
    assert.deepEqual(await echoed, body)
    socket.destroy()
  }
  assert(audits.length >= 3)
  for (const [i, audit] of audits.entries()) {
    assert.equal(audit.ordinal, i + 1)
    assert.equal(audit.rejectRemote, true) // Successful Create flag; not a kernel query.
    assert(audit.dacl.includes('(D;;FA;;;NU)'))
    assert.equal(audit.dacl.match(/\(A;/g)?.length, 1)
    assert(audit.dacl.includes(`;;;${audit.ownerSid})`))
  }
  await assert.rejects(startWindowsPipeRelay({endpoint, port: server.address().port}))
  const remote = await remoteProbe()
  await relay.close()
  assert.deepEqual(await relay.closed, {expected: true})
  await assert.rejects(connect(endpoint))
  console.log(JSON.stringify({ result: 'PASS', runtime: process.versions, root, instances: audits.length, audits, remote, close: 'PASS' }, null, 2))
} catch { console.error('NATIVE_PIPE_PROBE_FAILED'); process.exitCode = 1 }
finally {
  await relay?.close()
  for (const s of sockets) s.destroy()
  await new Promise(r => server.close(r))
}
