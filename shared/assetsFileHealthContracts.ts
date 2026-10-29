/** Online metadata/openability only; no stored digest or content-integrity claim. */
export type FileHealthStatus = 'openable' | 'missing' | 'invalid_path' | 'wrong_owner' | 'not_file' | 'unreadable' | 'no_file' | 'changed'
export interface FileHealthCursor { assetId: number; versionId: number; upperAssetId: number; upperVersionId: number }
export interface FileHealthItem {
  assetId: number
  assetName: string
  assetCode: string
  archived: boolean
  versionId: number | null
  version: number | null
  status: FileHealthStatus
}
export interface FileHealthBatch {
  checkedAt: string
  digestBaseline: 'not-established'
  items: FileHealthItem[]
  nextCursor: FileHealthCursor | null
}
export const FILE_HEALTH_BATCH_SIZE = 50
export const FILE_HEALTH_LABELS: Record<FileHealthStatus, string> = {
  openable: '可打开（内容未校验）', missing: '文件缺失', invalid_path: '路径非法或链接不安全',
  wrong_owner: '文件归属不符', not_file: '不是普通文件', unreadable: '不可打开', no_file: '尚无文件版本', changed: '检查期间文件变化'
}
