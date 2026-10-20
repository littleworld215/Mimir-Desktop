import { randomUUID } from 'node:crypto'
import { PLANNING_PAGE_SIZE, type PlanningFilter, type PlanningItem } from '../../shared/researchPlanningContracts'
import { createPlanningRepository } from './repository'
import { parsePlanningInput, PlanningError } from './validation'

export interface PlanningContext { scope: { id: string; epoch: string; root: string }; assertCurrent(): void }
export function createPlanningService(ctx: PlanningContext) {
  const repo = createPlanningRepository()
  const read = () => { ctx.assertCurrent(); return repo.read(ctx.scope.root) }
  const state = (revision: number) => ({ revision, scope: { workspaceId: ctx.scope.id, spaceEpoch: ctx.scope.epoch } })
  return {
    bootstrap() { const doc = read(); return { ...state(doc.revision), collections: doc.collections, types: doc.types, total: doc.items.filter(i => !i.deleted).length } },
    list(filter: PlanningFilter, page: number) {
      if (!Number.isSafeInteger(page) || page < 1) throw new PlanningError('BAD_REQUEST', '页码非法')
      const doc = read(), keyword = filter.keyword?.toLocaleLowerCase(), archive = filter.archived ?? 'exclude'
      const items = doc.items.filter(item => {
        if (item.deleted !== (filter.deleted ?? false)) return false
        if (archive === 'exclude' && item.archived || archive === 'only' && !item.archived) return false
        for (const key of ['kind', 'typeId', 'collectionId', 'projectId', 'status', 'important', 'done', 'myDay'] as const) if (filter[key] !== undefined && item[key] !== filter[key]) return false
        const date = item.schedule?.date
        if (filter.dateFrom && (!date || date < filter.dateFrom) || filter.dateTo && (!date || date > filter.dateTo)) return false
        return !keyword || [item.title, item.content, ...item.fields.flatMap(f => [f.name, f.value])].some(value => value.toLocaleLowerCase().includes(keyword))
      }).sort((a, b) => a.order - b.order || a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id))
      return { ...state(doc.revision), items: items.slice((page - 1) * PLANNING_PAGE_SIZE, page * PLANNING_PAGE_SIZE), total: items.length, page, pageSize: PLANNING_PAGE_SIZE }
    },
    detail(id: string) { const doc = read(), item = doc.items.find(i => i.id === id); if (!item) throw new PlanningError('NOT_FOUND', '记录不存在'); return { ...state(doc.revision), item } },
    save(expectedRevision: number, value: unknown, id?: string) {
      const doc = read()
      if (expectedRevision !== doc.revision) throw new PlanningError('CONFLICT', '已有更新，请保留输入并重新加载', doc.revision)
      const input = parsePlanningInput(value), previous = id === undefined ? undefined : doc.items.find(i => i.id === id)
      if (id !== undefined && !previous) throw new PlanningError('NOT_FOUND', '记录不存在')
      const now = new Date().toISOString(), item: PlanningItem = { ...input, id: previous?.id ?? randomUUID(), createdAt: previous?.createdAt ?? now, updatedAt: now }
      const items = previous ? doc.items.map(i => i.id === item.id ? item : i) : [...doc.items, item]
      const next = repo.commit(ctx.scope.root, expectedRevision, { ...doc, revision: doc.revision + 1, items }, () => ctx.assertCurrent())
      return { ...state(next.revision), item }
    }
  }
}
