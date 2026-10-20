import { createPlanningDraftRepository } from './repository'
import { planningDraftWriteSchema, planningId, planningRevision, PlanningError } from './validation'
import type { PlanningContext } from './service'

export function createPlanningDraftService(ctx: PlanningContext) {
  const repo = createPlanningDraftRepository()
  const scope = { workspaceId: ctx.scope.id, spaceEpoch: ctx.scope.epoch }
  function list() { ctx.assertCurrent(); return { ...repo.read(ctx.scope.root), scope } }
  return {
    list,
    save(expected: number, value: unknown) {
      const draft = planningDraftWriteSchema.safeParse(value)
      if (!draft.success || !planningRevision.safeParse(expected).success) throw new PlanningError('BAD_REQUEST', '编辑草稿字段非法')
      const previous = list()
      const next = { ...draft.data, updatedAt: new Date().toISOString() }
      const drafts = previous.drafts.some(d => d.id === next.id) ? previous.drafts.map(d => d.id === next.id ? next : d) : [...previous.drafts, next]
      const saved = repo.commit(ctx.scope.root, expected, { schemaVersion: 1, revision: expected + 1, drafts }, () => ctx.assertCurrent())
      return { revision: saved.revision, scope, draft: next }
    },
    remove(expected: number, id: string) {
      if (!planningId.safeParse(id).success || !planningRevision.safeParse(expected).success) throw new PlanningError('BAD_REQUEST')
      const previous = list()
      const saved = repo.commit(ctx.scope.root, expected, { schemaVersion: 1, revision: expected + 1, drafts: previous.drafts.filter(d => d.id !== id) }, () => ctx.assertCurrent())
      return { revision: saved.revision, scope }
    }
  }
}
