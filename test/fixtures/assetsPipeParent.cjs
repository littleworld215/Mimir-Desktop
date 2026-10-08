// Real parent-death fixture: only owns its one child, never touches an application store.
const { spawn } = require('node:child_process')
const script = 'Add-Type -TypeDefinition $env:SRC; [AssetsNativePipe]::Run($env:ENDPOINT,12345)'
const child = spawn('C:/Windows/System32/WindowsPowerShell/v1.0/powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')], {
  env: { SystemRoot: 'C:\\Windows', WINDIR: 'C:\\Windows', TEMP: process.env.TEMP, SRC: process.env.SRC, ENDPOINT: process.env.ENDPOINT },
  stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true
})
console.log(`PID:${child.pid}`)
child.stdout.pipe(process.stdout)
child.stderr.resume()
