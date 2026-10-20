import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { EventEmitter } from 'node:events'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { BrowserWindow } from 'electron'
import { PLANNING_CHANNELS } from '../../shared/researchPlanningContracts'
import { registerResearchPlanningHandlers } from '../../electron/ipc/researchPlanning'
import { createPlanningRuntime } from '../../electron/researchPlanning/runtime'
import { WorkspaceOperationGate } from '../../electron/workspaceBackup/operationGate'
import { emptyPlanningInput } from '../../electron/researchPlanning/validation'
import { emptyPlanningDocument } from '../../shared/researchPlanningDefaults'
import { serializePlanningExchange } from '../../electron/researchPlanning/exchange'

type Handler = (event: unknown, value: unknown) => Promise<unknown>
const handlers = vi.hoisted(() => new Map<string, Handler>())
vi.mock('electron', () => ({ ipcMain: { handle: (name: string, handler: Handler) => handlers.set(name, handler) } }))
let root: string, current = true, closed = false
let importPath: string | undefined, exportPath: string | undefined, beforeExport: (() => Promise<void>) | undefined
const sender = Object.assign(new EventEmitter(), { mainFrame: {}, isDestroyed: () => closed })
const event = { sender, senderFrame: sender.mainFrame }, scope = { workspaceId: 'space', spaceEpoch: 'epoch' }
beforeEach(() => {
  handlers.clear(); current = true; closed = false; importPath = undefined; exportPath = undefined; beforeExport = undefined
  root = mkdtempSync(join(tmpdir(), 'mimir-planning-'))
  const runtime = createPlanningRuntime({ gate: new WorkspaceOperationGate(), capture: () => ({ id: current ? 'space' : 'another', epoch: 'epoch', root }) })
  registerResearchPlanningHandlers({ windowRef: { current: { webContents: sender, isDestroyed: () => closed } as unknown as BrowserWindow }, runtime, selectImportPath: async () => importPath, selectExportPath: async () => { await beforeExport?.(); return exportPath } })
})
afterEach(() => rmSync(root, { recursive: true, force: true }))
const call = (name: keyof typeof PLANNING_CHANNELS, input: unknown, supplied: unknown = event) => handlers.get(PLANNING_CHANNELS[name])!(supplied, input)
it('固定白名单接口；启动不收路径，列表必须有当前scope', async () => {
  expect([...handlers.keys()].sort()).toEqual(Object.values(PLANNING_CHANNELS).sort())
  expect(await call('bootstrap', {})).toMatchObject({ ok: true, revision: 0, total: 0, scope })
  for (const input of [null, [], { path: 'C:/secret' }]) expect(await call('bootstrap', input)).toMatchObject({ ok: false, code: 'BAD_REQUEST' })
  expect(await call('list', { filter: {}, page: 1 })).toMatchObject({ ok: false, code: 'BAD_REQUEST' })
  expect(await call('list', { scope: { ...scope, spaceEpoch: 'old' }, filter: {}, page: 1 })).toMatchObject({ ok: false, code: 'SPACE_CHANGED' })
})
it('主窗口主框架独占，iframe/其它sender/已关闭窗口拒绝', async () => {
  for (const supplied of [{}, { sender: {} }, { sender, senderFrame: {} }]) expect(await call('bootstrap', {}, supplied)).toMatchObject({ ok: false, code: 'BAD_REQUEST' })
  closed = true; expect(await call('bootstrap', {})).toMatchObject({ ok: false, code: 'BAD_REQUEST' })
})
it('写后分页读，修订冲突及空间变化均明确反馈', async () => {
  const input = { ...emptyPlanningInput('todo'), title: '合成待办' }
  expect(await call('save', { scope, expectedRevision: 0, input })).toMatchObject({ ok: true, revision: 1, item: { title: '合成待办' } })
  expect(await call('list', { scope, filter: {}, page: 1 })).toMatchObject({ ok: true, total: 1, pageSize: 50 })
  expect(await call('save', { scope, expectedRevision: 0, input })).toMatchObject({ ok: false, code: 'CONFLICT', currentRevision: 1 })
  expect(await call('save', { scope, expectedRevision: 1, input: { ...input, root: 'C:/secret' } })).toMatchObject({ ok: false, code: 'BAD_REQUEST' })
  current = false
  expect(await call('save', { scope, expectedRevision: 1, input })).toMatchObject({ ok: false, code: 'SPACE_CHANGED' })
})
it('恢复草稿三接口绑定当前空间；不接受路径或伪造时间，删除冲突不清空', async () => {
  const draft = { id: 'draft', itemId: null, baseRevision: 0, input: emptyPlanningInput('generic') }
  expect(await call('saveDraft', { scope, expectedRevision: 0, draft })).toMatchObject({ ok: true, revision: 1 })
  expect(await call('drafts', { scope })).toMatchObject({ ok: true, drafts: [{ id: 'draft' }] })
  expect(await call('saveDraft', { scope, expectedRevision: 1, draft: { ...draft, updatedAt: 'fake' } })).toMatchObject({ ok: false, code: 'BAD_REQUEST' })
  expect(await call('removeDraft', { scope, expectedRevision: 0, draftId: 'draft' })).toMatchObject({ ok: false, code: 'CONFLICT' })
  expect(await call('removeDraft', { scope, expectedRevision: 1, draftId: 'draft', path: 'C:/private' })).toMatchObject({ ok: false, code: 'BAD_REQUEST' })
  current = false
  expect(await call('removeDraft', { scope, expectedRevision: 1, draftId: 'draft' })).toMatchObject({ ok: false, code: 'SPACE_CHANGED' })
})
it('原生选入后预览/一次提交，renderer不能指定路径；原生导出取消及窗口期间变化均零落盘', async () => {
  const doc = emptyPlanningDocument()
  doc.items.push({ ...emptyPlanningInput('generic'), id: 'imported', title: '合成导入', createdAt: '2026-10-21T00:00:00.000Z', updatedAt: '2026-10-21T00:00:00.000Z' })
  importPath = join(root, 'selected.json'); writeFileSync(importPath, serializePlanningExchange(doc, 'json'))
  expect(await call('selectImport', { scope, path: importPath })).toMatchObject({ ok: false, code: 'BAD_REQUEST' })
  const selected = await call('selectImport', { scope }) as { ok: boolean; selection: { importId: string } }
  const importId = selected.selection.importId
  const preview = await call('previewImport', { scope, expectedRevision: 0, importId, options: { strategy: 'skip', collections: {} } }) as { previewToken: string }
  expect(await call('list', { scope, filter: {}, page: 1 })).toMatchObject({ total: 0 })
  expect(await call('applyImport', { scope, expectedRevision: 0, importId, previewToken: preview.previewToken })).toMatchObject({ ok: true, revision: 1 })
  const exported = await call('exportPreview', { scope, expectedRevision: 1, format: 'json' }) as { previewToken: string }
  expect(await call('saveExport', { scope, expectedRevision: 1, previewToken: exported.previewToken })).toMatchObject({ ok: true, canceled: true, saved: false })
  exportPath = join(root, 'result.json')
  beforeExport = async () => { await call('save', { scope, expectedRevision: 1, input: { ...emptyPlanningInput('project'), title: '选路径期间变化' } }) }
  expect(await call('saveExport', { scope, expectedRevision: 1, previewToken: exported.previewToken })).toMatchObject({ ok: false, code: 'CONFLICT' })
  expect(existsSync(exportPath)).toBe(false)
  beforeExport = undefined
  const updated = await call('exportPreview', { scope, expectedRevision: 2, format: 'json' }) as { previewToken: string }
  expect(await call('saveExport', { scope, expectedRevision: 2, previewToken: updated.previewToken })).toMatchObject({ ok: true, saved: true, fileName: 'result.json' })
  expect(JSON.parse(readFileSync(exportPath, 'utf8')).document.items).toHaveLength(2)
  expect(await call('saveExport', { scope, expectedRevision: 2, previewToken: updated.previewToken })).toMatchObject({ ok: false })
})
