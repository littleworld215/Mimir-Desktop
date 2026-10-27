import { expect, it } from 'vitest'
import { parseArchiveManifest, resolveArchiveLimits } from '../../../electron/workspaceBackup/archivePolicy'
import { validateBackupMetadata, summarizeBackupScope, pageBackupScope } from '../../../electron/workspaceBackup/archiveMetadata'

const metadata = () => ({
  version: 1,
  producer: { application: 'Mimir-Desktop', version: null, platform: 'unknown' },
  database: { state: 'absent' },
  maxFileBytes: 10,
  exclusionPolicyVersion: 1,
  excluded: [],
  external: { coverage: 'known-structured-fields', unresolved: 0, references: [] }
})
function parse(value: unknown, entries: unknown[] = []) {
  return parseArchiveManifest(Buffer.from(JSON.stringify({ version: 1, generatedAt: '2026-10-26', entries, metadata: value })), resolveArchiveLimits())
}

// These cases catch silently ignored malformed declarations at the actual archive parser.
it.each([
  null, { version: 2 }, { ...metadata(), maxFileBytes: -1 }, { ...metadata(), extra: true },
  { ...metadata(), excluded: [{ path: 'a', size: 11, reason: 'oversize', defaultDisposition: 'exclude' }, { path: 'A', size: 12, reason: 'oversize', defaultDisposition: 'exclude' }] },
  { ...metadata(), database: { state: 'present', path: '.mimir/assets/assets.db', userVersion: 4 } },
  { ...metadata(), external: { coverage: 'known-structured-fields', unresolved: -1, references: [] } }
])('拒绝无效的已声明范围元信息 %j', value => {
  expect(() => parse(value)).toThrow()
})

it('未包含数据库声明不能掩盖实际资产库条目', () => {
  expect(() => parse(metadata(), [{ path: '.mimir/assets/assets.db', kind: 'file', size: 1, sha256: 'a'.repeat(64) }])).toThrow()
})

it('排除项不能与实际归档条目重叠', () => {
  expect(() => parse({ ...metadata(), excluded: [{ path: 'a', size: 11, reason: 'oversize', defaultDisposition: 'exclude' }] }, [
    { path: 'a', kind: 'file', size: 11, sha256: 'a'.repeat(64) }
  ])).toThrow()
})

it('旧格式1无metadata仍合法', () => {
  const old = parseArchiveManifest(Buffer.from(JSON.stringify({ version: 1, generatedAt: 'old', entries: [] })), resolveArchiveLimits())
  expect(old).not.toHaveProperty('metadata')
})

it.each([
  { ...metadata(), producer: { ...metadata().producer, platform: ['win32'] } },
  { ...metadata(), external: { coverage: ['unknown'], reason: 'missing-store', unresolved: 0, references: [] } },
  { ...metadata(), external: { coverage: 'unknown', reason: ['missing-store'], unresolved: 0, references: [] } },
  { ...metadata(), external: { coverage: 'known-structured-fields', unresolved: 0, references: [
    { storeKey: 'library:papers', locator: 'synthetic', field: 'pdfPath', kind: ['pdf'], target: 'Q:/synthetic.pdf', status: 'not-included-unchecked' }
  ] } }
])('声明中的枚举数组不能通过字符串强转伪装成有效说明 %j', value => {
  expect(() => parse(value)).toThrowError(expect.objectContaining({ code: 'MANIFEST_INVALID' }))
})

it('缺失字段只能在旧清单分支处理；纯校验不接受undefined或稀疏数组', () => {
  expect(() => validateBackupMetadata(undefined, [])).toThrow()
  expect(() => validateBackupMetadata({ ...metadata(), excluded: new Array(1) }, [])).toThrow()
  expect(summarizeBackupScope()).toMatchObject({ metadata: 'legacy-unknown', coverage: 'unknown', reason: 'missing-metadata' })
})

it('100项分页完整且无默认路径泄漏，同一外部目标的不同引用可保留', () => {
  const external = { coverage: 'known-structured-fields', unresolved: 0, references: Array.from({ length: 101 }, (_, i) => ({
    storeKey: 'library:papers', locator: `[${i}]`, field: 'pdfPath', kind: 'pdf', target: 'Q:/private.pdf', status: 'not-included-unchecked'
  })) }
  const value = validateBackupMetadata({ ...metadata(), external }, [])
  expect(JSON.stringify(summarizeBackupScope(value))).not.toContain('Q:/private.pdf')
  const first = pageBackupScope(value, 0), second = pageBackupScope(value, 100)
  expect(first.items).toHaveLength(100)
  expect(first.nextOffset).toBe(100)
  expect(second.items).toHaveLength(1)
  expect(second.nextOffset).toBeUndefined()
  expect(() => pageBackupScope(value, 102)).toThrow()
  expect(() => pageBackupScope(value, -1)).toThrow()
  expect(() => validateBackupMetadata({ ...metadata(), external: { ...external, references: [external.references[0], external.references[0]] } }, [])).toThrow()
})

it('未来metadata版本保留版本错误码，坏声明保留MANIFEST_INVALID', () => {
  expect(() => parse({ ...metadata(), version: 2 })).toThrowError(expect.objectContaining({ code: 'VERSION_UNSUPPORTED' }))
  expect(() => parse({ ...metadata(), maxFileBytes: -1 })).toThrowError(expect.objectContaining({ code: 'MANIFEST_INVALID' }))
})
