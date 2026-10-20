import type { PlanningDocument, PlanningInput } from './researchPlanningContracts'

export const PLANNING_KIND_LABELS = { project: '科研项目', direction: '科研方向', todo: '待办', schedule: '日程', generic: '记录', literature: '文献计划' } as const
export function emptyPlanningDocument(): PlanningDocument {
  return { schemaVersion: 1, revision: 0, collections: [{ id: 'default', name: '默认分组', order: 0, deleted: false }], types: Object.entries(PLANNING_KIND_LABELS).map(([id, name], order) => ({ id, name, kind: id as PlanningInput['kind'], builtin: true, order, deleted: false })), items: [] }
}
export function emptyPlanningInput(kind: PlanningInput['kind']): PlanningInput {
  return { kind, typeId: kind, collectionId: 'default', title: '', content: '', status: 'active', important: false, archived: false, deleted: false, priority: 'none', order: 0, fields: [], projectId: null, directionId: null, projectCategory: kind === 'project' ? 'other' : null, majorDirection: false, done: false, dueDate: null, myDay: null, schedule: null, recurrence: null, literature: null, libraryProjectId: null, experimentIds: [] }
}
