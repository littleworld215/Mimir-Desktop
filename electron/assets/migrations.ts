import type Database from 'better-sqlite3'
import { closeSync, openSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { ASSETS_DDL, ASSETS_V1_DDL, ASSETS_V2_DDL, ASSETS_V3_DDL, ASSETS_I2_DDL, ASSETS_I4_DDL, ASSETS_I5_DDL, ASSETS_SCHEMA_VERSION, BUILTIN_CATEGORIES } from './schema'
import { AssetsStoreError } from './types'
import type { Clock, DatabaseFactory } from './types'

function schemaObjects(db: Database.Database): Array<{ name: string; type: string; sql: string }> {
  return db.prepare("SELECT name, type, sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY name").all() as Array<{ name: string; type: string; sql: string }>
}

/** 检查完整 DDL（列、约束、索引、trigger），不修补结构漂移。 */
export function validateSchema(db: Database.Database, factory: DatabaseFactory, version = ASSETS_SCHEMA_VERSION): void {
  const reference = factory(':memory:', {})
  try {
    for (const ddl of version === 1 ? ASSETS_V1_DDL : version === 2 ? ASSETS_V2_DDL : version === 3 ? ASSETS_V3_DDL : ASSETS_DDL) reference.exec(ddl)
    const normalize = (sql: string): string => sql.replace(/\s+/g, ' ').trim().toLowerCase()
    const expected = schemaObjects(reference)
    const actual = schemaObjects(db)
    if (actual.length !== expected.length || actual.some((row, i) =>
      row.name !== expected[i].name || row.type !== expected[i].type || normalize(row.sql) !== normalize(expected[i].sql)
    )) throw new AssetsStoreError('STORE_CORRUPT', '资产库结构不完整或已漂移；已拒绝写入，请保留原库。')
    if ((db.pragma('foreign_key_check') as unknown[]).length !== 0) {
      throw new AssetsStoreError('STORE_CORRUPT', '资产库外键检查失败；已拒绝写入。')
    }
  } finally {
    reference.close()
  }
}

/** 只读预检：较新版本及损坏库不进入 writable open。 */
export function inspectStore(db: Database.Database, factory: DatabaseFactory): number {
  const version = db.pragma('user_version', { simple: true }) as number
  if (version > ASSETS_SCHEMA_VERSION || version < 0) {
    throw new AssetsStoreError('SCHEMA_UNSUPPORTED', '资产库版本不受当前应用支持，请使用匹配版本。')
  }
  if (db.pragma('integrity_check', { simple: true }) !== 'ok') {
    throw new AssetsStoreError('STORE_CORRUPT', '资产库完整性检查失败，请保留原文件。')
  }
  if (version >= 1 && version <= ASSETS_SCHEMA_VERSION) validateSchema(db, factory, version)
  else if (schemaObjects(db).length !== 0) {
    // 0→1 只支持空库；没有定义过的旧业务结构不得猜测迁移。
    throw new AssetsStoreError('STORE_CORRUPT', '版本 0 资产库含未知结构，不能自动迁移。')
  }
  return version
}

/** SQLite 一致快照：独占预留新名字，任何失败发生在修改 schema 之前。 */
export async function snapshotBeforeMigration(db: Database.Database, backupsDir: string, clock: Clock, uniqueId: () => string = randomUUID): Promise<string> {
  const version = db.pragma('user_version', { simple: true }) as number
  const destination = join(backupsDir, `schema-${version}-${clock().getTime()}-${uniqueId()}.db`)
  let reserved = false
  try {
    const fd = openSync(destination, 'wx', 0o600)
    closeSync(fd)
    reserved = true
    await db.backup(destination)
    return destination
  } catch (error) {
    if (reserved) {
      try { unlinkSync(destination) } catch { /* 仅清理本操作创建的不完整快照。 */ }
    }
    throw new AssetsStoreError('WRITE_FAILED', `迁移前备份失败，原库未迁移：${error instanceof Error ? error.message : '文件系统错误'}`)
  }
}

/** Atomic fresh creation or known v1 upgrade; seed only the brand-new schema. */
export function initializeSchema(db: Database.Database, clock: Clock): void {
  const version = db.pragma('user_version', { simple: true }) as number
  if (version === ASSETS_SCHEMA_VERSION) return
  if (version !== 0 && version !== 1 && version !== 2 && version !== 3) throw new AssetsStoreError('SCHEMA_UNSUPPORTED', '不能迁移未知资产结构。')
  db.transaction(() => {
    const upgrade = version === 0 ? ASSETS_DDL : [
      ...(version < 2 ? ASSETS_I2_DDL : []),
      ...(version < 3 ? ASSETS_I4_DDL : []),
      ...ASSETS_I5_DDL
    ]
    for (const ddl of upgrade) db.exec(ddl)
    if (version === 0) {
      const insert = db.prepare(`INSERT INTO asset_category
        (code,name,icon,default_storage_type,parent_code,sort_order,builtin,created_at)
        VALUES (@code,@name,@icon,@defaultStorageType,@parentCode,@sortOrder,1,@createdAt)`)
      const createdAt = clock().toISOString()
      for (const category of BUILTIN_CATEGORIES) insert.run({ ...category, createdAt })
    }
    if (version < 2) db.exec(`INSERT INTO asset_fts(rowid,name,description,notes,source_task,content)
      SELECT a.id,a.name,a.description,a.notes,a.source_task,coalesce(v.content,'')
      FROM asset a LEFT JOIN asset_version v ON v.id=a.current_version_id AND v.asset_id=a.id`)
    db.pragma(`user_version = ${ASSETS_SCHEMA_VERSION}`)
  })()
}
