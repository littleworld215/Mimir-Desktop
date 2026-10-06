import Database from 'better-sqlite3'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { performance } from 'node:perf_hooks'
import { it, expect } from 'vitest'
import { AssetsStoreManager } from '../../../electron/assets/store'
import type { AssetsContext, AssetsWriteSession } from '../../../electron/assets/types'
import { listAssets } from '../../../electron/assets/assetService'
import { literalLike, literalPhrase } from '../../../electron/assets/searchQuery'

it('5000条×500码点：相同服务/数据/顺序的LIKE对照与FTS查询，保留原始样本', async () => {
  const root = mkdtempSync(join(tmpdir(), 'assets-perf-'))
  const manager = new AssetsStoreManager({ active: () => ({ id: 'A', path: root }), epoch: () => 'A#1' }, (p, o) => new Database(p, o))
  try {
    const ctx = await manager.getForRequest(manager.context())
    ctx.write(s => {
      for (let id = 1; id <= 5000; id++) {
        const token = id % 50 === 0 ? '科研 scientific 🧪😀🔬' : 'ordinary'
        const chars = [...('背景材料 '.repeat(95) + token)]
        const content = chars.slice(0, 500).join('') + '文'.repeat(Math.max(0, 500 - chars.length))
        expect([...content].length).toBe(500)
        s.run('INSERT INTO asset(id,code,name,category,storage_type,description,notes,source_task,created_at,updated_at) VALUES(?,?,?,\'inbox\',\'inline_text\',?,?,?,?,?)', id, `asset-${id}`, `Asset ${id}`, id % 250 === 0 ? token : '', '', '', '2026-10-07T00:00:00.000Z', '2026-10-07T00:00:00.000Z')
        s.run('INSERT INTO asset_version(id,asset_id,version,content,created_at) VALUES(?,?,1,?,?)', id, id, content, '2026-10-07')
        s.run('UPDATE asset SET current_version_id=? WHERE id=?', id, id)
      }
    })
    const baselineSql = `(coalesce(a.name,'') LIKE ? ESCAPE '\\' OR coalesce(a.description,'') LIKE ? ESCAPE '\\' OR coalesce(a.notes,'') LIKE ? ESCAPE '\\' OR coalesce(a.source_task,'') LIKE ? ESCAPE '\\' OR (SELECT content FROM asset_version WHERE id=a.current_version_id AND asset_id=a.id) LIKE ? ESCAPE '\\')`
    const measurements = []
    for (const q of ['科研', 'scientific', '🧪😀🔬', 'absent-token']) {
      // Only replace the candidate predicate; filtering, ranking, page/DTO/excerpt work stays identical.
      const baseline: AssetsContext = { ...ctx, write: operation => ctx.write(s => {
        const transform = (sql: string, args: unknown[]) => ({
          sql: sql.replace('a.id IN (SELECT rowid FROM asset_fts WHERE asset_fts MATCH ?)', baselineSql),
          args: args.flatMap(arg => arg === literalPhrase(q) ? Array(5).fill(literalLike(q)) : [arg])
        })
        const session: AssetsWriteSession = {
          run: (sql, ...args) => s.run(sql, ...args),
          get: (sql, ...args) => { const t = transform(sql, args); return s.get(t.sql, ...t.args) },
          all: (sql, ...args) => { const t = transform(sql, args); return s.all(t.sql, ...t.args) }
        }
        return operation(session)
      }) }
      const query = { q, pageSize: 50 }
      expect(listAssets(ctx, query)).toEqual(listAssets(baseline, query))
      const before: number[] = []
      const after: number[] = []
      for (let warm = 0; warm < 5; warm++) { listAssets(baseline, query); listAssets(ctx, query) }
      for (let sample = 0; sample < 30; sample++) {
        const measure = (context: AssetsContext, values: number[]) => {
          const start = performance.now()
          listAssets(context, query)
          values.push(Number((performance.now() - start).toFixed(3)))
        }
        if (sample % 2) { measure(ctx, after); measure(baseline, before) }
        else { measure(baseline, before); measure(ctx, after) }
      }
      const percentiles = (values: number[]) => {
        const ordered = [...values].sort((a, b) => a - b)
        return { p50: ordered[Math.ceil(ordered.length * .5) - 1], p95: ordered[Math.ceil(ordered.length * .95) - 1] }
      }
      measurements.push({ q, count: listAssets(ctx, query).total, before: percentiles(before), after: percentiles(after), beforeSamplesMs: before, afterSamplesMs: after })
    }
    const report = { node: process.version, sqlite: ctx.write(s => s.get('SELECT sqlite_version() version')), rows: 5000, bodyCodePoints: 500, warmup: 5, samples: 30, pageSize: 50, measurements }
    console.log('SEARCH_PERFORMANCE', JSON.stringify(report))
    if (process.env.MIMIR_SEARCH_REPORT) writeFileSync(process.env.MIMIR_SEARCH_REPORT, JSON.stringify(report, null, 2))
  } finally { await manager.close(); rmSync(root, { recursive: true, force: true }) }
}, 30000)
