/** G-03：只读资产检查与仅恢复暂存副本的迁移；不加载普通业务 store。 */
import Database from 'better-sqlite3'
import { closeSync, fstatSync, lstatSync, mkdirSync, openSync, readSync, type Stats } from 'node:fs'
import { dirname, join } from 'node:path'
import { inspectStore, initializeSchema, snapshotBeforeMigration } from '../assets/migrations'
import { ASSETS_SCHEMA_VERSION } from '../assets/schema'
import { resolveAssetsNativeBinding } from '../assets/nativeBinding'
import { AssetsStoreError, type DatabaseFactory } from '../assets/types'
import { validateArchivePaths } from './archivePaths'
import { RestoreError } from './restoreContracts'
import type { AssetsIntegrityOptions } from './assetsIntegrity'
import { maintenanceCheckpoint, maintenanceSignal, checkMaintenanceCancellation, markMaintenanceCleanupFailure } from './maintenanceTask'

function databaseFactory(options: AssetsIntegrityOptions): DatabaseFactory {
  const nativeBinding = options.nativeBinding ?? resolveAssetsNativeBinding({
    isPackaged: options.isPackaged ?? false, resourcesPath: options.resourcesPath, appRoot: options.appRoot
  }).nativeBinding
  return (path, opts) => new Database(path, { ...opts, nativeBinding })
}

function failure(error: unknown, dbPath: string): RestoreError {
  if (error instanceof RestoreError) return error
  const code = error instanceof AssetsStoreError && error.code === 'SCHEMA_UNSUPPORTED' ? 'VERSION_UNSUPPORTED' : 'INTEGRITY_FAILED'
  return new RestoreError(code, `资产库校验或暂存迁移失败：${dbPath}（${error instanceof Error ? error.message : '未知错误'}）`)
}

/** 不跟随任何被校验组件的链接；根本身也必须是普通目录。 */
function assertPath(root: string, parts: readonly string[], file: boolean): Stats {
  let path = root
  const rootStat = lstatSync(root)
  if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) throw Error('UNSAFE_ASSETS_ROOT')
  let stat = rootStat
  for (let index = 0; index < parts.length; index++) {
    path = join(path, parts[index])
    stat = lstatSync(path)
    if (stat.isSymbolicLink() || (index === parts.length - 1 && file ? !stat.isFile() : !stat.isDirectory())) {
      throw Error('UNSAFE_ASSETS_PATH')
    }
  }
  return stat
}

/** 模块可不存在；已有组件非法、悬垂或空间根本身缺失不能伪装成空空间。 */
function optionalDatabase(spaceRoot: string): Stats | undefined {
  assertPath(spaceRoot, [], false)
  const parts = ['.mimir', 'assets', 'assets.db']
  let stat: Stats | undefined
  for (let length = 1; length <= parts.length; length++) {
    try { stat = assertPath(spaceRoot, parts.slice(0, length), length === parts.length) }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
      throw error
    }
  }
  return stat
}

/** 数据库无附件摘要字段；这里验证实际可读性/归属，内容摘要由归档逐项核对。 */
function* inspectHistoricalFiles(db: Database.Database, assetsRoot: string): Generator<void> {
  const verified = new Set<string>()
  const buffer = Buffer.allocUnsafe(64 * 1024)
  const versions = db.prepare('SELECT id,asset_id,file_path FROM asset_version WHERE file_path IS NOT NULL').iterate()
  for (const row of versions as Iterable<{ id: number; asset_id: number; file_path: string }>) {
    yield
    if (!Number.isSafeInteger(row.asset_id) || row.asset_id <= 0 || typeof row.file_path !== 'string') throw Error('INVALID_ASSET_OWNER')
    const path = row.file_path.replace(/\\/g, '/')
    validateArchivePaths([{ path, kind: 'file' }])
    const parts = path.split('/')
    if (parts.length < 3 || parts[0] !== 'files' || parts[1] !== String(row.asset_id)) throw Error('INVALID_ASSET_FILE_PATH')
    if (verified.has(path)) continue
    const expected = assertPath(assetsRoot, parts, true)
    const fd = openSync(join(assetsRoot, ...parts), 'r')
    try {
      const actual = fstatSync(fd)
      if (!actual.isFile() || actual.dev !== expected.dev || actual.ino !== expected.ino) throw Error('ASSET_FILE_CHANGED')
      let total = 0
      for (;;) {
        const count = readSync(fd, buffer, 0, buffer.length, null)
        yield
        if (count === 0) break
        total += count
        if (total > actual.size) throw Error('ASSET_FILE_CHANGED')
      }
      const after = fstatSync(fd)
      if (total !== actual.size || after.size !== actual.size || after.mtimeMs !== actual.mtimeMs || after.ctimeMs !== actual.ctimeMs) {
        throw Error('ASSET_FILE_CHANGED')
      }
    } finally { try { closeSync(fd) } catch (error) { markMaintenanceCleanupFailure(); throw error } }
    verified.add(path)
  }
}

