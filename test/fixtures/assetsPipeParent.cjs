// Real parent-death fixture validates the actual published helper.
const { spawn } = require('node:child_process')
const { dirname } = require('node:path')
async function main() {
  const { verifyPipeArtifact } = await import('../../scripts/lib/assetsPipeArtifact.mjs')
  const { executable } = await verifyPipeArtifact(process.env.ARTIFACT, { rid: 'win-x64' })
  const child = spawn(executable, [], {
    cwd: dirname(executable), windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'],
    env: { SystemRoot: process.env.SystemRoot, WINDIR: process.env.WINDIR, TEMP: process.env.TEMP,
      MIMIR_PIPE_ENDPOINT: process.env.ENDPOINT, MIMIR_PIPE_PORT: '12345' }
  })
  console.log('PID:' + child.pid)
  child.stdout.pipe(process.stdout)
  child.stderr.resume()
}
main().catch(() => { process.exitCode = 1 })
