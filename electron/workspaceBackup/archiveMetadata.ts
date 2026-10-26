import type { BackupMetadata, BackupScopeSummary, BackupScopeDetailsPage } from '../../shared/workspaceBackupMetadata'
import type { ManifestEntry } from './manifest'
import { validateArchivePaths } from './archivePaths'

function fail(code = 'MANIFEST_INVALID'): never { throw Object.assign(new Error('备份范围说明无效或不受支持。'), { code }) }
const record = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v)
const size = (v: unknown): v is number => Number.isSafeInteger(v) && Number(v) >= 0
const text = (v: unknown, max: number): v is string => typeof v === 'string' && v.length > 0 && v.length <= max && !/[\u0000-\u001f\u007f]/.test(v)
function fields(v: unknown, required: string[], optional: string[] = []): asserts v is Record<string, unknown> {
  if (!record(v) || required.some(k => !Object.hasOwn(v, k)) || Object.keys(v).some(k => !required.includes(k) && !optional.includes(k))) fail()
}

/** 严格验证声明；仅缺失metadata字段的旧清单由调用方跳过。 */
export function validateBackupMetadata(value: unknown, entries: readonly ManifestEntry[]): BackupMetadata {
  fields(value, ['version', 'producer', 'database', 'maxFileBytes', 'exclusionPolicyVersion', 'excluded', 'external'])
  if (value.version !== 1) fail('VERSION_UNSUPPORTED')
  fields(value.producer, ['application', 'version', 'platform'])
  if (value.producer.application !== 'Mimir-Desktop' || (value.producer.version !== null && !text(value.producer.version, 64))
    || !['win32', 'darwin', 'linux', 'unknown'].includes(String(value.producer.platform))) fail()
  if (!size(value.maxFileBytes) || value.exclusionPolicyVersion !== 1 || !Array.isArray(value.excluded)) fail()
  fields(value.external, ['coverage', 'unresolved', 'references'], ['reason'])
  const external = value.external
  if (!['known-structured-fields', 'unknown'].includes(String(external.coverage)) || !size(external.unresolved)
    || !Array.isArray(external.references) || value.excluded.length + external.references.length > 100_000) fail()
  if (external.coverage === 'known-structured-fields' ? external.reason !== undefined || external.unresolved !== 0
    : !['missing-store', 'invalid-store', 'oversize-store', 'ambiguous-reference'].includes(String(external.reason))) fail()
  const excludedPaths: { path: string; kind: 'file' }[] = []
  for (const item of value.excluded) {
    fields(item, ['path', 'reason', 'size', 'defaultDisposition'])
    if (!text(item.path, 4096) || !size(item.size) || item.size <= value.maxFileBytes || item.reason !== 'oversize' || item.defaultDisposition !== 'exclude') fail()
    excludedPaths.push({ path: item.path, kind: 'file' })
  }
  try {
    validateArchivePaths([...entries, ...excludedPaths, { path: 'mimir-manifest.json', kind: 'file' }], 200_001)
  } catch { fail() }
  const identities = new Set<string>()
  for (const item of external.references) {
    fields(item, ['storeKey', 'locator', 'field', 'kind', 'target', 'status'])
    if (!text(item.storeKey, 2048) || !text(item.locator, 2048) || !text(item.field, 2048) || !text(item.target, 32768)
      || !['pdf', 'project', 'artifact'].includes(String(item.kind)) || item.status !== 'not-included-unchecked') fail()
    const identity = JSON.stringify([item.storeKey, item.locator, item.field])
    if (identities.has(identity)) fail()
    identities.add(identity)
  }
  const database = value.database
  if (!record(database)) fail()
  const actual = entries.find(e => e.kind === 'file' && e.path.toLowerCase() === '.mimir/assets/assets.db')
  if (database.state === 'absent') {
    fields(database, ['state'])
    if (actual) fail()
  } else if (database.state === 'unknown' || database.state === 'present') {
    fields(database, database.state === 'present' ? ['state', 'path', 'userVersion'] : ['state'], database.state === 'unknown' ? ['path'] : [])
    if (database.path !== undefined) {
      if (!text(database.path, 4096) || !entries.some(e => e.kind === 'file' && e.path === database.path)) fail()
      if (actual && database.path !== actual.path) fail()
    }
    if (database.state === 'present' && !size(database.userVersion)) fail()
  } else fail()
  return value as unknown as BackupMetadata
}

/** 普通结果只有计数，不泄露外部引用目标。 */
export function summarizeBackupScope(metadata?: BackupMetadata): BackupScopeSummary {
  if (!metadata) return { metadata: 'legacy-unknown', coverage: 'unknown', reason: 'missing-metadata', excludedCount: 0, externalCount: 0, unresolvedCount: 0 }
  const { external, database } = metadata
  return {
    metadata: 'present', coverage: external.coverage,
    ...(external.reason ? { reason: external.reason } : {}),
    excludedCount: metadata.excluded.length, externalCount: external.references.length, unresolvedCount: external.unresolved,
    producer: { ...metadata.producer },
    database: database.state === 'present' ? { state: 'present', userVersion: database.userVersion } : { state: database.state }
  }
}

/** 排除项后外部引用，显式分页，禁止负游标或越界。 */
export function pageBackupScope(metadata: BackupMetadata | undefined, offset: number): BackupScopeDetailsPage {
  const excluded = metadata?.excluded ?? [], references = metadata?.external.references ?? []
  const total = excluded.length + references.length
  if (!size(offset) || offset > total || offset > 100_000) throw Object.assign(new Error('范围说明游标无效。'), { code: 'INVALID_REQUEST' })
  const items: BackupScopeDetailsPage['items'] = []
  for (let i = offset; i < Math.min(offset + 100, total); i++) {
    items.push(i < excluded.length ? { kind: 'excluded', entry: { ...excluded[i] } }
      : { kind: 'external', entry: { ...references[i - excluded.length] } })
  }
  return { summary: summarizeBackupScope(metadata), items, offset, ...(offset + items.length < total ? { nextOffset: offset + items.length } : {}) }
}
