#!/usr/bin/env node
// Synthetic transport only: explicit build/package, no SQLite, credentials or models.
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { createConnection, createServer } from 'node:net'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { performance } from 'node:perf_hooks'
import { resolve, join } from 'node:path'
import { pathToFileURL, fileURLToPath } from 'node:url'

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
const exec = promisify(execFile)

export function probeEcho(endpoint, payload, timeoutMs = 5000) {
  return new Promise((accept, reject) => {
    const socket = createConnection(endpoint)
    let offset = 0, finished = false, failure
    const finish = error => {
      if (finished) return
      finished = true; failure = error
      clearTimeout(timer); socket.destroy()
    }
    const timer = setTimeout(() => finish(new Error('ECHO_TIMEOUT')), timeoutMs)
    socket.once('connect', () => socket.write(payload))
    socket.on('error', error => finish(error))
    socket.on('data', bytes => {
      if (finished) return
      if (!bytes.equals(payload.subarray(offset, offset + bytes.length))) return finish(new Error('ECHO_MISMATCH'))
      offset += bytes.length
      if (offset === payload.length) finish()
    })
    socket.once('close', () => {
      clearTimeout(timer)
      if (finished && !failure) accept(offset)
      else reject(failure ?? new Error('ECHO_INCOMPLETE'))
    })
  })
}

export function assessResources(baseline, final) {
  for (const row of [baseline, final]) {
    for (const key of ['handles', 'privateBytes', 'workingSet']) {
      if (!Number.isSafeInteger(row[key]) || row[key] <= 0) throw new Error('BAD_METRICS')
    }
  }
  const delta = {
    handles: final.handles - baseline.handles,
    privateBytes: final.privateBytes - baseline.privateBytes,
    workingSet: final.workingSet - baseline.workingSet
  }
  return { pass: delta.handles <= 32 && delta.privateBytes <= 64 * 1024 * 1024,
    delta, limits: { handles: 32, privateBytes: 64 * 1024 * 1024 }, workingSetGate: false }
}

async function readMetrics(pid) {
  assert(Number.isSafeInteger(pid) && pid > 0)
  const code = '$ErrorActionPreference="Stop"; $p=Get-Process -Id ([int]$env:MIMIR_STRESS_PID); [pscustomobject]@{handles=$p.HandleCount;privateBytes=$p.PrivateMemorySize64;workingSet=$p.WorkingSet64;threads=$p.Threads.Count} | ConvertTo-Json -Compress'
  const { stdout } = await exec('C:/Windows/System32/WindowsPowerShell/v1.0/powershell.exe',
    ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(code, 'utf16le').toString('base64')], {
      windowsHide: true, timeout: 5000, maxBuffer: 16384,
      env: { SystemRoot: 'C:\\Windows', WINDIR: 'C:\\Windows', MIMIR_STRESS_PID: String(pid) }
    })
  const sample = JSON.parse(stdout.trim())
  assessResources(sample, sample) // A missing/non-numeric metric must fail, not become zero.
  return sample
}

async function abortConnection(endpoint) {
  await new Promise((accept, reject) => {
    const socket = createConnection(endpoint)
    let connected = false, error
    const timer = setTimeout(() => { error = new Error('ABORT_TIMEOUT'); socket.destroy() }, 5000)
    socket.once('connect', () => { connected = true; socket.destroy() })
    socket.on('error', e => { error = e; socket.destroy() })
    socket.once('close', () => { clearTimeout(timer); connected && !error ? accept() : reject(error ?? new Error('ABORT_CONNECT')) })
  })
}

