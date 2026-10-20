import { createHash, randomUUID } from 'node:crypto'
import { z } from 'zod'
import type { PlanningDocument, PlanningExportFormat, PlanningImportOptions, PlanningItem, PlanningKind } from '../../shared/researchPlanningContracts'
import { PLANNING_MAX_ITEMS } from '../../shared/researchPlanningContracts'
import { emptyPlanningInput, PLANNING_KIND_LABELS } from '../../shared/researchPlanningDefaults'
import { assertPlanningBytes, parsePlanningDocument, planningDate, PlanningError } from './validation'

const id = z.string().min(1).max(1000), nullableDate = planningDate.nullable()
const timestamp = z.number().int().min(0).max(253402300799999)
const foreignType = z.object({ id, name: z.string().min(1).max(200), kind: z.enum(['generic', 'todo', 'schedule', 'direction', 'project']), icon: z.string().max(500), note: z.string().max(500), builtin: z.boolean() }).strict()
const foreignRecord = z.object({
  id, typeId: id, workspaceId: id, title: z.string().min(1).max(500), content: z.string().max(100_000), status: z.enum(['planned', 'active', 'paused', 'done']), starred: z.boolean(), archived: z.boolean(),
  fields: z.array(z.object({ id, name: z.string().max(200), value: z.string().max(16_000) }).strict()).max(50), priority: z.enum(['none', 'low', 'medium', 'high']), dueDate: nullableDate, done: z.boolean(),
  planDate: nullableDate, planStart: z.string().nullable(), planEnd: z.string().nullable(), sub: z.enum(['vertical', 'horizontal']).nullable().optional(),
  projectId: id.nullable().optional(), recurrence: z.object({ frequency: z.enum(['daily', 'weekly', 'monthly']), interval: z.number().int().min(1).max(99) }).strict().nullable().optional(),
  literature: z.object({ authors: z.string().max(100_000), year: z.number().int().min(1).max(9999).nullable(), doi: z.string().max(2000), url: z.string().max(4000), readingStatus: z.enum(['unread', 'reading', 'read']) }).strict().nullable().optional(),
  createdAt: timestamp, updatedAt: timestamp, order: z.number().finite().optional()
}).strict()
const external = z.object({ app: z.literal('research-workbench'), version: z.union([z.literal(1), z.literal(2)]), exportedAt: z.string().datetime(), records: z.array(foreignRecord).max(PLANNING_MAX_ITEMS), types: z.array(foreignType).min(1).max(200), workspaces: z.array(z.object({ id, name: z.string().min(1).max(200), builtin: z.boolean() }).strict()).min(1).max(200), settings: z.unknown().optional() }).strict()
const importedId = (kind: string, id: string) => `rw:${createHash('sha256').update(JSON.stringify([kind, id])).digest('hex').slice(0, 40)}`
function unique(values: { id: string }[]) { if (new Set(values.map(v => v.id)).size !== values.length) throw new PlanningError('BAD_REQUEST', '导入标识重复，整份未写入') }
export function decodePlanningExchange(text: string): { format: string; document: PlanningDocument; warnings: string[] } {
  assertPlanningBytes(Buffer.byteLength(text))
  let raw: unknown
  try { raw = JSON.parse(text) } catch { throw new PlanningError('BAD_REQUEST', '文件不是有效JSON，整份未写入') }
  if (raw && typeof raw === 'object' && 'app' in raw && raw.app === 'mimir-research-planning') {
    const parsed = z.object({ app: z.literal('mimir-research-planning'), version: z.literal(1), exportedAt: z.string().datetime(), document: z.unknown() }).strict().safeParse(raw)
    if (!parsed.success) throw new PlanningError('UNSUPPORTED_VERSION', '本项目交换格式不受支持')
    return { format: 'Mimir科研计划JSON v1', document: parsePlanningDocument(parsed.data.document), warnings: ['完整业务JSON包含归档和回收站；草稿、提醒去重和文件由整空间备份保存。'] }
  }
  const parsed = external.safeParse(raw)
  if (!parsed.success) throw new PlanningError('BAD_REQUEST', '仅支持Research-Workbench JSON v1/v2或本项目业务JSON，字段非法时整份拒绝')
  const source = parsed.data
  unique(source.records); unique(source.types); unique(source.workspaces)
  const definitions = new Map(source.types.map(t => [t.id, t])), groups = new Set(source.workspaces.map(w => w.id))
  const sourceItems = new Map(source.records.map(r => [r.id, r]))
  const warnings = ['外部设置不会修改托盘、自启、通知或模型配置。', '外部今日重点转为重要标记，不自动安排到我的一天；待办完成状态按done字段归一。']
  const types = source.types.map((t, order) => ({ id: importedId('type', t.id), name: t.name, kind: t.kind as PlanningKind, builtin: false, order, deleted: false }))
  const literatureTypes = new Map<string, string>()
  const items: PlanningItem[] = source.records.map(record => {
    const definition = definitions.get(record.typeId)
    if (!definition || !groups.has(record.workspaceId)) throw new PlanningError('BAD_REQUEST', '导入记录缺少类型或分组，整份拒绝')
    const kind: PlanningKind = record.literature && definition.kind === 'generic' ? 'literature' : definition.kind
    if (record.literature && kind !== 'literature') throw new PlanningError('BAD_REQUEST', '文献元信息与来源类型不兼容，请核对源文件；未丢弃字段')
    let typeId = importedId('type', record.typeId)
    if (kind === 'literature') {
      if (!literatureTypes.has(record.typeId)) {
        typeId = importedId('literatureType', record.typeId); literatureTypes.set(record.typeId, typeId)
        types.push({ id: typeId, name: definition.name, kind, builtin: false, order: types.length, deleted: false })
      } else typeId = literatureTypes.get(record.typeId)!
    }
    const fields = record.fields.map(f => ({ ...f, id: importedId(`field:${record.id}`, f.id) }))
    let projectId: string | null = null
    if (record.projectId) {
      const parent = sourceItems.get(record.projectId)
      if (parent && definitions.get(parent.typeId)?.kind === 'project' && record.projectId !== record.id) projectId = importedId('record', record.projectId)
      else { fields.push({ id: importedId('lostProject', record.id), name: '导入时失联的原始项目标识', value: record.projectId }); warnings.push(`「${record.title}」的原项目已失联，原标识保存在自定义字段。`) }
    }
    const item: PlanningItem = {
      ...emptyPlanningInput(kind), id: importedId('record', record.id), typeId, collectionId: importedId('collection', record.workspaceId), title: record.title, content: record.content,
      status: kind === 'todo' ? record.done ? 'done' : record.status === 'done' ? 'active' : record.status : record.status, important: record.starred, archived: record.archived, fields, priority: record.priority, dueDate: record.dueDate, done: record.done,
      schedule: record.planDate ? { date: record.planDate, start: record.planStart, end: record.planEnd } : null,
      recurrence: record.recurrence ? { unit: record.recurrence.frequency, interval: record.recurrence.interval } : null,
      projectId, projectCategory: kind === 'project' ? record.sub ?? 'other' : null,
      literature: record.literature ? { authors: record.literature.authors ? record.literature.authors.split('\n') : [], year: record.literature.year, doi: record.literature.doi, url: record.literature.url, readingState: record.literature.readingStatus, paperId: null } : null,
      createdAt: new Date(record.createdAt).toISOString(), updatedAt: new Date(record.updatedAt).toISOString(), order: record.order ?? 0
    }
    if (!record.planDate && (record.planStart || record.planEnd)) throw new PlanningError('BAD_REQUEST', '日程缺少日期，未丢弃时间字段')
    return item
  })
  const document = parsePlanningDocument({ schemaVersion: 1, revision: 0, types, collections: source.workspaces.map((w, order) => ({ id: importedId('collection', w.id), name: w.name, order, deleted: false })), items })
  return { format: `Research-Workbench JSON v${source.version}`, document, warnings }
}
export function mergePlanningExchange(current: PlanningDocument, incoming: PlanningDocument, options: PlanningImportOptions) {
  const next = structuredClone(current), itemIds = new Map<string, string>(), existing = new Map(current.items.map(i => [i.id, i]))
  const counts = { added: 0, updated: 0, skipped: 0, copied: 0 }
  for (const item of incoming.items) {
    const previous = existing.get(item.id)
    if (previous && previous.kind !== item.kind && options.strategy === 'update') throw new PlanningError('CONFLICT', '更新不能改变已有记录类型，请选择保留副本或跳过')
    itemIds.set(item.id, previous && options.strategy === 'copy' ? randomUUID() : item.id)
  }
  const collectionIds = new Map<string, string>()
  for (const collection of incoming.collections) {
    const target = Object.hasOwn(options.collections, collection.id) ? options.collections[collection.id] : undefined
    if (target && !current.collections.some(c => c.id === target && !c.deleted)) throw new PlanningError('BAD_REQUEST', '所选分组已失效，请重新预览')
    collectionIds.set(collection.id, target ?? collection.id)
    if (!target && !next.collections.some(c => c.id === collection.id)) next.collections.push(structuredClone(collection))
  }
  for (const type of incoming.types) {
    const previous = next.types.find(t => t.id === type.id)
    if (previous && previous.kind !== type.kind) throw new PlanningError('CONFLICT', '同一类型标识含义不同，整份未写入')
    if (!previous) next.types.push(structuredClone(type))
  }
  const positions = new Map(next.items.map((item, index) => [item.id, index]))
  for (const item of incoming.items) {
    const previous = existing.get(item.id)
    if (previous && options.strategy === 'skip') { counts.skipped++; continue }
    const value = { ...structuredClone(item), id: itemIds.get(item.id)!, collectionId: collectionIds.get(item.collectionId)!, projectId: item.projectId ? itemIds.get(item.projectId) ?? item.projectId : null, directionId: item.directionId ? itemIds.get(item.directionId) ?? item.directionId : null, ...(item.recurrenceParentId ? { recurrenceParentId: itemIds.get(item.recurrenceParentId) ?? item.recurrenceParentId } : {}) }
    if (previous && options.strategy === 'update') { value.createdAt = previous.createdAt; next.items[positions.get(item.id)!] = value; counts.updated++ }
    else { next.items.push(value); if (previous) counts.copied++; else counts.added++ }
  }
  next.revision = current.revision + 1
  return { document: parsePlanningDocument(next), counts }
}
const html = (value: string) => value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
const markdown = (value: string) => value.replace(/[\\`*_{}\[\]()#!|<>]/g, '\\$&').replace(/[\r\n]+/g, ' ')
const csv = (value: string) => `"${(/^[\s\u0000-\u001f\u007f]*[=+\-@]|^[\t\r\n]/u.test(value) ? "'" + value : value).replace(/"/g, '""')}"`
export function serializePlanningExchange(document: PlanningDocument, format: PlanningExportFormat) {
  parsePlanningDocument(document)
  if (format === 'json') return JSON.stringify({ app: 'mimir-research-planning', version: 1, exportedAt: new Date().toISOString(), document })
  const metadata = (item: PlanningItem) => JSON.stringify(Object.fromEntries(Object.entries(item).filter(([key]) => key !== 'content' && key !== 'title')), null, 2)
  if (format === 'markdown') return '# Mimir科研计划导出\n\n包含归档和回收站。完整交换请使用JSON；以下保留Markdown正文原文。\n\n' + document.items.map(item => `## ${markdown(item.title)}\n\n类型：${PLANNING_KIND_LABELS[item.kind]}\n\n<details><summary>完整元信息</summary>\n\n\`\`\`json\n${metadata(item).replace(/`/g, '\\u0060')}\n\`\`\`\n\n</details>\n\n${item.content}\n\n`).join('')
  if (format === 'csv') return '\uFEFF' + [['id', 'title', 'kind', 'content', '完整元信息'], ...document.items.map(item => [item.id, item.title, item.kind, item.content, metadata(item)])].map(row => row.map(csv).join(',')).join('\r\n') + '\r\n'
  return '<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src \'none\'; style-src \'unsafe-inline\'"><title>Mimir科研计划</title><style>body{max-width:960px;margin:32px auto;padding:16px;font:16px/1.7 system-ui}pre{white-space:pre-wrap;overflow-wrap:anywhere;border:1px solid #bbb;padding:12px}article{margin:32px 0}</style></head><body><h1>Mimir科研计划导出</h1><p>包含归档和回收站；正文按原文展示，无脚本、图片或联网内容。</p>' + document.items.map(item => `<article><h2>${html(item.title)}</h2><p>${html(PLANNING_KIND_LABELS[item.kind])}</p><pre>${html(item.content)}</pre><details><summary>完整元信息</summary><pre>${html(metadata(item))}</pre></details></article>`).join('') + '</body></html>'
}
