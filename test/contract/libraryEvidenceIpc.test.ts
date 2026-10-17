import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { EventEmitter } from 'node:events'
import { registerLibraryEvidenceHandlers } from '../../electron/ipc/libraryEvidence'
import { createEvidenceRuntime } from '../../electron/library/evidence/runtime'
import { WorkspaceOperationGate } from '../../electron/workspaceBackup/operationGate'
import { EVIDENCE_CHANNELS } from '../../shared/libraryEvidenceContracts'
import { fields, fixture } from '../unit/libraryEvidence/fixtures'
const registered = vi.hoisted(() => new Map<string, (...args: any[]) => Promise<any>>())
vi.mock('electron', () => ({ ipcMain: { handle: (name: string, fn: any) => registered.set(name, fn) } }))
const fixtures: ReturnType<typeof fixture>[] = []
let event: any, scope: { workspaceId: string; spaceEpoch: string }, closed: boolean
beforeEach(() => {
  registered.clear(); closed = false
  const f = fixture(); fixtures.push(f)
  const sender = Object.assign(new EventEmitter(), { mainFrame: {}, isDestroyed: () => closed })
  const win = { isDestroyed: () => closed, webContents: sender }
  event = { sender, senderFrame: sender.mainFrame }
  scope = { workspaceId: f.ctx.scope.id, spaceEpoch: f.ctx.scope.epoch }
  const runtime = createEvidenceRuntime({ gate: new WorkspaceOperationGate(), capture: () => f.ctx.scope, catalog: f.ctx.catalog })
  registerLibraryEvidenceHandlers({ windowRef: { current: win as any }, runtime })
})
afterEach(() => fixtures.splice(0).forEach(f => f.clean()))
const call = (name: keyof typeof EVIDENCE_CHANNELS, payload: unknown, sender = event) => registered.get(EVIDENCE_CHANNELS[name])!(sender, payload)
const initial = () => ({ filter: { archive: 'exclude', source: 'all' }, page: 1 })

it('本阶段精确注册七条，导出待第五批，不把常量数冒充接线数', () => {
  expect([...registered.keys()].sort()).toEqual(['list', 'detail', 'create', 'update', 'archive', 'checkSource', 'openSource'].map(name => `libraryEvidence:${name}`).sort())
})
it('主窗口主框架独占；伪sender、iframe、销毁窗口拒绝', async () => {
  for (const fake of [{}, { sender: {} }, { sender: event.sender, senderFrame: {} }]) expect(await call('list', initial(), fake)).toMatchObject({ ok: false, code: 'BAD_REQUEST' })
  closed = true
  expect(await call('list', initial())).toMatchObject({ ok: false, code: 'BAD_REQUEST' })
})
it('初始读取不开放任意范围；严格DTO与page，不接受路径或伪scope', async () => {
  expect(await call('list', initial())).toMatchObject({ ok: true, scope, revision: 0, rows: [], pageSize: 50 })
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
