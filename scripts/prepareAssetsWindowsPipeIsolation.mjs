#!/usr/bin/env node
// Diagnostic copies only. Never install these variants as the production relay.
import assert from 'node:assert/strict'
import { readFileSync, writeFileSync, mkdirSync, mkdtempSync, copyFileSync, realpathSync } from 'node:fs'
import { resolve, join, relative, isAbsolute, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { publishDiagnosticHelper } from './lib/assetsPipeDiagnostics.mjs'
import { pipeSourceHash, verifyPipeArtifact } from './lib/assetsPipeArtifact.mjs'
import { projectDir, outputDir } from './prepareAssetsPipeHelper.mjs'
import { artifactLocationForRoot } from './lib/assetsPipeLocation.mjs'

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

const eventsSource = `
  static readonly Queue<string> diagnosticEvents = new Queue<string>();
  static readonly Dictionary<IDisposable, int> diagnosticPipes = new Dictionary<IDisposable, int>();
  static long diagnosticSequence;
  static void DiagnosticEvent(string kind, NamedPipeServerStream pipe, int ordinal) {
    lock(gate) {
      if (kind == "created") diagnosticPipes.Add(pipe, ordinal);
      diagnosticEvents.Enqueue("DIAG event="+kind+" seq="+(++diagnosticSequence)+" ticksUtc="+DateTime.UtcNow.Ticks+" qpc="+System.Diagnostics.Stopwatch.GetTimestamp()+" frequency="+System.Diagnostics.Stopwatch.Frequency+" highRes="+(System.Diagnostics.Stopwatch.IsHighResolution ? 1 : 0)+" ordinal="+ordinal+" live="+diagnosticPipes.Count);
      while (diagnosticEvents.Count > 128) diagnosticEvents.Dequeue();
    }
  }
  static void DiagnosticDisposed(IDisposable value) {
    lock(gate) {
      int ordinal;
      if (!diagnosticPipes.TryGetValue(value, out ordinal)) return;
      diagnosticPipes.Remove(value);
      DiagnosticEvent("disposed", null, ordinal);
    }
  }
  static void DiagnosticDump() { lock(gate) { foreach(var line in diagnosticEvents) Emit(line); } }
`

export function instrumentPipeSource(original, mode, { events = false } = {}) {
  assert(['baseline', 'pipe-only', 'connect-only'].includes(mode), 'BAD_MODE')
  assert(!original.includes('  static void Snapshot()') && !original.includes('line.startsWith("DIAG ")'), 'ALREADY_DIAGNOSTIC')
  let code = replaceOnce(original, '  static async Task RunAsync(string endpoint, int port) {', snapshot + '\n  static async Task RunAsync(string endpoint, int port) {')
  code = replaceOnce(code, '  static void Observe(Task task) { }', '  static int diagnosticStage, diagnosticOrdinal;\n  static void Observe(Task task) { }')
  code = replaceOnce(code, 'if (handle.IsInvalid) { handle.Dispose(); throw new IOException(); }', 'if (handle.IsInvalid) { int nativeError = Marshal.GetLastWin32Error(); handle.Dispose(); Emit("DIAG nativeError="+nativeError+" stage="+diagnosticStage+" ordinal="+diagnosticOrdinal); throw new IOException(); }')
  for (const [indent, variable] of [['        ', 'pipe'], ['          ', 'next']]) {
    const creation = `${indent}var ${variable} = Instance(endpoint, ++ordinal, sid); Track(${variable});`
    const before = events ? `${indent}DiagnosticEvent("create-start", null, ordinal + 1);\n` : ''
    const after = events ? `\n${indent}DiagnosticEvent("created", ${variable}, ordinal);` : ''
    code = replaceOnce(code, '\n' + creation, `\n${before}${indent}diagnosticStage = 1; diagnosticOrdinal = ordinal + 1;\n${creation}\n${indent}diagnosticOrdinal = ordinal;${after}`)
  }
  code = replaceOnce(code, '          await slots.WaitAsync(stop.Token);', '          diagnosticStage = 2;\n          await slots.WaitAsync(stop.Token);')
  code = replaceOnce(code, '          try { await pipe.WaitForConnectionAsync(stop.Token); }', '          diagnosticStage = 3;\n          try { await pipe.WaitForConnectionAsync(stop.Token); }')
  code = replaceOnce(code, '          var task = Relay(pipe, port, stop.Token);', '          diagnosticStage = 4;\n          var task = Relay(pipe, port, stop.Token);')
  code = replaceOnce(code, '    catch { Emit("{\\"kind\\":\\"failed\\"}"); Environment.ExitCode = 1; }', '    catch (Exception error) { Emit("DIAG exception="+error.GetType().Name+" hresult="+error.HResult+" stage="+diagnosticStage+" ordinal="+diagnosticOrdinal); Emit("{\\"kind\\":\\"failed\\"}"); Environment.ExitCode = 1; }')
  code = replaceOnce(code, 'using (var slots = new SemaphoreSlim(15, 15)) {', 'using (var slots = new SemaphoreSlim(15, 15))\n    using (var monitor = new System.Threading.Timer(_ => Snapshot(), null, 5000, 5000)) {')
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
  if (events) {
    code = replaceOnce(code, '  static void Snapshot()', eventsSource + '\n  static void Snapshot()')
    code = replaceOnce(code, '      var handle = CreateNamedPipeW', '      DiagnosticEvent("native-create-start", null, ordinal);\n      var handle = CreateNamedPipeW')
    code = replaceOnce(code, '      NamedPipeServerStream pipe = null;', '      DiagnosticEvent("native-created", null, ordinal);\n      NamedPipeServerStream pipe = null;')
    code = replaceOnce(code, 'try { await pipe.WaitForConnectionAsync(stop.Token); }', 'try { await pipe.WaitForConnectionAsync(stop.Token); DiagnosticEvent("accepted", pipe, ordinal); }')
    code = replaceOnce(code, 'value.Dispose(); }', 'value.Dispose(); DiagnosticDisposed(value); }')
    if (mode === 'baseline') code = replaceOnce(code, 'pipe.Dispose(); tcp.Close();', 'pipe.Dispose(); DiagnosticDisposed(pipe); tcp.Close();')
    code = replaceOnce(code, '      } finally {\n        stop.Cancel();', '      } finally {\n        DiagnosticDump();\n        stop.Cancel();')
  }
  return code
}

export function assertOutsideApp(root, parent) {
  const actualRoot = realpathSync(root), actualParent = realpathSync(parent)
  const pathInside = relative(actualRoot.toLowerCase(), actualParent.toLowerCase())
  assert(pathInside === '..' || pathInside.startsWith('..' + sep) || isAbsolute(pathInside), 'OUTPUT_INSIDE_APP')
}

export function instrumentRelayBundle(original) {
  assert(!original.includes('WINDOWS_PIPE_SOURCE') && !original.includes('String.raw'), 'LEGACY_BUNDLE_UNSUPPORTED')
  assert(!original.includes('line.startsWith("DIAG ")'), 'ALREADY_DIAGNOSTIC')
  let code = replaceOnce(original, '  const fail = () => {', '  const fail = () => {\n    process.stderr.write("DIAG wrapperFail ordinal=" + ordinal + " ready=" + Number(ready) + " expected=" + Number(expected) + "\\n");')
  code = replaceOnce(code, '  child.on("close", onClosed);', '  child.on("close", (code, signal) => {\n    process.stderr.write("DIAG childClose code=" + (Number.isInteger(code) ? code : "null") + " signaled=" + Number(Boolean(signal)) + " ordinal=" + ordinal + " expected=" + Number(expected) + "\\n");\n    onClosed();\n  });')
  code = replaceOnce(code, '      try {\n        const message = JSON.parse(line);', '      if (line.startsWith("DIAG ")) { process.stderr.write(line + "\\n"); continue; }\n      try {\n        const message = JSON.parse(line);')
  return replaceOnce(code, 'return verifyPipeArtifact(directory, { rid: "win-x64" }, signal);', 'return verifyPipeArtifact(directory, { rid: "win-x64", diagnosticOnly: true }, signal);')
}

async function main() {
  assert.equal(process.platform, 'win32', 'WINDOWS_ONLY')
  assert(process.argv.length === 4 || (process.argv.length === 5 && process.argv[4] === '--events'), 'USAGE: appRoot existingOutputParent [--events]')
  const events = process.argv[4] === '--events'
  const root = resolve(process.argv[2]), parent = resolve(process.argv[3])
  assertOutsideApp(root, parent)
  const location = artifactLocationForRoot(root)
  const artifact = location.kind === 'packaged' ? join(location.resourcesPath, 'assets-pipe-helper/win-x64') : join(root, '.native/assets-pipe-helper/win-x64')
  const sourceHash = await pipeSourceHash(projectDir)
  await verifyPipeArtifact(artifact, { rid: 'win-x64', sourceHash })
  const original = readFileSync(join(root, 'out/main/assetsWindowsPipe.js'), 'utf8')
  const wrapper = instrumentRelayBundle(original)
  const source = readFileSync(join(projectDir, 'AssetsNativePipe.cs'), 'utf8')
  for (const mode of ['baseline', 'pipe-only', 'connect-only']) {
    const diagnostic = await publishDiagnosticHelper(instrumentPipeSource(source, mode, { events }), { expectedSourceHash: sourceHash, outputParent: parent })
    const output = join(diagnostic.appRoot, 'out/main')
    mkdirSync(output, { recursive: true })
    // Copy only the explicitly imported local chunks, never the entire main tree.
    const copied = new Set()
    function copyDependencies(code) {
      for (const match of code.matchAll(/from ["'](\.\/[\w-]+\.js)["']/g)) {
        const name = match[1].slice(2)
        if (copied.has(name)) continue
        copied.add(name)
        const dependency = readFileSync(join(root, 'out/main', name), 'utf8')
        copyFileSync(join(root, 'out/main', name), join(output, name))
        copyDependencies(dependency)
      }
    }
    copyDependencies(original)
    writeFileSync(join(diagnostic.appRoot, 'package.json'), '{"type":"module"}\n')
    writeFileSync(join(output, 'assetsWindowsPipe.js'), wrapper)
    console.log(JSON.stringify({ diagnosticOnly: true, mode, events, appRoot: diagnostic.appRoot, sourceHash, helperSourceHash: diagnostic.manifest.sourceHash }))
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { await main() } catch (error) { console.error(error.message); process.exitCode = 1 }
}
