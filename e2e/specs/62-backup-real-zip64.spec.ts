import type { WorkspaceBackupMaintenanceApi } from '../../shared/workspaceBackupContracts'
import { expect, test } from '@playwright/test'
import { createHash } from 'node:crypto'
import { createReadStream, existsSync, ftruncateSync, mkdirSync, openSync, closeSync, statfsSync, statSync, writeSync } from 'node:fs'
import { dirname, join } from 'node:path'
import yauzl from 'yauzl'
import { createBackup } from '../../electron/workspaceBackup/packer'
import { verifyBackup } from '../../electron/workspaceBackup/verify'
import { DEFAULT_MANIFEST_LIMITS } from '../../electron/workspaceBackup/manifest'
import { launchApp } from '../fixtures/launch'
import { attachBackupEvidence } from '../fixtures/backupEvidence'

async function hashFile(path: string) {
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(path)) hash.update(chunk)
  return hash.digest('hex')
}
async function zip64Entry(path: string, name: string) {
  return new Promise<{ size: number; version: number; zip64: boolean }>((resolve, reject) => {
    yauzl.open(path, { lazyEntries: true }, (error, zip) => {
      if (error || !zip) { reject(error); return }
      let result: { size: number; version: number; zip64: boolean } | undefined
      zip.on('error', reject)
      zip.on('entry', entry => {
        if (entry.fileName === name) result = { size: entry.uncompressedSize, version: entry.versionNeededToExtract, zip64: entry.extraFields.some((field: { id: number }) => field.id === 1) }
        zip.readEntry()
      })
      zip.on('end', () => result ? resolve(result) : reject(Error('Missing real large entry')))
      zip.readEntry()
    })
  })
}

/** 实际>4GiB来源及恢复文件。默认1GiB排除策略和显式底层大包读取分别验收。 */
test('G08实际ZIP64：默认超限明确排除，显式归档及Electron恢复逐字节校验', async () => {
  test.setTimeout(600_000)
  test.skip(process.platform !== 'win32' || process.arch !== 'x64', 'G08首版实际系统验收限Windows x64')
  const size = 4 * 1024 ** 3 + 65536
  let source = ''
  const ctx = await launchApp({
    executablePath: process.env.MIMIR_E2E_PACKAGED,
    maintenanceRestoreSuggestions: true, maintenanceRestoreScope: true,
    extraArgs: ['--workspace-maintenance'],
    transformSeed: seed => { source = seed.workspaces[0]!.path; return seed }
  })
  let peakRunnerRss = process.memoryUsage().rss
  const sampler = setInterval(() => { peakRunnerRss = Math.max(peakRunnerRss, process.memoryUsage().rss) }, 50)
  try {
    const disk = statfsSync(ctx.tempHome.root)
    expect(disk.bavail * disk.bsize, 'Requires at least12GiB free on the isolated test volume').toBeGreaterThan(12 * 1024 ** 3)
    const file = join(source, 'large', '真实ZIP64合成资料.bin')
    mkdirSync(dirname(file), { recursive: true })
    const fd = openSync(file, 'wx')
    const markers = [0, 2 * 1024 ** 3 - 128, 2 * 1024 ** 3 + 128, 4 * 1024 ** 3 - 128, 4 * 1024 ** 3 + 128, size - 128]
    try {
      ftruncateSync(fd, size)
      for (const [index, offset] of markers.entries()) {
        const marker = createHash('sha512').update('G08 deterministic boundary ' + index).digest()
        expect(writeSync(fd, marker, 0, marker.length, offset)).toBe(marker.length)
      }
    } finally { closeSync(fd) }
    expect(statSync(file).size).toBe(size)
    const sourceHash = await hashFile(file)
    console.log('G08 source ready:', size, 'bytes')
    const ordinary = await ctx.page.evaluate(async () => {
      const api = (window as unknown as { workspaceBackupMaintenance: WorkspaceBackupMaintenanceApi }).workspaceBackupMaintenance, overview = await api.overview()
      if (!overview.ok || !api.backupSpace) throw Error('Maintenance unavailable')
      return api.backupSpace({ spaceId: overview.spaces[0]!.id })
    })
    expect(ordinary).toMatchObject({ ok: true, excluded: 1 })
    console.log('G08 default exclusion verified')
    const archivePath = join(ctx.tempHome.home, 'backups', 'g08-real-zip64.zip')
    // 仅测试直接调用允许的大文件参数；产品界面1GiB默认策略保持原契约。
    const archived = await createBackup({
      root: source, destination: archivePath, stagingDir: join(ctx.tempHome.root, 'large-packing'), assetsDb: null,
      limits: { ...DEFAULT_MANIFEST_LIMITS, maxFileBytes: size }
    })
    expect(archived.excluded).toEqual([])
    expect(archived.totalBytes).toBeGreaterThanOrEqual(size)
    const header = await zip64Entry(archivePath, 'large/真实ZIP64合成资料.bin')
    expect(header).toMatchObject({ size, zip64: true })
    expect(header.version).toBeGreaterThanOrEqual(45)
    console.log('G08 actual ZIP64 header verified:', JSON.stringify(header))
    const verified = await verifyBackup(archivePath)
    expect(verified.totalBytes).toBe(archived.totalBytes)
    await attachBackupEvidence(test.info(), 'zip64-before-restore', {
      actualSourceBytes: size, nonzeroMarkerOffsets: markers, sourceHash, header, archiveBytes: archived.archiveBytes, verified
    })
    console.log('G08 independent archive verification complete')
    if (process.env.MIMIR_E2E_PACKAGED) await ctx.app.evaluate((_e, cwd) => process.chdir(cwd), ctx.tempHome.root)
    const targetRoot = join(ctx.tempHome.home, 'Mimir', 'ZIP64恢复空间')
    const restored = await ctx.page.evaluate(request => {
      const api = (window as unknown as { workspaceBackupMaintenance: WorkspaceBackupMaintenanceApi }).workspaceBackupMaintenance
      if (!api.restore) throw Error('Restore unavailable')
      return api.restore(request)
    }, {
      archivePath, targetRoot, spaceName: 'ZIP64恢复空间'
    })
    console.log('G08 Electron restore completed:', JSON.stringify(restored))
    expect(restored, JSON.stringify(restored)).toMatchObject({ ok: true })
    const restoredFile = join(targetRoot, 'large/真实ZIP64合成资料.bin')
    expect(statSync(restoredFile).size).toBe(size)
    expect(await hashFile(restoredFile)).toBe(sourceHash)
    expect(await hashFile(file)).toBe(sourceHash)
    expect(existsSync(join(source, '.mimir/workspace.writer-lock'))).toBe(false)
    await attachBackupEvidence(test.info(), 'actual-zip64-evidence', {
      actualSourceBytes: size, actualRestoredBytes: statSync(restoredFile).size, nonzeroMarkerOffsets: markers, archiveBytes: archived.archiveBytes,
      header, sourceHash, defaultExcluded: ordinary.ok ? ordinary.excluded : null, peakRunnerRss,
      note: 'runnerRSS is sampled only for this Node runner, not an Electron peak or a general benchmark'
    })
  } finally { clearInterval(sampler); await ctx.cleanup() }
})
