/** Explicit, paired real-file benchmark. Never collected by the default suite. */
import Database from 'better-sqlite3'
import { createHash } from 'node:crypto'
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statfsSync, writeFileSync } from 'node:fs'
import { cpus, freemem, tmpdir, totalmem } from 'node:os'
import { basename, dirname, isAbsolute, join, resolve } from 'node:path'
import { afterAll, expect, it } from 'vitest'
import { inspectFileHealthBatch } from '../../electron/assets/fileHealth'
import { AssetsStoreManager } from '../../electron/assets/store'
import type { AssetsContext } from '../../electron/assets/types'
import type { FileHealthCursor } from '../../shared/assetsFileHealthContracts'

type Check = typeof inspectFileHealthBatch
const measurements: unknown[] = []
const baselineFile = process.env.MIMIR_HEALTH_SERIAL_BASELINE ?? ''
const reportFile = process.env.MIMIR_HEALTH_BENCH_REPORT ?? ''
const startedAt = new Date().toISOString()
const freeAtStart = freemem()
const statistics = (values: number[]) => {
  const sorted = [...values].sort((a, b) => a - b)
  return { min: sorted[0], median: sorted[Math.floor(sorted.length / 2)], max: sorted[sorted.length - 1] }
}
async function baseline(): Promise<Check> {
  if (!isAbsolute(baselineFile) || !existsSync(baselineFile)) throw Error('EXPLICIT_SERIAL_SNAPSHOT_REQUIRED')
  const loaded = await import(baselineFile)
  expect(loaded.inspectFileHealthBatch).toBeTypeOf('function')
  return loaded.inspectFileHealthBatch
}
async function scan(ctx: AssetsContext, check: Check) {
  let cursor: FileHealthCursor | undefined, count = 0
  const hash = createHash('sha256'), start = performance.now()
  do {
    const batch = await check(ctx, cursor ? { cursor } : {})
    expect(batch.digestBaseline).toBe('not-established')
    expect(batch.items.length).toBeLessThanOrEqual(50)
    expect(batch.items.every(item => item.status === 'openable')).toBe(true)
    hash.update(JSON.stringify({ items: batch.items, nextCursor: batch.nextCursor }))
    count += batch.items.length; cursor = batch.nextCursor ?? undefined
  } while (cursor)
  return { ms: performance.now() - start, count, resultSha256: hash.digest('hex') }
}

for (const assets of [100, 1000, 5000]) it(`文件健康同数据${assets}资产两版：交替执行、各一预热五有效样本`, async () => {
  const disk = statfsSync(tmpdir())
  if (disk.bavail * disk.bsize < 2 * 1024 ** 3) throw Error('DISK_BUDGET_UNDER_2GIB')
  const serial = await baseline(), root = mkdtempSync(join(tmpdir(), 'mimir-health-paired-'))
  const space = join(root, 'space'), data = Buffer.alloc(4096, 120), files: string[] = []
  let db!: Database.Database
  mkdirSync(space)
  const manager = new AssetsStoreManager({ active: () => ({ id: 'health-paired', path: space }), epoch: () => 'paired#1' },
    (file, options) => (db = new Database(file, options)))
  try {
    const ctx = await manager.getForRequest(manager.context()), date = '2026-10-31T00:00:00.000Z'
    const insert = db.prepare("INSERT INTO asset(code,name,category,storage_type,created_at,updated_at) VALUES(?,?,'inbox','file',?,?)")
    const version = db.prepare('INSERT INTO asset_version(asset_id,version,file_path,created_at) VALUES(?,?,?,?)')
    const current = db.prepare('UPDATE asset SET current_version_id=? WHERE id=?')
    db.transaction(() => {
      for (let i = 0; i < assets; i++) {
        const id = Number(insert.run(`paired-${i}`, `合成文件${i}`, date, date).lastInsertRowid)
        mkdirSync(join(ctx.layout.filesDir, String(id)))
        for (const n of [1, 2]) {
          const relative = `files/${id}/v${n}.bin`
          writeFileSync(join(ctx.layout.root, relative), data); files.push(relative)
          const v = version.run(id, n, relative, date)
          if (n === 2) current.run(v.lastInsertRowid, id)
        }
      }
    })()
    const fingerprint = () => {
      const hash = createHash('sha256')
      hash.update(JSON.stringify(db.prepare('SELECT * FROM asset ORDER BY id').all()))
      hash.update(JSON.stringify(db.prepare('SELECT * FROM asset_version ORDER BY id').all()))
      for (const file of files) { hash.update(file); hash.update(readFileSync(join(ctx.layout.root, file))) }
      return hash.digest('hex')
    }
    const fixtureSha256 = fingerprint(), serialMs: number[] = [], concurrentMs: number[] = [], order: string[] = []
    let resultSha256 = ''
    for (let round = 0; round < 6; round++) {
      const pair: [string, Check, number[]][] = round % 2
        ? [['concurrent', inspectFileHealthBatch, concurrentMs], ['serial', serial, serialMs]]
        : [['serial', serial, serialMs], ['concurrent', inspectFileHealthBatch, concurrentMs]]
      for (const [name, check, samples] of pair) {
        const result = await scan(ctx, check)
        expect(result.count).toBe(assets * 2)
        if (resultSha256) expect(result.resultSha256).toBe(resultSha256)
        resultSha256 = result.resultSha256
        if (round) samples.push(result.ms)
        order.push(`${round}:${name}`)
        console.log('FILE_HEALTH_PAIRED', JSON.stringify({ assets, round, name, ...result }))
      }
    }
    expect(fingerprint()).toBe(fixtureSha256)
    measurements.push({ assets, versions: assets * 2, bytesPerFile: data.length, fixtureSha256, resultSha256, warmupsPerMode: 1,
      samplesPerMode: 5, order, serialMs, concurrentMs, serial: statistics(serialMs), concurrent: statistics(concurrentMs),
      sqlite: db.prepare('SELECT sqlite_version() version').get(), sourceDataUnchanged: true })
  } finally {
    await manager.close()
    if (dirname(resolve(root)) !== resolve(tmpdir()) || !basename(root).startsWith('mimir-health-paired-') ||
        lstatSync(root).isSymbolicLink() || resolve(realpathSync(root)) !== resolve(root)) throw Error('UNSAFE_BENCHMARK_CLEANUP')
    rmSync(root, { recursive: true, force: true })
  }
})

afterAll(() => {
  // A focused diagnostic run must not publish a partial three-size report.
  if (measurements.length !== 3) return
  if (!isAbsolute(reportFile)) throw Error('EXPLICIT_NEW_REPORT_REQUIRED')
  writeFileSync(reportFile, JSON.stringify({ schemaVersion: 1, startedAt, completedAt: new Date().toISOString(), node: process.version,
    platform: process.platform, cpu: cpus()[0]?.model, totalMemory: totalmem(), freeAtStart, freeAtEnd: freemem(),
    peakRssBytes: process.resourceUsage().maxRSS * 1024, rssScope: 'process cumulative high-water; not per-operation delta',
    baselineSourceSha256: createHash('sha256').update(readFileSync(baselineFile)).digest('hex'),
    scope: 'explicit synthetic files; paired modes on identical fixtures; no real research, content reads in product or model',
    measurements }, null, 2) + '\n', { flag: 'wx' })
})
