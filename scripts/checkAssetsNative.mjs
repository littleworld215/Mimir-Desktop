#!/usr/bin/env node
/**
 * 资产库原生依赖验证（I0-02 / 断言 A01）。
 *
 * 用法：
 *   node scripts/checkAssetsNative.mjs                  # 用 Node ABI 默认绑定
 *   electron scripts/checkAssetsNative.mjs              # 用 Electron ABI（默认绑定）
 *   node scripts/checkAssetsNative.mjs --binding <path> # 显式指定 .node 绑定
 *
 * 断言（真实临时库，不使用 mock）：
 *   1. sqlite_version() 可读
 *   2. 外键约束生效（插入孤儿行应失败）
 *   3. 事务回滚生效（抛错后无残留）
 *   4. 关闭后重开，数据仍在
 *   5. PRAGMA integrity_check = 'ok'
 *   6. FTS5 可用（供 I2）
 *   7. trigram 分词可用（供 I2）
 *
 * 退出码 0 表示全部通过；非 0 表示失败（打印失败项）。
 * 不写仓库目录：临时库放在 os.tmpdir()。
 */
import Database from 'better-sqlite3'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

function argValue(flag) {
  const i = process.argv.indexOf(flag)
  return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1] : undefined
}

const binding = argValue('--binding')
const runtime = typeof process.versions.electron === 'string' ? `electron-${process.versions.electron}` : `node-${process.versions.node}`

const results = []
function record(name, ok, detail) {
  results.push({ name, ok: Boolean(ok), detail: detail === undefined ? '' : String(detail) })
}

const dir = mkdtempSync(join(tmpdir(), 'mimir-assets-native-'))
const dbPath = join(dir, 'probe.db')

const openOptions = { fileMustExist: false, ...(binding ? { nativeBinding: binding } : {}) }

let db
try {
  db = new Database(dbPath, openOptions)
  db.pragma('foreign_keys = ON')
  db.pragma('busy_timeout = 5000')

  // 1. sqlite_version
  const ver = db.prepare('SELECT sqlite_version() AS v').get().v
  record('sqlite_version 可读', typeof ver === 'string' && ver.length > 0, ver)

  // 2. 外键生效
  db.exec('CREATE TABLE parent (id INTEGER PRIMARY KEY)')
  db.exec('CREATE TABLE child (id INTEGER PRIMARY KEY, pid INTEGER NOT NULL REFERENCES parent(id))')
  let fkRejected = false
  try {
    db.prepare('INSERT INTO child (id, pid) VALUES (1, 999)').run()
  } catch {
    fkRejected = true
  }
  record('外键约束生效（孤儿行被拒）', fkRejected, fkRejected ? '' : '孤儿行竟然插入成功')

  // 3. 事务回滚
  db.prepare('INSERT INTO parent (id) VALUES (1)').run()
  let rolledBack = false
  try {
    db.transaction(() => {
      db.prepare('INSERT INTO parent (id) VALUES (2)').run()
      throw new Error('force-rollback')
    })()
  } catch {
    rolledBack = true
  }
  const parentCount = db.prepare('SELECT COUNT(*) AS c FROM parent').get().c
  record('事务回滚生效（无残留）', rolledBack && parentCount === 1, `count=${parentCount}`)

  // 4. 关闭后重开
  db.close()
  db = new Database(dbPath, openOptions)
  const reopened = db.prepare('SELECT COUNT(*) AS c FROM parent').get().c
  record('关闭后重开数据仍在', reopened === 1, `count=${reopened}`)

  // 5. integrity_check
  const integrity = db.pragma('integrity_check', { simple: true })
  record('integrity_check = ok', integrity === 'ok', integrity)

  // 6. FTS5
  let fts5Ok = false
  let fts5Detail = ''
  try {
    db.exec("CREATE VIRTUAL TABLE fts_probe USING fts5(body)")
    db.prepare('INSERT INTO fts_probe (body) VALUES (?)').run('科研资产 reusable research asset')
    const hit = db.prepare("SELECT COUNT(*) AS c FROM fts_probe WHERE fts_probe MATCH 'research'").get().c
    fts5Ok = hit === 1
    fts5Detail = `hit=${hit}`
  } catch (e) {
    fts5Detail = e instanceof Error ? e.message : String(e)
  }
  record('FTS5 可用', fts5Ok, fts5Detail)

  // 7. trigram 分词（供中文检索）
  let trigramOk = false
  let trigramDetail = ''
  try {
    db.exec("CREATE VIRTUAL TABLE tri_probe USING fts5(body, tokenize='trigram')")
    db.prepare('INSERT INTO tri_probe (body) VALUES (?)').run('科研资产库检索')
    const hit = db.prepare("SELECT COUNT(*) AS c FROM tri_probe WHERE tri_probe MATCH '资产库'").get().c
    trigramOk = hit === 1
    trigramDetail = `hit=${hit}`
  } catch (e) {
    trigramDetail = e instanceof Error ? e.message : String(e)
  }
  record('trigram 分词可用', trigramOk, trigramDetail)
} catch (e) {
  record('打开临时库', false, e instanceof Error ? e.message : String(e))
} finally {
  try {
    if (db && db.open) db.close()
  } catch {
    /* ignore */
  }
  try {
    rmSync(dir, { recursive: true, force: true })
  } catch {
    /* ignore */
  }
}

const passed = results.filter((r) => r.ok).length
const failed = results.length - passed
console.log(`[assets-native] runtime=${runtime} binding=${binding ?? '(default)'}`)
for (const r of results) {
  console.log(`  ${r.ok ? 'PASS' : 'FAIL'}  ${r.name}${r.detail ? `  — ${r.detail}` : ''}`)
}
console.log(`[assets-native] ${passed}/${results.length} 通过，${failed} 失败`)
process.exit(failed === 0 ? 0 : 1)
