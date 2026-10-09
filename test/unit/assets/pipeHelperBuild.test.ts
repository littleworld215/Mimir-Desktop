import { afterEach, expect, it } from 'vitest'
import { mkdtemp, mkdir, access, rm, writeFile, symlink, readFile, unlink, cp } from 'node:fs/promises'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { publishPipeHelper } from '../../../scripts/prepareAssetsPipeHelper.mjs'

const roots: string[] = []
it('CLI missing SDK invalidates previous output before failing', async () => {
  const root = await mkdtemp(join(tmpdir(), 'mimir-cli-publish-')); roots.push(root)
  await cp('scripts', join(root, 'scripts'), { recursive: true })
  await mkdir(join(root, 'native/assets-pipe-helper'), { recursive: true })
  await writeFile(join(root, 'native/assets-pipe-helper/global.json'), JSON.stringify({ sdk: { version: '10.0.401', rollForward: 'disable', allowPrerelease: false } }))
  const output = join(root, '.native/assets-pipe-helper/win-x64')
  await mkdir(output, { recursive: true }); await writeFile(join(output, 'manifest.json'), '{}')
  await expect(promisify(execFile)(process.execPath, [join(root, 'scripts/prepareAssetsPipeHelper.mjs')], { env: { ...process.env, LOCALAPPDATA: join(root, 'empty-cache') } })).rejects.toThrow()
  await expect(access(join(output, 'manifest.json'))).rejects.toThrow()
})
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }) })
it('publish failure never marks old output valid', async () => {
  const root = await mkdtemp(join(tmpdir(), 'mimir-publish-')); roots.push(root)
  const projectDir = join(root, 'project'), outputDir = join(root, 'output')
  await mkdir(projectDir); await mkdir(outputDir)
  await writeFile(join(outputDir, 'manifest.json'), '{}')
  await expect(publishPipeHelper({ projectDir, outputDir, sdkExecutable: join(root, 'missing-sdk.exe') })).rejects.toThrow()
  await expect(access(join(outputDir, 'manifest.json'))).rejects.toThrow()
})
it('publisher rejects a runtime that is not the pinned SDK before publishing', async () => {
  const root = await mkdtemp(join(tmpdir(), 'mimir-sdk-version-')); roots.push(root)
  const projectDir = join(root, 'project'), outputDir = join(root, 'output')
  await mkdir(projectDir); await mkdir(outputDir)
  await writeFile(join(projectDir, 'global.json'), JSON.stringify({ sdk: { version: '10.0.401', rollForward: 'disable', allowPrerelease: false } }))
  await writeFile(join(outputDir, 'manifest.json'), '{}')
  await expect(publishPipeHelper({ projectDir, outputDir, sdkExecutable: process.execPath })).rejects.toThrow('PIPE_HELPER_SDK_MISMATCH')
  await expect(access(join(outputDir, 'manifest.json'))).rejects.toThrow()
})
it.runIf(process.platform === 'win32')('publish refuses an output junction without removing outside manifest', async () => {
  const root = await mkdtemp(join(tmpdir(), 'mimir-publish-')); roots.push(root)
  const outside = join(root, 'outside'), outputDir = join(root, 'alias')
  await mkdir(outside); await writeFile(join(outside, 'manifest.json'), 'preserve')
  await symlink(outside, outputDir, 'junction')
  try {
    await expect(publishPipeHelper({ projectDir: join(root, 'missing-project'), outputDir, sdkExecutable: 'missing.exe' })).rejects.toThrow()
    expect(await readFile(join(outside, 'manifest.json'), 'utf8')).toBe('preserve')
  } finally { await unlink(outputDir) }
})