async function main() {
  assert.equal(process.platform, 'win32', 'WINDOWS_ONLY')
  assert(process.argv.length <= 5, 'BAD_ARGUMENTS')
  const root = resolve(process.argv[2] ?? '.')
  const seconds = Number(process.argv[3] ?? 120)
  const warmupSeconds = Number(process.argv[4] ?? 120)
  assert(Number.isSafeInteger(seconds) && seconds >= 30 && seconds <= 3600, 'BAD_DURATION')
  assert(Number.isSafeInteger(warmupSeconds) && warmupSeconds >= 0 && warmupSeconds <= 600, 'BAD_WARMUP')
  const { startWindowsPipeRelay } = await import(pathToFileURL(join(root, 'out/main/assetsWindowsPipe.js')).href)
  const endpoint = `\\\\.\\pipe\\mimir-assets-${randomUUID()}`
  const clients = new Set()
  const server = createServer(socket => {
    clients.add(socket)
    socket.on('error', () => {})
    socket.once('close', () => clients.delete(socket))
    socket.pipe(socket)
  })
  await new Promise((accept, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', accept) })
  let relay, audits = 0, bytes = 0, rounds = 0, aborted = 0, cleanup, report
  const payload = Buffer.alloc(256 * 1024)
  for (let i = 0; i < payload.length; i++) payload[i] = i % 251
  async function round() {
    const results = await Promise.allSettled(Array.from({ length: 8 }, () => probeEcho(endpoint, payload)))
    const failure = results.find(result => result.status === 'rejected')
    if (failure) throw failure.reason
    for (const result of results) bytes += result.value
  }
  try {
    relay = await startWindowsPipeRelay({ endpoint, port: server.address().port, onAudit: audit => {
      assert.equal(audit.ordinal, ++audits)
      assert.equal(audit.rejectRemote, true)
      assert(audit.dacl.includes('(D;;FA;;;NU)'))
      assert.equal(audit.dacl.match(/\(A;/g)?.length, 1)
      assert(audit.dacl.includes(`;;;${audit.ownerSid})`))
    } })
    for (let i = 0; i < 10; i++) { await round(); await sleep(100) }
    await sleep(3000)
    const warmStart = performance.now(), warmupSamples = [{ atMs: 0, ...await readMetrics(relay.pid) }]
    let warmupRounds = 0, warmupAborted = 0, nextWarmSample = 20000
    while (performance.now() - warmStart < warmupSeconds * 1000) {
      await round(); warmupRounds++
      if (warmupRounds % 10 === 0) { await abortConnection(endpoint); warmupAborted++ }
      await sleep(250)
      if (performance.now() - warmStart >= nextWarmSample) {
        const sample = { atMs: Math.round(performance.now() - warmStart), ...await readMetrics(relay.pid) }
        warmupSamples.push(sample)
        console.error(JSON.stringify({ result: 'WARMUP_SAMPLE', ...sample }))
        nextWarmSample += 20000
      }
    }
    const warmupElapsedMs = Math.round(performance.now() - warmStart), warmupBytes = bytes
    await sleep(3000)
    const samples = [{ atMs: 0, phase: 'warmed-idle', ...await readMetrics(relay.pid) }]
    console.error(JSON.stringify({ result: 'BASELINE', helperPid: relay.pid, ...samples[0] }))
    bytes = 0
    const start = performance.now()
    let nextSample = 20000
    while (performance.now() - start < seconds * 1000) {
      await round(); rounds++
      if (rounds % 10 === 0) { await abortConnection(endpoint); aborted++ }
      await sleep(250)
      if (performance.now() - start >= nextSample) {
        await sleep(100)
        samples.push({ atMs: Math.round(performance.now() - start), phase: 'between-rounds', ...await readMetrics(relay.pid) })
        nextSample += 20000
      }
    }
    const elapsedMs = Math.round(performance.now() - start)
    await sleep(3000)
    samples.push({ atMs: Math.round(performance.now() - start), phase: 'cooled-idle', ...await readMetrics(relay.pid) })
    const resources = assessResources(samples[0], samples.at(-1))
    report = { result: 'PASS', scope: 'synthetic-native-relay-only', runtime: process.versions.node,
      root, requestedSeconds: seconds, elapsedMs, concurrency: 8, payloadBytes: payload.length,
      warmup: { requestedSeconds: warmupSeconds, elapsedMs: warmupElapsedMs, rounds: warmupRounds,
        abortedConnections: warmupAborted, verifiedBytesPerDirection: warmupBytes, samples: warmupSamples },
      rounds, verifiedConnections: rounds * 8, abortedConnections: aborted,
      verifiedBytesPerDirection: bytes, nativeInstances: audits, samples, resources }
    console.error(JSON.stringify({ ...report, result: 'OBSERVATION', backendSockets: clients.size }))
    if (!resources.pass) {
      for (let i = 0; i < 6; i++) {
        await sleep(5000)
        console.error(JSON.stringify({ result: 'POST_FAILURE_IDLE', atMs: Math.round(performance.now() - start), ...await readMetrics(relay.pid) }))
      }
    }
    assert(resources.pass, 'RESOURCE_GROWTH_LIMIT')
    assert.equal(clients.size, 0, 'BACKEND_SOCKETS_REMAIN')
    assert(rounds > 0 && aborted > 0 && audits >= 8 * (rounds + warmupRounds + 10), 'INSUFFICIENT_LOAD')
  } finally {
    try {
      await relay?.close()
      if (relay) {
        assert.deepEqual(await relay.closed, { expected: true })
        assert.throws(() => process.kill(relay.pid, 0), error => error.code === 'ESRCH')
        // Parent exit and final kernel pipe destruction are distinct observations.
        let gone = false
        for (let i = 0; i < 30 && !gone; i++) {
          try { await abortConnection(endpoint); await sleep(100) } catch (error) {
            if (['ENOENT', 'ECONNREFUSED'].includes(error.code)) gone = true
            else throw error
          }
        }
        assert(gone, 'PIPE_REMAINS')
        cleanup = { helperExited: true, pipeGone: true }
      }
    } finally {
      for (const socket of clients) socket.destroy()
      await new Promise(resolve => server.close(resolve))
    }
  }
  console.log(JSON.stringify({ ...report, cleanup }, null, 2))
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => { console.error(JSON.stringify({ result: 'FAIL', code: error.code ?? null, message: error.message })); process.exitCode = 1 })
}
