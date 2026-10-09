import { createHash } from 'node:crypto'
import { lstat, readFile, readdir, realpath, open } from 'node:fs/promises'
import { isAbsolute, join, relative, resolve } from 'node:path'

const entry = 'Mimir.AssetsPipeHelper.exe'
const hash = bytes => createHash('sha256').update(bytes).digest('hex')
const bad = () => { throw new Error('PIPE_ARTIFACT_INVALID') }
const checkAbort = signal => { signal?.throwIfAborted() }
const same = (a, b) => process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b
const maxBytes = 512 * 1024 * 1024

async function hashFile(path, budget, signal) {
  const handle = await open(path, 'r')
  try {
    const info = await handle.stat()
    if (!info.isFile() || info.size > budget) bad()
    const digest = createHash('sha256'), buffer = Buffer.alloc(65536)
    let size = 0
    while (true) {
      checkAbort(signal)
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, null)
      if (!bytesRead) break
      size += bytesRead
      if (size > budget) bad()
      digest.update(buffer.subarray(0, bytesRead))
    }
    if (size !== info.size) bad()
    return { size, sha256: digest.digest('hex') }
  } finally { await handle.close() }
}

function safePath(name) {
  if (typeof name !== 'string' || !name || name.length > 512 || isAbsolute(name) || /[\\:\x00-\x1f]/.test(name)) bad()
  for (const part of name.split('/')) {
    if (!part || part === '.' || part === '..' || /[. ]$/.test(part) || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part)) bad()
  }
}
async function collect(directory, signal) {
  checkAbort(signal)
  const root = resolve(directory)
  if (!same(await realpath(root), root) || !(await lstat(root)).isDirectory()) bad()
  const files = []
  const names = new Set()
  let bytes = 0
  async function visit(dir) {
    for (const item of await readdir(dir, { withFileTypes: true })) {
      checkAbort(signal)
      const absolute = join(dir, item.name), name = relative(root, absolute).replaceAll('\\', '/')
      if (name === 'manifest.json') continue
      safePath(name)
      if (item.isSymbolicLink() || !same(await realpath(absolute), absolute)) bad()
      if (item.isDirectory()) { await visit(absolute); continue }
      if (!item.isFile() || names.has(name.toLowerCase()) || files.length >= 4096) bad()
      names.add(name.toLowerCase())
      const data = await hashFile(absolute, maxBytes - bytes, signal)
      bytes += data.size
      files.push({ path: name, ...data })
    }
  }
  await visit(root)
  return files.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0)
}
export async function createPipeManifest(directory, metadata) {
  const { protocolVersion, rid, entry: executable, sdkVersion, runtimeVersion, sourceHash } = metadata
  return { protocolVersion, rid, entry: executable, sdkVersion, runtimeVersion, sourceHash,
    ...(metadata.diagnosticOnly === true ? { diagnosticOnly: true } : {}), files: await collect(directory) }
}
export async function verifyPipeArtifact(directory, expected, signal) {
  checkAbort(signal)
  const root = resolve(directory)
  const manifestPath = join(root, 'manifest.json')
  const info = await lstat(manifestPath)
  if (!info.isFile() || info.isSymbolicLink() || info.size > 1_048_576) bad()
  const manifest = JSON.parse(await readFile(manifestPath, { encoding: 'utf8', signal }))
  const keys = expected.diagnosticOnly === true ? 'diagnosticOnly,entry,files,protocolVersion,rid,runtimeVersion,sdkVersion,sourceHash' : 'entry,files,protocolVersion,rid,runtimeVersion,sdkVersion,sourceHash'
  if (!manifest || Object.keys(manifest).sort().join(',') !== keys || (expected.diagnosticOnly === true && manifest.diagnosticOnly !== true)) bad()
  if (manifest.protocolVersion !== 1 || manifest.rid !== 'win-x64' || expected.rid !== manifest.rid || manifest.entry !== entry ||
      !/^10\.\d+\.\d+$/.test(manifest.sdkVersion) || !/^10\.\d+\.\d+$/.test(manifest.runtimeVersion) ||
      !/^[a-f0-9]{64}$/.test(manifest.sourceHash) || (expected.sourceHash && expected.sourceHash !== manifest.sourceHash) ||
      !Array.isArray(manifest.files) || !manifest.files.length || manifest.files.length > 4096) bad()
  const names = new Set()
  for (const file of manifest.files) {
    if (!file || Object.keys(file).sort().join(',') !== 'path,sha256,size') bad()
    safePath(file.path)
    if (file.path.toLowerCase() === 'manifest.json' || names.has(file.path.toLowerCase()) ||
        !Number.isSafeInteger(file.size) || file.size < 0 || !/^[a-f0-9]{64}$/.test(file.sha256)) bad()
    names.add(file.path.toLowerCase())
  }
  const actual = await collect(root, signal)
  const listed = [...manifest.files].sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0)
  if (JSON.stringify(actual) !== JSON.stringify(listed)) bad()
  const executable = join(root, entry)
  const handle = await open(executable, 'r')
  try {
    const pe = Buffer.alloc(64), header = Buffer.alloc(6)
    if ((await handle.read(pe, 0, 64, 0)).bytesRead !== 64 || pe.toString('ascii', 0, 2) !== 'MZ') bad()
    const offset = pe.readUInt32LE(60)
    if ((await handle.read(header, 0, 6, offset)).bytesRead !== 6 || header.toString('ascii', 0, 4) !== 'PE\0\0' || header.readUInt16LE(4) !== 0x8664) bad()
  } finally { await handle.close() }
  checkAbort(signal)
  return { executable, manifest }
}
export async function pipeSourceHash(projectDir) {
  const digest = createHash('sha256')
  for (const name of ['AssetsNativePipe.cs', 'AssetsPipeHelper.csproj', 'Program.cs', 'global.json']) {
    const filename = Buffer.from(name), content = await readFile(join(projectDir, name))
    const lengths = Buffer.alloc(8)
    lengths.writeUInt32LE(filename.length); lengths.writeUInt32LE(content.length, 4)
    digest.update(lengths.subarray(0, 4)).update(filename).update(lengths.subarray(4)).update(content)
  }
  return digest.digest('hex')
}
