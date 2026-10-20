import { createHash, randomUUID } from 'node:crypto'
import { isUtf8 } from 'node:buffer'
import type { PlanningDocument, PlanningExportFormat, PlanningImportOptions, PlanningImportSelection } from '../../shared/researchPlanningContracts'
import { createPlanningRepository } from './repository'
import { decodePlanningExchange, mergePlanningExchange, serializePlanningExchange } from './exchange'
import { assertPlanningBytes, PlanningError } from './validation'
import type { PlanningContext } from './service'
import { getStoreValue } from '../library/store'
import { planningReferenceReport, type PlanningHostReader } from './references'

const hash = (value: string | Buffer) => createHash('sha256').update(value).digest('hex')
type Session = { owner: number; scopeKey: string; expires: number } & (
  | { kind: 'import'; document: PlanningDocument; preview?: { token: string; before: string; next: PlanningDocument; counts: ReturnType<typeof mergePlanningExchange>['counts'] } }
  | { kind: 'export'; before: string; bytes: Buffer; format: PlanningExportFormat }
)
/** 只保存当前主窗口原生选择后的有限快照；renderer永远不提交文件路径或业务整表。 */
export function createPlanningExchangeService(readHost: PlanningHostReader = getStoreValue) {
  const sessions = new Map<string, Session>(), repo = createPlanningRepository()
  const scopeKey = (ctx: PlanningContext) => JSON.stringify(ctx.scope)
  const state = (ctx: PlanningContext, revision: number) => ({ scope: { workspaceId: ctx.scope.id, spaceEpoch: ctx.scope.epoch }, revision })
  function add(ctx: PlanningContext, owner: number, payload: Omit<Extract<Session, { kind: 'import' }>, 'owner' | 'scopeKey' | 'expires'> | Omit<Extract<Session, { kind: 'export' }>, 'owner' | 'scopeKey' | 'expires'>) {
    ctx.assertCurrent()
    for (const [id, session] of sessions) if (session.expires <= Date.now()) sessions.delete(id)
    while (sessions.size >= 3) sessions.delete(sessions.keys().next().value!)
    const id = randomUUID()
    sessions.set(id, { ...payload, owner, scopeKey: scopeKey(ctx), expires: Date.now() + 20 * 60_000 })
    return id
  }
  function get(ctx: PlanningContext, owner: number, id: string) {
    ctx.assertCurrent()
    const value = sessions.get(id)
    if (!value || value.owner !== owner || value.scopeKey !== scopeKey(ctx) || value.expires <= Date.now()) throw new PlanningError('SOURCE_UNAUTHORIZED', '选择或预览已过期，请重新选择并预览')
    return value
  }
  function current(ctx: PlanningContext, expected: number) {
    ctx.assertCurrent()
    const document = repo.read(ctx.scope.root)
    if (document.revision !== expected) throw new PlanningError('CONFLICT', '计划已更新，请保留选择并重新预览', document.revision)
    return document
  }
  return {
    clearOwner(owner: number) { for (const [id, session] of sessions) if (session.owner === owner) sessions.delete(id) },
    select(ctx: PlanningContext, owner: number, fileName: string, bytes: Buffer): PlanningImportSelection {
      assertPlanningBytes(bytes.length)
      if (!isUtf8(bytes)) throw new PlanningError('BAD_REQUEST', '导入文件必须为有效UTF-8，未替换或丢弃字符')
      const source = decodePlanningExchange(bytes.toString('utf8').replace(/^\uFEFF/, ''))
      const problems = planningReferenceReport(readHost, source.document.items)
      if (problems.count) source.warnings.push(`选入时发现${problems.count}个失联的宿主资料关联；标识原样保留，不自动创建或删除资料。以下最多显示500个：`, ...problems.examples)
      const importId = add(ctx, owner, { kind: 'import', document: source.document })
      const counts = new Map<string, number>()
      source.document.items.forEach(item => counts.set(item.collectionId, (counts.get(item.collectionId) ?? 0) + 1))
      return { importId, fileName, format: source.format, sha256: hash(bytes), bytes: bytes.length, itemCount: source.document.items.length, typeCount: source.document.types.length, brokenReferenceCount: problems.count, collections: source.document.collections.map(c => ({ id: c.id, name: c.name, count: counts.get(c.id) ?? 0 })), warnings: source.warnings }
    },
    preview(ctx: PlanningContext, owner: number, id: string, expected: number, options: PlanningImportOptions) {
      const selected = get(ctx, owner, id)
      if (selected.kind !== 'import') throw new PlanningError('BAD_REQUEST')
      const before = current(ctx, expected), result = mergePlanningExchange(before, selected.document, options), token = randomUUID()
      selected.preview = { token, before: hash(JSON.stringify(before)), next: result.document, counts: result.counts }
      const existing = new Map(before.items.map(item => [item.id, item]))
      const summary = ({ title, kind, archived, deleted, updatedAt }: PlanningDocument['items'][number]) => ({ title, kind, archived, deleted, updatedAt })
      const duplicates = selected.document.items.flatMap(item => { const previous = existing.get(item.id); return previous ? [{ id: item.id, before: summary(previous), incoming: summary(item), bodyChanged: previous.content !== item.content }] : [] })
      return { ...state(ctx, expected), previewToken: token, counts: result.counts, totalAfter: result.document.items.length, duplicates }
    },
    difference(ctx: PlanningContext, owner: number, id: string, token: string, expected: number, itemId: string) {
      const selected = get(ctx, owner, id)
      if (selected.kind !== 'import' || !selected.preview || selected.preview.token !== token) throw new PlanningError('CONFLICT', '请按当前选项重新预览')
      const document = current(ctx, expected)
      if (hash(JSON.stringify(document)) !== selected.preview.before) throw new PlanningError('CONFLICT', '计划已变化，请重新预览')
      const before = document.items.find(item => item.id === itemId), incoming = selected.document.items.find(item => item.id === itemId)
      if (!before || !incoming) throw new PlanningError('NOT_FOUND', '重复记录不存在')
      return structuredClone({ before, incoming })
    },
    apply(ctx: PlanningContext, owner: number, id: string, token: string, expected: number) {
      const selected = get(ctx, owner, id)
      if (selected.kind !== 'import' || !selected.preview || selected.preview.token !== token) throw new PlanningError('CONFLICT', '请先按当前选项重新预览')
      const before = current(ctx, expected), preview = selected.preview
      if (preview.next.revision !== expected + 1 || hash(JSON.stringify(before)) !== preview.before) throw new PlanningError('CONFLICT', '预览后计划已变化，整份未写入')
      const next = repo.commit(ctx.scope.root, expected, preview.next, () => ctx.assertCurrent())
      sessions.delete(id)
      return { ...state(ctx, next.revision), counts: preview.counts }
    },
    exportPreview(ctx: PlanningContext, owner: number, expected: number, format: PlanningExportFormat) {
      const document = current(ctx, expected), text = serializePlanningExchange(document, format), bytes = Buffer.from(text, 'utf8')
      assertPlanningBytes(bytes.length)
      const previewToken = add(ctx, owner, { kind: 'export', before: hash(JSON.stringify(document)), bytes, format })
      return { ...state(ctx, expected), previewToken, format, sha256: hash(bytes), bytes: bytes.length, itemCount: document.items.length, text }
    },
    exportPayload(ctx: PlanningContext, owner: number, token: string, expected: number) {
      const selected = get(ctx, owner, token)
      if (selected.kind !== 'export' || hash(JSON.stringify(current(ctx, expected))) !== selected.before) throw new PlanningError('CONFLICT', '导出内容已有变化，请重新预览')
      return { bytes: selected.bytes, format: selected.format }
    },
    finishExport(owner: number, token: string) { if (sessions.get(token)?.owner === owner) sessions.delete(token) }
  }
}