/** 返回已验证的版本；只读预检不建库、不迁移，不忽略关闭失败。 */
export function inspectAssetsCopy(dbPath: string, options: AssetsIntegrityOptions = {}): number {
  let db: Database.Database | undefined
  let result = 0
  let error: unknown
  try {
    assertPath(dirname(dbPath), [dbPath.slice(dirname(dbPath).length + 1)], true)
    const factory = databaseFactory(options)
    db = factory(dbPath, { readonly: true, fileMustExist: true })
    result = inspectStore(db, factory)
    if (result !== 0) for (const _ of inspectHistoricalFiles(db, dirname(dbPath))) { void _ }
  } catch (caught) { error = caught }
  finally {
    try { db?.close() } catch (caught) { markMaintenanceCleanupFailure(); error ??= caught }
  }
  if (error !== undefined) throw failure(error, dbPath)
  return result
}

/** 同步旧API保持；维护上下文逐块让出事件循环，取消会关闭迭代器和数据库。 */
async function inspectAssetsCopyCooperative(dbPath: string, options: AssetsIntegrityOptions): Promise<number> {
  if (!maintenanceSignal()) return inspectAssetsCopy(dbPath, options)
  await maintenanceCheckpoint()
  let db: Database.Database | undefined, result = 0, error: unknown
  try {
    assertPath(dirname(dbPath), [dbPath.slice(dirname(dbPath).length + 1)], true)
    const factory = databaseFactory(options)
    db = factory(dbPath, { readonly: true, fileMustExist: true })
    result = inspectStore(db, factory)
    if (result !== 0) for (const _ of inspectHistoricalFiles(db, dirname(dbPath))) { void _; await maintenanceCheckpoint() }
  } catch (caught) { error = caught }
  finally { try { db?.close() } catch (caught) { markMaintenanceCleanupFailure(); error ??= caught } }
  checkMaintenanceCancellation()
  if (error !== undefined) throw failure(error, dbPath)
  return result
}

/** 可缺资产模块的空间自检：缺库合法，存在的损坏/未来库绝不跳过。 */
export async function checkOptionalAssetsCopy(dbPath: string, options: AssetsIntegrityOptions = {}): Promise<void> {
  try { if (optionalDatabase(dirname(dirname(dirname(dbPath)))) === undefined) return }
  catch (error) { throw failure(error, dbPath) }
  await inspectAssetsCopyCooperative(dbPath, options)
}

/** 仅由维护恢复在已持写锁的 stagingRoot 内调用；真实空间自检不得调用。 */
export async function prepareStagedAssets(stagingRoot: string, options: AssetsIntegrityOptions = {}): Promise<void> {
  const dbPath = join(stagingRoot, '.mimir/assets/assets.db')
  let db: Database.Database | undefined
  let error: unknown
  try {
    const stat = optionalDatabase(stagingRoot)
    if (stat === undefined) return
    if (stat.nlink !== 1) throw Error('SHARED_DATABASE_FILE')
    const version = await inspectAssetsCopyCooperative(dbPath, options)
    if (version === ASSETS_SCHEMA_VERSION) return
    const assets = dirname(dbPath)
    // mkdir不覆盖已有普通文件；已有junction也必须在任何写入之前拒绝。
    const backups = join(assets, 'backups')
    try { assertPath(assets, ['backups'], false) } catch (caught) {
      if ((caught as NodeJS.ErrnoException).code !== 'ENOENT') throw caught
      mkdirSync(backups)
    }
    assertPath(assets, ['backups'], false)
    const factory = databaseFactory(options)
    db = factory(dbPath, { fileMustExist: true })
    // 预检和可写打开之间若副本被换过，不得继续迁移。
    if (inspectStore(db, factory) !== version) throw Error('ASSETS_VERSION_CHANGED')
    await snapshotBeforeMigration(db, backups, () => new Date())
    await maintenanceCheckpoint()
    db.pragma('foreign_keys = ON')
    initializeSchema(db, () => new Date())
  } catch (caught) { error = caught }
  finally {
    try { db?.close() } catch (caught) { markMaintenanceCleanupFailure(); error ??= caught }
  }
  if (error !== undefined) throw failure(error, dbPath)
  await inspectAssetsCopyCooperative(dbPath, options)
}
