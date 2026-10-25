import { randomUUID } from 'node:crypto'
import { closeSync, existsSync, fsyncSync, linkSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { RestoreError } from './restoreContracts'
import { assertRestoreDirectory, restoreRootIdentity, sameRestorePath, type RestoreFingerprint, type RestoreRootIdentity } from './restoreFingerprint'
import { stagingPathFor } from './stagingRoot'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
const phases = ['prepared', 'inspecting', 'extracting', 'verifying', 'verified', 'publishing', 'published', 'registering', 'registered', 'interrupted', 'cleaning', 'cleaned'] as const
export type RestoreJournalPhase = typeof phases[number]
export interface RestoreOperationRecord {
  version: 1
  id: string
  revision: number
  spaceId: string
  spaceName: string
  targetRoot: string
  stagingRoot: string
  parentRoot: string
  parentIdentity: RestoreRootIdentity
  createdAt: string
  updatedAt: string
  phase: RestoreJournalPhase
  rootIdentity?: RestoreRootIdentity
  fingerprint?: RestoreFingerprint
  entries?: number
  totalBytes?: number
  errorCode?: string
}
const fields = new Set(['version', 'id', 'revision', 'spaceId', 'spaceName', 'targetRoot', 'stagingRoot', 'parentRoot', 'parentIdentity', 'createdAt', 'updatedAt', 'phase', 'rootIdentity', 'fingerprint', 'entries', 'totalBytes', 'errorCode'])
const invalid = () => new RestoreError('RECHECK_FAILED', '恢复操作记录无法安全读取，未修改资料。')
const text = (v: unknown, max: number): v is string => typeof v === 'string' && v.length > 0 && v.length <= max && !/[\x00-\x1f]/.test(v)
const count = (v: unknown) => typeof v === 'number' && Number.isSafeInteger(v) && v >= 0
function assertOutsideControl(home: string, target: string): void {
  const rel = relative(join(home, '.mimir'), target)
  if (!rel || (!isAbsolute(rel) && rel !== '..' && !rel.startsWith('..' + sep))) throw invalid()
}
function identity(v: unknown): v is RestoreRootIdentity {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return false
  const o = v as Record<string, unknown>
  return Object.keys(o).length === 3 && ['dev', 'ino', 'birth'].every(k => typeof o[k] === 'string' && /^\d{1,30}$/.test(o[k] as string)) && o.ino !== '0'
}
function validate(value: unknown, id: string): RestoreOperationRecord {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw invalid()
  const r = value as Record<string, unknown>
  if (Object.keys(r).some(k => !fields.has(k)) || r.version !== 1 || r.id !== id || !UUID.test(id) || typeof r.spaceId !== 'string' || !UUID.test(r.spaceId) ||
      !count(r.revision) || !text(r.spaceName, 200) || !identity(r.parentIdentity) || !phases.includes(r.phase as RestoreJournalPhase)) throw invalid()
  for (const key of ['targetRoot', 'stagingRoot', 'parentRoot']) if (!text(r[key], 32768) || !isAbsolute(r[key] as string)) throw invalid()
  if (!sameRestorePath(dirname(r.targetRoot as string), r.parentRoot as string) || !sameRestorePath(r.stagingRoot as string, stagingPathFor(r.targetRoot as string, id)) || sameRestorePath(r.targetRoot as string, r.stagingRoot as string)) throw invalid()
  for (const key of ['createdAt', 'updatedAt']) if (!text(r[key], 40) || !Number.isFinite(Date.parse(r[key] as string))) throw invalid()
  if (r.rootIdentity !== undefined && !identity(r.rootIdentity)) throw invalid()
  if (r.fingerprint !== undefined) {
    const f = r.fingerprint as RestoreFingerprint
    if (!f || typeof f !== 'object' || Object.keys(f).sort().join(',') !== 'digest,entries,totalBytes' || typeof f.digest !== 'string' || !/^[a-f0-9]{64}$/.test(f.digest) || !count(f.entries) || !count(f.totalBytes)) throw invalid()
  }
  if (r.entries !== undefined && !count(r.entries)) throw invalid()
  if (r.totalBytes !== undefined && !count(r.totalBytes)) throw invalid()
  if (r.errorCode !== undefined && (typeof r.errorCode !== 'string' || !/^[A-Z_]{1,60}$/.test(r.errorCode))) throw invalid()
  return r as unknown as RestoreOperationRecord
}
export function assertRestoreOperationId(id: string): void {
  if (typeof id !== 'string' || !UUID.test(id)) throw new RestoreError('INVALID_TARGET', '恢复操作标识无效。')
}

/** 私有恢复元数据，不是可导入的业务文件，也不包含注册表配置或业务正文。 */
export class RestoreJournal {
  readonly directory: string
  constructor(private readonly homeDir: string) { this.directory = join(homeDir, '.mimir/restore-operations') }
  private assertDirectory(create: boolean): boolean {
    assertRestoreDirectory(this.homeDir)
    const control = join(this.homeDir, '.mimir')
    if (!existsSync(control)) { if (!create) return false; mkdirSync(control) }
    assertRestoreDirectory(control)
    if (!existsSync(this.directory)) { if (!create) return false; mkdirSync(this.directory, { mode: 0o700 }) }
    assertRestoreDirectory(this.directory)
    return true
  }
  read(id: string): RestoreOperationRecord {
    assertRestoreOperationId(id)
    try {
      if (!this.assertDirectory(false)) throw invalid()
      const file = join(this.directory, `${id}.json`), before = lstatSync(file, { bigint: true })
      if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1n || before.size > 65536n) throw invalid()
      const raw = readFileSync(file, 'utf8'), after = lstatSync(file, { bigint: true })
      if (before.ino !== after.ino || before.dev !== after.dev || before.size !== after.size || before.mtimeNs !== after.mtimeNs || before.ctimeNs !== after.ctimeNs) throw invalid()
      const record = validate(JSON.parse(raw), id)
      assertOutsideControl(this.homeDir, record.targetRoot)
      return record
    } catch { throw invalid() }
  }
  create(targetRoot: string, spaceName: string): RestoreOperationRecord {
    const id = randomUUID(), stamp = new Date().toISOString(), parentRoot = dirname(resolve(targetRoot))
    const record: RestoreOperationRecord = {
      version: 1, id, revision: 0, spaceId: randomUUID(), spaceName, targetRoot: resolve(targetRoot),
      stagingRoot: stagingPathFor(resolve(targetRoot), id), parentRoot, parentIdentity: restoreRootIdentity(parentRoot),
      createdAt: stamp, updatedAt: stamp, phase: 'prepared'
    }
    validate(record, id)
    assertOutsideControl(this.homeDir, record.targetRoot)
    this.assertDirectory(true)
    this.write(record, true)
    return record
  }
  save(record: RestoreOperationRecord, patch: Partial<RestoreOperationRecord>): RestoreOperationRecord {
    const current = this.read(record.id)
    if (current.revision !== record.revision) throw new RestoreError('CONTROL_BLOCKED', '恢复记录已更新，请重新读取后操作。')
    const next = { ...record, ...patch, id: record.id, revision: record.revision + 1, updatedAt: new Date().toISOString() }
    validate(next, record.id)
    this.write(next, false)
    return next
  }
  private write(record: RestoreOperationRecord, initial: boolean): void {
    const file = join(this.directory, `${record.id}.json`), temp = join(this.directory, `.tmp-${record.id}-${randomUUID()}`)
    let fd: number | undefined
    try {
      this.assertDirectory(true)
      const raw = JSON.stringify(record)
      if (Buffer.byteLength(raw) > 65536) throw invalid()
      fd = openSync(temp, 'wx', 0o600)
      writeFileSync(fd, raw, 'utf8'); fsyncSync(fd); closeSync(fd); fd = undefined
      if (initial) { linkSync(temp, file); unlinkSync(temp) }
      else renameSync(temp, file)
    } catch { throw new RestoreError('RECHECK_FAILED', '恢复操作记录未能安全保存，已阻止继续写入。') }
    finally {
      if (fd !== undefined) { try { closeSync(fd) } catch { /* retain failure */ } }
      if (existsSync(temp)) { try { unlinkSync(temp) } catch { /* only this unique temp is eligible */ } }
    }
  }
  scan(cursor?: string): { records: RestoreOperationRecord[]; invalidRecords: number; truncated: boolean; nextCursor?: string } {
    if (cursor !== undefined) assertRestoreOperationId(cursor)
    try {
      if (!this.assertDirectory(false)) return { records: [], invalidRecords: 0, truncated: false }
      const names = readdirSync(this.directory).sort()
      const candidates = names.filter(name => name.endsWith('.json') && UUID.test(name.slice(0, -5)))
      const remaining = cursor === undefined ? candidates : candidates.filter(name => name.slice(0, -5) > cursor)
      const page = remaining.slice(0, 50), truncated = remaining.length > page.length
      const records: RestoreOperationRecord[] = []
      let invalidRecords = names.length - candidates.length
      for (const name of page) {
        try { records.push(this.read(name.slice(0, -5))) } catch { invalidRecords += 1 }
      }
      records.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt) || a.id.localeCompare(b.id))
      return { records, invalidRecords, truncated, ...(truncated ? { nextCursor: page[page.length - 1].slice(0, -5) } : {}) }
    } catch { return { records: [], invalidRecords: 1, truncated: false } }
  }
}
