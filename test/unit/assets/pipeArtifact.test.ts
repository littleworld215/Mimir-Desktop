import { afterEach, expect, it } from 'vitest'
import { mkdtemp, mkdir, readFile, rm, writeFile, cp, symlink, unlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { createPipeManifest, verifyPipeArtifact } from '../../../scripts/lib/assetsPipeArtifact.mjs'
import { resolveWindowsPipeArtifact } from '../../../electron/assets/mcp/windowsPipeArtifact'

const roots: string[] = []
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }) })
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'mimir-artifact-'))
  roots.push(root)
  const directory = join(root, '中文 有空格')
  await mkdir(directory)
  const exe = Buffer.alloc(128)
  exe.write('MZ'); exe.writeUInt32LE(64, 60); exe.write('PE\0\0', 64); exe.writeUInt16LE(0x8664, 68)
  await writeFile(join(directory, 'Mimir.AssetsPipeHelper.exe'), exe)
  await writeFile(join(directory, 'coreclr.dll'), 'runtime')
  const manifest = await createPipeManifest(directory, {
    protocolVersion: 1, rid: 'win-x64', entry: 'Mimir.AssetsPipeHelper.exe',
    sdkVersion: '10.0.401', runtimeVersion: '10.0.12', sourceHash: 'a'.repeat(64)
  })
  await writeFile(join(directory, 'manifest.json'), JSON.stringify(manifest))
  return { directory, manifest }
}
it('manifest accepts complete artifact in Chinese and spaced directory', async () => {
  const { directory, manifest } = await fixture()
  const result = await verifyPipeArtifact(directory, { rid: 'win-x64', sourceHash: manifest.sourceHash })
  expect(result.executable).toBe(join(directory, manifest.entry))
  expect(result.manifest.files).toHaveLength(2)
})
it('artifact location selects fixed development and packaged paths', async () => {
  const { directory } = await fixture()
  const appRoot = join(dirname(directory), 'application'), resourcesPath = join(dirname(directory), 'resources')
  await cp(directory, join(appRoot, '.native/assets-pipe-helper/win-x64'), { recursive: true })
  await cp(directory, join(resourcesPath, 'assets-pipe-helper/win-x64'), { recursive: true })
  expect((await resolveWindowsPipeArtifact({ kind: 'development', appRoot })).executable).toBe(join(appRoot, '.native/assets-pipe-helper/win-x64/Mimir.AssetsPipeHelper.exe'))
  expect((await resolveWindowsPipeArtifact({ kind: 'packaged', resourcesPath })).executable).toBe(join(resourcesPath, 'assets-pipe-helper/win-x64/Mimir.AssetsPipeHelper.exe'))
  await expect(resolveWindowsPipeArtifact({ kind: 'development', appRoot: join(appRoot, 'missing') })).rejects.toThrow()
})
it.runIf(process.platform === 'win32')('artifact directory junction cannot redirect verification outside the selected root', async () => {
  const { directory } = await fixture()
  const alias = join(dirname(directory), 'alias')
  await symlink(directory, alias, 'junction')
  try { await expect(verifyPipeArtifact(alias, { rid: 'win-x64' })).rejects.toThrow() } finally { await unlink(alias) }
})
it.each(['escape', 'collision', 'missing', 'extra', 'tamper', 'rid', 'source', 'architecture'])('manifest rejects %s', async mode => {
  const { directory, manifest } = await fixture()
  if (mode === 'escape') manifest.files[0].path = '../outside.dll'
  if (mode === 'collision') manifest.files.push({ ...manifest.files[0], path: manifest.files[0].path.toUpperCase() })
  if (mode === 'missing') await rm(join(directory, 'coreclr.dll'))
  if (mode === 'extra') await writeFile(join(directory, 'private.db'), 'secret')
  if (mode === 'tamper') await writeFile(join(directory, 'coreclr.dll'), 'changed')
  if (mode === 'rid') (manifest as { rid: string }).rid = 'win-arm64'
  if (mode === 'source') manifest.sourceHash = 'b'.repeat(64)
  if (mode === 'architecture') {
    const exe = await readFile(join(directory, manifest.entry)); exe.writeUInt16LE(0xaa64, 68)
    await writeFile(join(directory, manifest.entry), exe)
    const replacement = await createPipeManifest(directory, { ...manifest, files: undefined } as never)
    manifest.files = replacement.files
  }
  await writeFile(join(directory, 'manifest.json'), JSON.stringify(manifest))
  await expect(verifyPipeArtifact(directory, { rid: 'win-x64', sourceHash: 'a'.repeat(64) })).rejects.toThrow()
})
it('cancelled verification does not return an executable', async () => {
  const { directory } = await fixture()
  const abort = new AbortController(); abort.abort()
  await expect(verifyPipeArtifact(directory, { rid: 'win-x64' }, abort.signal)).rejects.toThrow()
})
