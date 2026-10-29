import type { EvidenceFilter } from '../../shared/libraryEvidenceContracts'

export interface LibraryReadingPosition {
  paperId: string
  mode: 'native' | 'enhanced'
  page?: number
  requestedNativePage?: number
  scale: number
  touchedAt: number
}
export interface LibraryBrowseSnapshot {
  version: 1
  projectId: string | null
  view: 'papers' | 'matrix' | 'research'
  keyword: string
  scrollTop: number
  returnPaperId?: string
  matrix?: { filter: EvidenceFilter; page: number; scrollTop: number }
  research?: {
    kind: 'questions' | 'packs'
    keyword: string
    archive: 'exclude' | 'include' | 'only'
    page: number
    scrollTop: number
    selected?: { kind: 'question' | 'pack'; id: string }
  }
  readers: LibraryReadingPosition[]
}
export type BrowsePreferenceResult = { ok: boolean; message?: string }
const MAX_BYTES = 64 * 1024
const encoder = new TextEncoder()
const warning = '本机浏览位置未恢复或保存；当前阅读与科研资料不受影响，可清除本空间浏览位置后重试。'

function key(workspaceId: string): string {
  if (!workspaceId || workspaceId.length > 256 || /[\x00-\x1f/\\]/.test(workspaceId)) throw Error('workspace')
  return `mimir:library-browse:v1:${workspaceId}`
}
function object(value: unknown, allowed: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw Error('object')
  const proto = Object.getPrototypeOf(value)
  if (proto !== Object.prototype && proto !== null) throw Error('prototype')
  if (Object.keys(value).some(name => !allowed.includes(name))) throw Error('unknown property')
  return value as Record<string, unknown>
}
function text(value: unknown): string {
  if (typeof value !== 'string') throw Error('text')
  return value
}
function id(value: unknown): string {
  const result = text(value)
  if (!result || result.length > 1024 || /[\x00-\x1f]/.test(result) || /^(?:[A-Za-z]:[\\/]|[\\/])/.test(result)) throw Error('id')
  return result
}
function oneOf<T extends string>(value: unknown, values: readonly T[]): T {
  if (typeof value !== 'string' || !values.includes(value as T)) throw Error('enum')
  return value as T
}
function nonnegative(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) throw Error('number')
  return value
}
function page(value: unknown): number {
  const result = nonnegative(value)
  if (!Number.isSafeInteger(result) || result < 1) throw Error('page')
  return result
}
function filter(value: unknown): EvidenceFilter {
  const v = object(value, ['projectId', 'keyword', 'reviewState', 'archive', 'source'])
  return {
    archive: oneOf(v.archive, ['exclude', 'only', 'include']),
    source: oneOf(v.source, ['all', 'problem']),
    ...(v.projectId !== undefined ? { projectId: id(v.projectId) } : {}),
    ...(v.keyword !== undefined ? { keyword: text(v.keyword) } : {}),
    ...(v.reviewState !== undefined ? { reviewState: oneOf(v.reviewState, ['draft', 'checked'] as const) } : {})
  }
}
function reader(value: unknown): LibraryReadingPosition {
  const v = object(value, ['paperId', 'mode', 'page', 'requestedNativePage', 'scale', 'touchedAt'])
  const mode = oneOf(v.mode, ['native', 'enhanced'])
  const scale = nonnegative(v.scale)
  if (scale === 0 || (mode === 'native' && v.page !== undefined)) throw Error('reader')
  return {
    paperId: id(v.paperId), mode, scale, touchedAt: nonnegative(v.touchedAt),
    ...(v.page !== undefined ? { page: page(v.page) } : {}),
    ...(v.requestedNativePage !== undefined ? { requestedNativePage: page(v.requestedNativePage) } : {})
  }
}
function normalize(value: unknown): LibraryBrowseSnapshot {
  const v = object(value, ['version', 'projectId', 'view', 'keyword', 'scrollTop', 'returnPaperId', 'matrix', 'research', 'readers'])
  if (v.version !== 1 || !Array.isArray(v.readers)) throw Error('format')
  const unique = new Map<string, LibraryReadingPosition>()
  for (const item of v.readers) {
    const next = reader(item), previous = unique.get(next.paperId)
    if (!previous || next.touchedAt >= previous.touchedAt) unique.set(next.paperId, next)
  }
  const result: LibraryBrowseSnapshot = {
    version: 1, projectId: v.projectId === null ? null : id(v.projectId),
    view: oneOf(v.view, ['papers', 'matrix', 'research']), keyword: text(v.keyword), scrollTop: nonnegative(v.scrollTop),
    ...(v.returnPaperId !== undefined ? { returnPaperId: id(v.returnPaperId) } : {}),
    readers: [...unique.values()].sort((a, b) => b.touchedAt - a.touchedAt).slice(0, 20)
  }
  if (v.matrix !== undefined) {
    const m = object(v.matrix, ['filter', 'page', 'scrollTop'])
    result.matrix = { filter: filter(m.filter), page: page(m.page), scrollTop: nonnegative(m.scrollTop) }
  }
  if (v.research !== undefined) {
    const r = object(v.research, ['kind', 'keyword', 'archive', 'page', 'scrollTop', 'selected'])
    result.research = { kind: oneOf(r.kind, ['questions', 'packs']), keyword: text(r.keyword), archive: oneOf(r.archive, ['exclude', 'include', 'only']), page: page(r.page), scrollTop: nonnegative(r.scrollTop) }
    if (r.selected !== undefined) {
      const selected = object(r.selected, ['kind', 'id'])
      result.research.selected = { kind: oneOf(selected.kind, ['question', 'pack']), id: id(selected.id) }
    }
  }
  return result
}

export function readLibraryBrowseState(storage: Pick<Storage, 'getItem'>, workspaceId: string): { state?: LibraryBrowseSnapshot; warning?: string } {
  try {
    const raw = storage.getItem(key(workspaceId))
    if (raw === null) return {}
    if (encoder.encode(raw).length > MAX_BYTES) throw Error('size')
    return { state: normalize(JSON.parse(raw)) }
  } catch { return { warning } }
}
export function writeLibraryBrowseState(storage: Pick<Storage, 'setItem'>, workspaceId: string, state: LibraryBrowseSnapshot): BrowsePreferenceResult {
  try {
    const name = key(workspaceId), raw = JSON.stringify(normalize(state))
    if (encoder.encode(raw).length > MAX_BYTES) throw Error('size')
    storage.setItem(name, raw)
    return { ok: true }
  } catch { return { ok: false, message: warning } }
}
export function clearLibraryBrowseState(storage: Pick<Storage, 'removeItem'>, workspaceId: string): BrowsePreferenceResult {
  try { storage.removeItem(key(workspaceId)); return { ok: true } }
  catch { return { ok: false, message: warning } }
}
