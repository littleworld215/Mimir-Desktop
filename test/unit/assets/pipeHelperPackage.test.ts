import { afterEach, expect, it } from 'vitest'
import { mkdtemp, mkdir, rm, writeFile, cp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createPipeManifest, pipeSourceHash } from '../../../scripts/lib/assetsPipeArtifact.mjs'
import { auditPackagedPipeHelper } from '../../../scripts/lib/packageAssetsPipeHelper.mjs'

const roots: string[] = []
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }) })
async function fixture() {
  const projectDir = await mkdtemp(join(tmpdir(), 'mimir-package-pipe-')); roots.push(projectDir)
  const native = join(projectDir, 'native/assets-pipe-helper'), source = join(projectDir, '.native/assets-pipe-helper/win-x64')
  const resourcesDir = join(projectDir, '中文 安装目录/resources'), target = join(resourcesDir, 'assets-pipe-helper/win-x64')
  await mkdir(native, { recursive: true }); await mkdir(source, { recursive: true })
  for (const name of ['AssetsNativePipe.cs', 'Program.cs', 'AssetsPipeHelper.csproj', 'global.json']) await writeFile(join(native, name), name)
  const exe = Buffer.alloc(128); exe.write('MZ'); exe.writeUInt32LE(64, 60); exe.write('PE\0\0', 64); exe.writeUInt16LE(0x8664, 68)
  await writeFile(join(source, 'Mimir.AssetsPipeHelper.exe'), exe)
  await writeFile(join(source, 'LICENSE.txt'), 'runtime license')
  await writeFile(join(source, 'THIRD-PARTY-NOTICES.txt'), 'runtime notices')
  const manifest = await createPipeManifest(source, { protocolVersion: 1, rid: 'win-x64', entry: 'Mimir.AssetsPipeHelper.exe', sdkVersion: '10.0.401', runtimeVersion: '10.0.12', sourceHash: await pipeSourceHash(native) })
  await writeFile(join(source, 'manifest.json'), JSON.stringify(manifest))
  await cp(source, target, { recursive: true })
  return { projectDir, resourcesDir, native, source, target, platform: 'win32', arch: 'x64' }
}
it('packaged helper matches current source and complete files including licenses', async () => {
  await expect(auditPackagedPipeHelper(await fixture())).resolves.toBeDefined()
})
it.each(['missing', 'stale', 'wrong-arch', 'extra-db', 'diagnostic'])('direct builder rejects %s helper', async mode => {
  const f = await fixture()
  if (mode === 'missing') await rm(join(f.target, 'Mimir.AssetsPipeHelper.exe'))
  if (mode === 'stale') await writeFile(join(f.native, 'Program.cs'), 'changed')
  if (mode === 'wrong-arch') f.arch = 'arm64'
  if (mode === 'extra-db') await writeFile(join(f.target, 'app.db'), 'private')
  if (mode === 'diagnostic') {
    const manifest = await createPipeManifest(f.target, { protocolVersion: 1, rid: 'win-x64', entry: 'Mimir.AssetsPipeHelper.exe', sdkVersion: '10.0.401', runtimeVersion: '10.0.12', sourceHash: await pipeSourceHash(f.native), diagnosticOnly: true })
    await writeFile(join(f.target, 'manifest.json'), JSON.stringify(manifest))
  }
  await expect(auditPackagedPipeHelper(f)).rejects.toThrow()
})
it('non-Windows packaging does not require helper or SDK', async () => {
  await expect(auditPackagedPipeHelper({ projectDir: '/missing', resourcesDir: '/missing', platform: 'darwin', arch: 'arm64' })).resolves.toBeUndefined()
})
