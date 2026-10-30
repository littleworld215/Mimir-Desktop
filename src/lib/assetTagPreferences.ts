const MAX = 20, BYTES = 16 * 1024
function key(workspaceId: string): string { if (!workspaceId || workspaceId.length > 512) throw Error('未取得有效科研空间。'); return `mimir:asset-frequent-tags:v1:${workspaceId}` }
function ids(value: unknown): number[] {
  if (!Array.isArray(value) || value.some(id => !Number.isSafeInteger(id) || id < 1)) throw Error('常用标签ID非法。')
  const unique = [...new Set<number>(value)]
  if (unique.length > MAX) throw Error('每个科研空间最多20个常用标签，请先取消一个。')
  return unique
}
export function readFrequentAssetTags(storage: Pick<Storage,'getItem'>, workspaceId: string): { ids: number[]; warning?: string } {
  try {
    const raw = storage.getItem(key(workspaceId))
    if (raw === null) return { ids: [] }
    if (raw.length > BYTES || new TextEncoder().encode(raw).byteLength > BYTES) throw Error('常用标签偏好超过16KiB。')
    const data = JSON.parse(raw)
    if (!data || typeof data !== 'object' || Array.isArray(data) || Object.keys(data).some(k => !['version','ids'].includes(k)) || data.version !== 1) throw Error('常用标签偏好损坏或版本较新。')
    return { ids: ids(data.ids) }
  } catch { return { ids: [], warning: '常用标签偏好读取失败或格式不受支持；原偏好未覆盖，请重试读取。' } }
}
export function writeFrequentAssetTags(storage: Pick<Storage,'setItem'>, workspaceId: string, value: number[]): { ok: boolean; message?: string } {
  try { storage.setItem(key(workspaceId), JSON.stringify({ version: 1, ids: ids(value) })); return { ok: true } }
  catch (failure) { return { ok: false, message: failure instanceof Error ? failure.message : '常用标签保存失败，原筛选保留。' } }
}
