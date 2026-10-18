import { createHash, randomUUID } from 'node:crypto'
import type { ResearchFilter, ResearchPack, ResearchPackDetail, ResearchPackInput, ResearchPackItem, ResearchPackItemInput, ResearchPackReply, ResearchPackSummary, ResearchPackVersion, ResearchPage, ResearchRefreshPreview } from '../../../shared/libraryResearchContracts'
import { currentEvidenceVersion } from '../evidence/service'
import { assertResearchContext, assertResearchExpected, readResearchSnapshot, type ResearchContext, type ResearchSnapshot } from './evidenceAccess'
import { commitResearch } from './repository'
import { resolvePackItems, researchItemNeedsAttention } from './references'
import { assertResearchPage } from './questionView'
import { packInputSchema, ResearchError } from './validation'

export function findPack(snapshot: ResearchSnapshot, id: string): ResearchPack {
  const pack = snapshot.document.packs.find(p => p.id === id)
  if (!pack) throw new ResearchError('NOT_FOUND', '素材包不存在')
  return pack
}
function commitPack(ctx: ResearchContext, snapshot: ResearchSnapshot, pack: ResearchPack, expected: number, revalidate: () => void): ResearchPackReply {
  const exists = snapshot.document.packs.some(p => p.id === pack.id)
  const next = commitResearch(ctx.scope.root, expected, { ...snapshot.document, revision: expected + 1, packs: exists ? snapshot.document.packs.map(p => p.id === pack.id ? pack : p) : [...snapshot.document.packs, pack] }, () => { assertResearchContext(ctx); revalidate() })
  return { ...snapshot.state, revision: next.revision, pack }
}
function newItem(ctx: ResearchContext, snapshot: ResearchSnapshot, projectId: string, input: Extract<ResearchPackItemInput, { kind: 'new' }>, id: string = randomUUID()): ResearchPackItem {
  const q = snapshot.document.questions.find(q => q.id === input.questionId), v = q?.versions[q.currentVersion - 1]
  const card = snapshot.evidence?.cards.find(c => c.id === input.cardId), e = card && currentEvidenceVersion(card)
  if (!ctx.catalog.projects().some(p => p.id === projectId) || !q || !v || v.archived || v.projectId !== projectId || !v.evidenceCardIds.includes(input.cardId) || !e || e.archived || !e.projectIds.includes(projectId)) throw new ResearchError('REFERENCE_UNRESOLVED', '引用缺失、已归档、已移出问题组或不属于该项目')
  return { id, questionId: q.id, questionVersion: q.currentVersion, cardId: input.cardId, evidenceVersion: e.version, section: input.section, note: input.note }
}
export function savePack(ctx: ResearchContext, request: { packId?: string; input: ResearchPackInput; expectedRevision: number; expectedEvidenceRevision?: number }): ResearchPackReply {
  const parsed = packInputSchema.safeParse(request.input)
  if (!parsed.success) throw new ResearchError('BAD_REQUEST', '素材字段非法或超限')
  const input = parsed.data, snapshot = readResearchSnapshot(ctx)
  assertResearchExpected(snapshot, request.expectedRevision)
  const old = request.packId ? findPack(snapshot, request.packId) : undefined, previous = old?.versions[old.currentVersion - 1]
  if (previous && input.projectId !== previous.projectId) throw new ResearchError('BAD_REQUEST', '素材包创建后不可更换项目')
  if (!previous && !ctx.catalog.projects().some(p => p.id === input.projectId)) throw new ResearchError('NOT_FOUND', '请先选择已有项目')
  const newInputs = input.items.filter((i): i is Extract<ResearchPackItemInput, { kind: 'new' }> => i.kind === 'new')
  if (newInputs.length) {
    if (previous?.archived) throw new ResearchError('BAD_REQUEST', '请先恢复素材包再添加条目')
    if (request.expectedEvidenceRevision === undefined) throw new ResearchError('BAD_REQUEST', '选入条目需要当前证据修订号')
    assertResearchExpected(snapshot, request.expectedRevision, request.expectedEvidenceRevision)
  }
  const items = input.items.map(i => {
    if (i.kind === 'existing') {
      const existing = previous?.items.find(old => old.id === i.itemId)
      if (!existing) throw new ResearchError('BAD_REQUEST', '既有条目不属于该素材包')
      return { ...existing, section: i.section, note: i.note }
    }
    if (previous?.items.some(old => old.questionId === i.questionId && old.cardId === i.cardId)) throw new ResearchError('BAD_REQUEST', '已有引用请保留原条目，更新版本请先预览差异')
    return newItem(ctx, snapshot, input.projectId, i)
  })
  if (new Set(items.map(i => i.id)).size !== items.length || new Set(items.map(i => `${i.questionId}:${i.cardId}`)).size !== items.length) throw new ResearchError('BAD_REQUEST', '同一问题与证据不能重复选入')
  if (previous && JSON.stringify({ projectId: previous.projectId, title: previous.title, note: previous.note, items: previous.items }) === JSON.stringify({ projectId: input.projectId, title: input.title, note: input.note, items })) return { ...snapshot.state, pack: old! }
  const now = new Date().toISOString(), v: ResearchPackVersion = { projectId: input.projectId, title: input.title, note: input.note, items, version: (previous?.version ?? 0) + 1, archived: previous?.archived ?? false, updatedAt: now }
  const pack = old ? { ...old, currentVersion: v.version, versions: [...old.versions, v] } : { id: randomUUID(), createdAt: now, currentVersion: 1, versions: [v] }
  return commitPack(ctx, snapshot, pack, request.expectedRevision, () => {
    const latest = readResearchSnapshot(ctx)
    assertResearchExpected(latest, request.expectedRevision, newInputs.length ? request.expectedEvidenceRevision : undefined)
    if (!previous && !ctx.catalog.projects().some(p => p.id === input.projectId)) throw new ResearchError('NOT_FOUND', '保存期间项目已移除')
    newInputs.forEach(i => { newItem(ctx, latest, input.projectId, i) })
  })
}
export function archivePack(ctx: ResearchContext, id: string, archived: boolean, expectedRevision: number): ResearchPackReply {
  if (typeof archived !== 'boolean') throw new ResearchError('BAD_REQUEST', '归档值非法')
  const snapshot = readResearchSnapshot(ctx); assertResearchExpected(snapshot, expectedRevision)
  const old = findPack(snapshot, id), previous = old.versions[old.currentVersion - 1]!
  if (previous.archived === archived) return { ...snapshot.state, pack: old }
  const v = { ...previous, version: previous.version + 1, archived, updatedAt: new Date().toISOString() }
  return commitPack(ctx, snapshot, { ...old, currentVersion: v.version, versions: [...old.versions, v] }, expectedRevision, () => {})
}
export function packDetail(ctx: ResearchContext, request: { packId: string; version?: number }): ResearchPackDetail {
  const snapshot = readResearchSnapshot(ctx), pack = findPack(snapshot, request.packId), selectedVersion = request.version ?? pack.currentVersion
  if (!Number.isSafeInteger(selectedVersion) || selectedVersion < 1 || selectedVersion > pack.currentVersion) throw new ResearchError('NOT_FOUND', '素材历史版本不存在')
  return { ...snapshot.state, pack, selectedVersion, items: resolvePackItems(ctx, snapshot, pack.versions[selectedVersion - 1]!) }
}
export function listPacks(ctx: ResearchContext, filter: ResearchFilter, page: number): ResearchPage<ResearchPackSummary> {
  assertResearchPage(page)
  const snapshot = readResearchSnapshot(ctx), keyword = (filter.keyword ?? '').trim().toLocaleLowerCase()
  const all = snapshot.document.packs.filter(p => {
    const v = p.versions[p.currentVersion - 1]!
    return (!filter.projectId || v.projectId === filter.projectId) && (filter.archive === 'include' || v.archived === (filter.archive === 'only')) && [v.title, v.note, ...v.items.flatMap(i => [i.section, i.note])].join('\n').toLocaleLowerCase().includes(keyword)
  }).map(p => {
    const v = p.versions[p.currentVersion - 1]!
    return { id: p.id, projectId: v.projectId, title: v.title, currentVersion: p.currentVersion, archived: v.archived, itemCount: v.items.length, problemCount: snapshot.evidence ? resolvePackItems(ctx, snapshot, v).filter(researchItemNeedsAttention).length + (ctx.catalog.projects().some(project => project.id === v.projectId) ? 0 : 1) : null }
  })
  return { ...snapshot.state, items: all.slice((page - 1) * 50, page * 50), total: all.length, page, pageSize: 50 }
}
interface RefreshRequest { packId: string; itemIds: string[]; expectedRevision: number; expectedEvidenceRevision: number }
export function previewPackRefresh(ctx: ResearchContext, request: RefreshRequest): ResearchRefreshPreview {
  if (!Array.isArray(request.itemIds) || !request.itemIds.length || request.itemIds.length > 500 || new Set(request.itemIds).size !== request.itemIds.length) throw new ResearchError('BAD_REQUEST', '请选取不重复的素材条目')
  const snapshot = readResearchSnapshot(ctx); assertResearchExpected(snapshot, request.expectedRevision, request.expectedEvidenceRevision)
  const pack = findPack(snapshot, request.packId), v = pack.versions[pack.currentVersion - 1]!, before = resolvePackItems(ctx, snapshot, v)
  const changes = request.itemIds.map(id => {
    const selected = before.find(i => i.item.id === id)
    if (!selected) throw new ResearchError('NOT_FOUND', '选中条目已不存在')
    try {
      if (v.archived) throw new ResearchError('BAD_REQUEST', '请先恢复素材包')
      const next = newItem(ctx, snapshot, v.projectId, { kind: 'new', questionId: selected.item.questionId, cardId: selected.item.cardId, section: selected.item.section, note: selected.item.note }, selected.item.id)
      const after = resolvePackItems(ctx, snapshot, { ...v, items: [next] })[0]!
      return { itemId: id, eligible: true, before: selected, after }
    } catch (error) {
      if (!(error instanceof ResearchError)) throw error
      return { itemId: id, eligible: false, reason: error.message, before: selected }
    }
  })
  const previewToken = createHash('sha256').update(JSON.stringify({ kind: 'research-refresh', space: [ctx.scope.id, ctx.scope.epoch], state: snapshot.state, packId: pack.id, packVersion: pack.currentVersion, changes })).digest('hex')
  return { ...snapshot.state, packId: pack.id, packVersion: pack.currentVersion, previewToken, changes }
}
export function applyPackRefresh(ctx: ResearchContext, request: RefreshRequest & { previewToken: string }): ResearchPackReply {
  const preview = previewPackRefresh(ctx, request)
  if (preview.previewToken !== request.previewToken) throw new ResearchError('CONFLICT', '素材或证据已变化，请重新预览差异')
  if (preview.changes.some(c => !c.eligible || !c.after)) throw new ResearchError('REFERENCE_UNRESOLVED', '所选引用有失效项，请先修订分组')
  const snapshot = readResearchSnapshot(ctx), old = findPack(snapshot, request.packId), previous = old.versions[old.currentVersion - 1]!
  const replacement = new Map(preview.changes.map(c => [c.itemId, c.after!.item])), items = previous.items.map(i => replacement.get(i.id) ?? i)
  if (JSON.stringify(items) === JSON.stringify(previous.items)) return { ...snapshot.state, pack: old }
  const v = { ...previous, version: previous.version + 1, items, updatedAt: new Date().toISOString() }
  return commitPack(ctx, snapshot, { ...old, currentVersion: v.version, versions: [...old.versions, v] }, request.expectedRevision, () => {
    if (previewPackRefresh(ctx, request).previewToken !== request.previewToken) throw new ResearchError('CONFLICT', '保存期间引用已变化，请重新预览')
  })
}
