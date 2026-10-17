import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { EventEmitter } from 'node:events'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { updateEvidence } from '../../electron/library/evidence/service'
import { registerLibraryEvidenceHandlers } from '../../electron/ipc/libraryEvidence'
import { createEvidenceRuntime } from '../../electron/library/evidence/runtime'
import { WorkspaceOperationGate } from '../../electron/workspaceBackup/operationGate'
import { EVIDENCE_CHANNELS } from '../../shared/libraryEvidenceContracts'
import { fields, fixture } from '../unit/libraryEvidence/fixtures'
const registered = vi.hoisted(() => new Map<string, (...args: any[]) => Promise<any>>())
vi.mock('electron', () => ({ ipcMain: { handle: (name: string, fn: any) => registered.set(name, fn) } }))
const fixtures: ReturnType<typeof fixture>[] = []
let event: any, scope: { workspaceId: string; spaceEpoch: string }, closed: boolean
let currentFixture: ReturnType<typeof fixture>, exportPath: string | undefined, beforeDialogReturn: (() => void) | undefined
beforeEach(() => {
  registered.clear(); closed = false
  const f = fixture(); fixtures.push(f); currentFixture = f; exportPath = undefined; beforeDialogReturn = undefined
  const sender = Object.assign(new EventEmitter(), { mainFrame: {}, isDestroyed: () => closed })
  const win = { isDestroyed: () => closed, webContents: sender }
  event = { sender, senderFrame: sender.mainFrame }
  scope = { workspaceId: f.ctx.scope.id, spaceEpoch: f.ctx.scope.epoch }
  const runtime = createEvidenceRuntime({ gate: new WorkspaceOperationGate(), capture: () => f.ctx.scope, catalog: f.ctx.catalog })
  registerLibraryEvidenceHandlers({ windowRef: { current: win as any }, runtime, selectExportPath: async () => { beforeDialogReturn?.(); return exportPath } })
})
afterEach(() => fixtures.splice(0).forEach(f => f.clean()))
const call = (name: keyof typeof EVIDENCE_CHANNELS, payload: unknown, sender = event) => registered.get(EVIDENCE_CHANNELS[name])!(sender, payload)
const initial = () => ({ filter: { archive: 'exclude', source: 'all' }, page: 1 })
async function saveExport(request: Record<string, unknown>) {
  const preview = await call('export', { ...request, mode: 'preview' })
  if (!preview.ok) return preview
  expect(preview.previewToken).toMatch(/^[a-f0-9]{64}$/)
  return call('export', { ...request, mode: 'save', previewToken: preview.previewToken })
}

