import type { PlanningHostKind, PlanningInput } from '../../shared/researchPlanningContracts'
import { PlanningError } from './validation'

export type PlanningHostReader = <T>(key: string) => T | undefined
const sources = { paper: { key: 'library:papers', id: 'arxivId', name: 'title' }, libraryProject: { key: 'library:projects', id: 'id', name: 'title' }, experiment: { key: 'experiments:list', id: 'id', name: 'name' } } as const
function catalog(read: PlanningHostReader, kind: PlanningHostKind) {
  const source = sources[kind], raw = read<unknown>(source.key) ?? []
  let rows: unknown[]
  if (Array.isArray(raw)) rows = raw
  else if (kind === 'paper' && raw && typeof raw === 'object') {
    // libraryService stores papers as an arxivId-keyed table. Older arrays remain
    // readable without rewriting the original store or disclosing body/file paths.
    rows = Object.entries(raw).map(([id, value]) => {
      if (!value || typeof value !== 'object' || Array.isArray(value) || (value as Record<string, unknown>).arxivId !== id) throw new PlanningError('CORRUPT_DATA', '文献字典标识不一致，原资料保留')
      return value
    })
  } else throw new PlanningError('CORRUPT_DATA', '宿主模块元数据格式异常，原资料保留')
  const items = new Map<string, string>()
  for (const value of rows) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new PlanningError('CORRUPT_DATA', '宿主关联条目异常，原资料保留')
    const row = value as Record<string, unknown>, id = row[source.id], name = row[source.name]
    if (typeof id !== 'string' || !id || id.length > 1000 || typeof name !== 'string' || name.length > 10_000 || items.has(id)) throw new PlanningError('CORRUPT_DATA', '宿主关联标识或名称异常，请在原模块核对')
    items.set(id, name)
  }
  return items
}
export function planningReferences(read: PlanningHostReader, kind: PlanningHostKind, keyword: string, page: number, ids?: string[]) {
  const values = catalog(read, kind)
  const rows = ids ? ids.map(id => ({ id, name: values.get(id) ?? '原关联已失联', exists: values.has(id) })) : [...values].filter(([, name]) => name.toLocaleLowerCase().includes(keyword.toLocaleLowerCase())).map(([id, name]) => ({ id, name, exists: true }))
  return { items: rows.slice((page - 1) * 50, page * 50), total: rows.length, page, pageSize: 50 as const }
}
export function validatePlanningReferences(read: PlanningHostReader, input: PlanningInput, previous?: PlanningInput) {
  const check = (kind: PlanningHostKind, ids: string[], previousIds: string[]) => {
    const added = ids.filter(id => !previousIds.includes(id))
    if (!added.length) return
    const available = catalog(read, kind)
    if (added.some(id => !available.has(id))) throw new PlanningError('NOT_FOUND', '新增关联已失联，请重新选择；原记录保留')
  }
  check('libraryProject', input.libraryProjectId ? [input.libraryProjectId] : [], previous?.libraryProjectId ? [previous.libraryProjectId] : [])
  check('experiment', input.experimentIds, previous?.experimentIds ?? [])
  check('paper', input.literature?.paperId ? [input.literature.paperId] : [], previous?.literature?.paperId ? [previous.literature.paperId] : [])
}
export function planningReferenceReport(read: PlanningHostReader, items: PlanningInput[]) {
  const entries = new Map<PlanningHostKind, { title: string; id: string }[]>()
  const add = (kind: PlanningHostKind, title: string, id: string) => { const group = entries.get(kind) ?? []; group.push({ title, id }); entries.set(kind, group) }
  for (const item of items) {
    if (item.libraryProjectId) add('libraryProject', item.title, item.libraryProjectId)
    if (item.literature?.paperId) add('paper', item.title, item.literature.paperId)
    item.experimentIds.forEach(id => add('experiment', item.title, id))
  }
  let count = 0
  const examples: string[] = []
  for (const [kind, group] of entries) {
    const available = catalog(read, kind)
    for (const entry of group) if (!available.has(entry.id)) { count++; if (examples.length < 500) examples.push(`「${entry.title}」 · ${kind} · ${entry.id}`) }
  }
  return { count, examples }
}
