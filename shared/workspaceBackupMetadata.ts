/** 备份范围声明不是内容校验结果；旧归档缺失时不得补造完整性。 */
export interface BackupProducer {
  application: 'Mimir-Desktop'
  version: string | null
  platform: 'win32' | 'darwin' | 'linux' | 'unknown'
}
export type BackupDatabaseMetadata = { state: 'absent' } | { state: 'unknown'; path?: string }
  | { state: 'present'; path: string; userVersion: number }
export interface BackupExcludedEntry {
  path: string
  reason: 'oversize'
  size: number
  defaultDisposition: 'exclude'
}
export interface BackupExternalReference {
  storeKey: string
  locator: string
  field: string
  kind: 'pdf' | 'project' | 'artifact'
  target: string
  status: 'not-included-unchecked'
}
export type BackupCoverageReason = 'missing-store' | 'invalid-store' | 'oversize-store' | 'ambiguous-reference'
export interface BackupMetadata {
  version: 1
  producer: BackupProducer
  database: BackupDatabaseMetadata
  maxFileBytes: number
  exclusionPolicyVersion: 1
  excluded: BackupExcludedEntry[]
  external: {
    coverage: 'known-structured-fields' | 'unknown'
    reason?: BackupCoverageReason
    unresolved: number
    references: BackupExternalReference[]
  }
}
export interface BackupScopeSummary {
  metadata: 'present' | 'legacy-unknown'
  coverage: 'known-structured-fields' | 'unknown'
  reason?: BackupCoverageReason | 'missing-metadata'
  excludedCount: number
  externalCount: number
  unresolvedCount: number
  producer?: BackupProducer
  database?: { state: 'absent' | 'unknown' | 'present'; userVersion?: number }
}
export interface BackupScopeDetailsPage {
  summary: BackupScopeSummary
  items: ({ kind: 'excluded'; entry: BackupExcludedEntry } | { kind: 'external'; entry: BackupExternalReference })[]
  offset: number
  nextOffset?: number
}