it('第五批完整注册八条，保留旧通道，不添加任意路径入口', () => {
  expect([...registered.keys()].sort()).toEqual(Object.values(EVIDENCE_CHANNELS).sort())
})
it('导出预览和原生授权：取消/已有目标/伪造路径不覆盖任何用户资料', async () => {
  await call('create', { scope, expectedRevision: 0, input: fields() })
  const request = { scope, expectedRevision: 1, filter: initial().filter, format: 'json', includeHistory: true, mode: 'preview' }
  expect(await call('export', request)).toMatchObject({ ok: true, cardCount: 1, versionCount: 1, saved: false })
  expect(await call('export', { ...request, path: 'C:/secret' })).toMatchObject({ ok: false, code: 'BAD_REQUEST' })
  expect(await saveExport(request)).toMatchObject({ ok: true, canceled: true, saved: false })
  exportPath = join(currentFixture.root, 'user.json'); writeFileSync(exportPath, '用户资料')
  expect(await saveExport(request)).toMatchObject({ ok: false, code: 'WRITE_FAILED' })
  expect(readFileSync(exportPath, 'utf8')).toBe('用户资料')
})
it('原生保存对话返回后重验revision与scope，不保存旧范围', async () => {
  const created = await call('create', { scope, expectedRevision: 0, input: fields() })
  const request = { scope, expectedRevision: 1, filter: initial().filter, format: 'csv', mode: 'save' }
  exportPath = join(currentFixture.root, 'new.csv')
  beforeDialogReturn = () => { updateEvidence(currentFixture.ctx, created.card.id, { ...fields(), comment: '并发修改' }, 1) }
  expect(await saveExport(request)).toMatchObject({ ok: false, code: 'CONFLICT' })
  expect(existsSync(exportPath)).toBe(false)
  beforeDialogReturn = () => { currentFixture.ctx.scope.epoch = 'new' }
  expect(await saveExport({ ...request, expectedRevision: 2 })).toMatchObject({ ok: false, code: 'SPACE_CHANGED' })
  expect(existsSync(exportPath)).toBe(false)
})
it('选择保存文件期间来源筛选变化，即使证据revision未变也不能导出旧范围', async () => {
  await call('create', { scope, expectedRevision: 0, input: fields() })
  exportPath = join(currentFixture.root, 'source-problems.json')
  beforeDialogReturn = () => { currentFixture.ctx.catalog.papers = () => [] }
  const request = { scope, expectedRevision: 1, filter: { archive: 'exclude', source: 'problem' }, format: 'json', mode: 'save', includeHistory: true }
  expect(await saveExport(request)).toMatchObject({ ok: false, code: 'CONFLICT' })
  expect(existsSync(exportPath)).toBe(false)
})
it('主窗口主框架独占；伪sender、iframe、销毁窗口拒绝', async () => {
  for (const fake of [{}, { sender: {} }, { sender: event.sender, senderFrame: {} }]) expect(await call('list', initial(), fake)).toMatchObject({ ok: false, code: 'BAD_REQUEST' })
  closed = true
  expect(await call('list', initial())).toMatchObject({ ok: false, code: 'BAD_REQUEST' })
})
it('初始读取不开放任意范围；严格DTO与page，不接受路径或伪scope', async () => {
  expect(await call('list', initial())).toMatchObject({ ok: true, scope, revision: 0, rows: [{ paperId: fields().paperId, cards: [] }], pageSize: 50 })
  for (const payload of [null, [], {}, { ...initial(), root: 'C:/secret' }, { ...initial(), page: 0 }, { ...initial(), page: 1.5 }, { ...initial(), page: '1' }, { ...initial(), filter: { archive: 'include', source: 'all' } }, { ...initial(), filter: { archive: 'exclude', source: 'all', projectId: 'project-1' } }]) expect(await call('list', payload)).toMatchObject({ ok: false, code: 'BAD_REQUEST' })
  expect(await call('list', { ...initial(), scope: { ...scope, spaceEpoch: 'old' } })).toMatchObject({ ok: false, code: 'SPACE_CHANGED' })
})
it('快照/binding不信任renderer；完整写后读带revision且错误无本机路径', async () => {
  for (const input of [{ ...fields(), documentBinding: { sha256: 'a'.repeat(64) } }, { ...fields(), paperSnapshot: {} }]) expect(await call('create', { scope, expectedRevision: 0, input })).toMatchObject({ ok: false, code: 'BAD_REQUEST' })
  const created = await call('create', { scope, expectedRevision: 0, input: fields() })
  expect(created).toMatchObject({ ok: true, revision: 1, card: { currentVersion: 1 } })
  expect(await call('detail', { scope, cardId: created.card.id })).toMatchObject({ ok: true, revision: 1, card: created.card })
  expect(await call('archive', { scope, cardId: created.card.id, archived: true, expectedRevision: 0 })).toMatchObject({ ok: false, code: 'CONFLICT', currentRevision: 1 })
  for (const [name, payload] of [['detail', { scope, cardId: created.card.id, path: 'secret' }], ['checkSource', { scope, cardId: created.card.id, mode: 'confirm', expectedRevision: 1, sha256: 'a'.repeat(64) }]] as const) {
    const reply = await call(name, payload)
    expect(reply).toMatchObject({ ok: false, code: 'BAD_REQUEST' })
    expect(JSON.stringify(reply)).not.toContain('secret')
  }
})
