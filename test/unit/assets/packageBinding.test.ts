import { afterEach, describe, expect, it } from 'vitest'
import { createRequire } from 'node:module'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { cp } from 'node:fs/promises'
import { createPipeManifest, pipeSourceHash } from '../../../scripts/lib/assetsPipeArtifact.mjs'

const require = createRequire(import.meta.url)
const install = require('../../../scripts/packageAssetsNative.cjs')
const roots: string[] = []
afterEach(() => roots.splice(0).forEach(root => rmSync(root, { recursive: true, force: true })))

function fixture(arch = 1) {
  const root = mkdtempSync(join(tmpdir(), 'mimir-package-'))
  roots.push(root)
  const output = join(root, 'dist', 'resources')
  const source = join(root, '.native', 'electron-33.4.11', 'win32-x64', 'better_sqlite3.node')
  const destination = join(output, 'app.asar.unpacked', 'node_modules', 'better-sqlite3', 'build', 'Release', 'better_sqlite3.node')
  mkdirSync(join(root, '.native', 'electron-33.4.11', 'win32-x64'), { recursive: true })
  mkdirSync(join(output, 'app.asar.unpacked', 'node_modules', 'better-sqlite3', 'build', 'Release'), { recursive: true })
  writeFileSync(destination, 'node ABI')
  return { root, source, destination, context: { arch, electronPlatformName: 'win32', appOutDir: join(root, 'dist'), packager: { projectDir: root, info: { framework: { version: '33.4.11' } }, getResourcesDir: () => output } } }
}

async function prepareHelper(root: string) {
  const native = join(root, 'native/assets-pipe-helper')
  const source = join(root, '.native/assets-pipe-helper/win-x64')
  mkdirSync(native, { recursive: true }); mkdirSync(source, { recursive: true })
  for (const name of ['AssetsNativePipe.cs', 'Program.cs', 'AssetsPipeHelper.csproj', 'global.json']) writeFileSync(join(native, name), name)
  const pe = Buffer.alloc(128); pe.write('MZ'); pe.writeUInt32LE(64, 60); pe.write('PE\0\0', 64); pe.writeUInt16LE(0x8664, 68)
  writeFileSync(join(source, 'Mimir.AssetsPipeHelper.exe'), pe)
  writeFileSync(join(source, 'LICENSE.txt'), 'runtime license')
  writeFileSync(join(source, 'THIRD-PARTY-NOTICES.txt'), 'runtime notices')
  const manifest = await createPipeManifest(source, { protocolVersion: 1, rid: 'win-x64', entry: 'Mimir.AssetsPipeHelper.exe', sdkVersion: '10.0.401', runtimeVersion: '10.0.12', sourceHash: await pipeSourceHash(native) })
  writeFileSync(join(source, 'manifest.json'), JSON.stringify(manifest))
  await cp(source, join(root, 'dist/resources/assets-pipe-helper/win-x64'), { recursive: true })
}

describe('packaged asset native binding', () => {
  it('installs the exact Electron cache into output without changing source Node binding', async () => {
    const f = fixture()
    const nodeBinding = join(f.root, 'node_modules', 'better-sqlite3', 'build', 'Release', 'better_sqlite3.node')
    mkdirSync(join(f.root, 'node_modules', 'better-sqlite3', 'build', 'Release'), { recursive: true })
    writeFileSync(nodeBinding, 'Node test binding')
    writeFileSync(f.source, 'Electron binding')
    await prepareHelper(f.root)
    await install(f.context)
    expect(readFileSync(f.destination, 'utf8')).toBe('Electron binding')
    expect(readFileSync(nodeBinding, 'utf8')).toBe('Node test binding')
  })
  it('missing helper rejects before replacing the packaged SQLite binding', async () => {
    const f = fixture()
    writeFileSync(f.source, 'Electron binding')
    await expect(install(f.context)).rejects.toThrow()
    expect(readFileSync(f.destination, 'utf8')).toBe('node ABI')
  })
  it.each(['missing', 'empty'])('refuses %s cache without replacing the destination', async kind => {
    const f = fixture()
    if (kind === 'empty') writeFileSync(f.source, '')
    await expect(install(f.context)).rejects.toThrow('Electron native binding')
    expect(readFileSync(f.destination, 'utf8')).toBe('node ABI')
  })
  it('never falls back to a different architecture or Electron version', async () => {
    const f = fixture(3)
    writeFileSync(f.source, 'x64 binding')
    await expect(install(f.context)).rejects.toThrow('win32-arm64')
    expect(readFileSync(f.destination, 'utf8')).toBe('node ABI')
    f.context.arch = 1
    f.context.packager.info.framework.version = '34.0.0'
    await expect(install(f.context)).rejects.toThrow('electron-34.0.0')
  })
  it('rejects unsupported universal output rather than installing one architecture', async () => {
    const f = fixture(4)
    await expect(install(f.context)).rejects.toThrow('Unsupported')
  })
})
