#!/usr/bin/env node
// Diagnostic copies only. Never install these variants as the production relay.
import assert from 'node:assert/strict'
import { readFileSync, writeFileSync, mkdirSync, mkdtempSync, copyFileSync, realpathSync } from 'node:fs'
import { resolve, join, relative, isAbsolute, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

function replaceOnce(text, from, to) {
  assert.equal(text.split(from).length, 2, 'BUNDLE_MARKER')
  return text.replace(from, to)
}

const snapshot = `
  static void Snapshot() {
    try {
      int r, t, workers, io, maxWorkers, maxIo;
      lock(gate) { r = resources.Count; t = tasks.Count; }
      ThreadPool.GetAvailableThreads(out workers, out io);
      ThreadPool.GetMaxThreads(out maxWorkers, out maxIo);
      using(var p = System.Diagnostics.Process.GetCurrentProcess()) {
        Emit("DIAG resources="+r+" tasks="+t+" handles="+p.HandleCount+" threads="+p.Threads.Count+" busyWorkers="+(maxWorkers-workers)+" busyIo="+(maxIo-io)+" managed="+GC.GetTotalMemory(false)+" gc0="+GC.CollectionCount(0)+" gc1="+GC.CollectionCount(1)+" gc2="+GC.CollectionCount(2));
      }
    } catch { Emit("DIAG failed"); }
  }
`

export function instrumentRelayBundle(original, mode) {
  assert(['baseline', 'pipe-only', 'connect-only'].includes(mode), 'BAD_MODE')
  assert(!original.includes('  static void Snapshot()') && !original.includes('line.startsWith("DIAG ")'), 'ALREADY_DIAGNOSTIC')
  let code = replaceOnce(original, '  static async Task RunAsync(string endpoint, int port) {', snapshot + '\n  static async Task RunAsync(string endpoint, int port) {')
  code = replaceOnce(code, '  static void Observe(Task task) { }', '  static int diagnosticStage, diagnosticOrdinal;\n  static void Observe(Task task) { }')
  code = replaceOnce(code, 'if (handle.IsInvalid) { handle.Dispose(); throw new IOException(); }', 'if (handle.IsInvalid) { int nativeError = Marshal.GetLastWin32Error(); handle.Dispose(); Emit("DIAG nativeError="+nativeError+" stage="+diagnosticStage+" ordinal="+diagnosticOrdinal); throw new IOException(); }')
  code = replaceOnce(code, '          var pipe = Instance(endpoint, ++ordinal, sid); Track(pipe);', '          diagnosticStage = 1; diagnosticOrdinal = ordinal + 1;\n          var pipe = Instance(endpoint, ++ordinal, sid); Track(pipe);\n          diagnosticOrdinal = ordinal;')
  code = replaceOnce(code, '          await slots.WaitAsync(stop.Token);', '          diagnosticStage = 2;\n          await slots.WaitAsync(stop.Token);')
  code = replaceOnce(code, '          try { await pipe.WaitForConnectionAsync(stop.Token); }', '          diagnosticStage = 3;\n          try { await pipe.WaitForConnectionAsync(stop.Token); }')
  code = replaceOnce(code, '          var task = Relay(pipe, port, stop.Token);', '          diagnosticStage = 4;\n          var task = Relay(pipe, port, stop.Token);')
  code = replaceOnce(code, '    catch { Emit("{\\"kind\\":\\"failed\\"}"); Environment.ExitCode = 1; }', '    catch (Exception error) { Emit("DIAG exception="+error.GetType().Name+" hresult="+error.HResult+" stage="+diagnosticStage+" ordinal="+diagnosticOrdinal); Emit("{\\"kind\\":\\"failed\\"}"); Environment.ExitCode = 1; }')
  code = replaceOnce(code, '  const fail = () => {', '  const fail = () => {\n    process.stderr.write("DIAG wrapperFail ordinal=" + ordinal + " ready=" + Number(ready) + " expected=" + Number(expected) + " bufferedBytes=" + Buffer.byteLength(buffer) + "\\n");')
  code = replaceOnce(code, '  child.on("close", onClosed);', '  child.on("close", (code, signal) => {\n    process.stderr.write("DIAG childClose code=" + (Number.isInteger(code) ? code : "null") + " signaled=" + Number(Boolean(signal)) + " ordinal=" + ordinal + " expected=" + Number(expected) + "\\n");\n    onClosed();\n  });')
  code = replaceOnce(code, 'using (var slots = new SemaphoreSlim(15, 15)) {', 'using (var slots = new SemaphoreSlim(15, 15))\n    using (var monitor = new System.Threading.Timer(_ => Snapshot(), null, 5000, 5000)) {')
  code = replaceOnce(code, '      try {\n        const message = JSON.parse(line);', '      if (line.startsWith("DIAG ")) { process.stderr.write(line + "\\n"); continue; }\n      try {\n        const message = JSON.parse(line);')
  if (mode !== 'baseline') {
    const startMarker = '  static async Task Relay('
    assert.equal(code.split(startMarker).length, 2, 'BUNDLE_MARKER')
    const start = code.indexOf(startMarker), end = code.indexOf('  static void Snapshot()', start)
    assert(start >= 0 && end > start, 'BUNDLE_MARKER')
    const body = mode === 'pipe-only' ? `  static async Task Relay(NamedPipeServerStream pipe, int port, CancellationToken stop) {
    try { await pipe.CopyToAsync(pipe, 65536, stop); }
    catch { } finally { Release(pipe); }
  }
` : `  static async Task Relay(NamedPipeServerStream pipe, int port, CancellationToken stop) {
    var tcp = new TcpClient(); Track(tcp);
    try {
      var connect = tcp.ConnectAsync("127.0.0.1", port);
      if (await Task.WhenAny(connect, Task.Delay(5000, stop)) != connect) throw new IOException();
      await connect; tcp.Close();
      await pipe.CopyToAsync(pipe, 65536, stop);
    } catch { } finally { Release(tcp); Release(pipe); }
  }
`
    code = code.slice(0, start) + body + code.slice(end)
  }
  return code
}

export function assertOutsideApp(root, parent) {
  const actualRoot = realpathSync(root), actualParent = realpathSync(parent)
  const pathInside = relative(actualRoot.toLowerCase(), actualParent.toLowerCase())
  assert(pathInside === '..' || pathInside.startsWith('..' + sep) || isAbsolute(pathInside), 'OUTPUT_INSIDE_APP')
}

function main() {
  assert.equal(process.platform, 'win32', 'WINDOWS_ONLY')
  assert.equal(process.argv.length, 4, 'USAGE: appRoot existingOutputParent')
  const root = resolve(process.argv[2]), parent = resolve(process.argv[3])
  assertOutsideApp(root, parent)
  const original = readFileSync(join(root, 'out/main/assetsWindowsPipe.js'), 'utf8')
  const dependencies = [...original.matchAll(/from "(\.\/localTransport-[\w-]+\.js)"/g)].map(match => match[1].slice(2))
  assert.equal(dependencies.length, 1, 'BUNDLE_DEPENDENCY')
  // Resolve all transformations before creating a directory, and never overwrite an existing app.
  const variants = ['baseline', 'pipe-only', 'connect-only'].map(mode => ({ mode, code: instrumentRelayBundle(original, mode) }))
  const destination = mkdtempSync(join(parent, 'mimir-pipe-isolation-'))
  for (const { mode, code } of variants) {
    const app = join(destination, mode), output = join(app, 'out/main')
    mkdirSync(output, { recursive: true })
    writeFileSync(join(app, 'package.json'), '{"type":"module"}\n')
    for (const dependency of dependencies) copyFileSync(join(root, 'out/main', dependency), join(output, dependency))
    writeFileSync(join(output, 'assetsWindowsPipe.js'), code)
    console.log(JSON.stringify({ diagnosticOnly: true, mode, appRoot: app }))
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { main() } catch (error) { console.error(error.message); process.exitCode = 1 }
}
