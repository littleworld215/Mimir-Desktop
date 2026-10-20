import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { EventEmitter } from 'node:events'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { BrowserWindow } from 'electron'
import { PLANNING_CHANNELS } from '../../shared/researchPlanningContracts'
import { registerResearchPlanningHandlers } from '../../electron/ipc/researchPlanning'
import { createPlanningRuntime } from '../../electron/researchPlanning/runtime'
import { WorkspaceOperationGate } from '../../electron/workspaceBackup/operationGate'
import { emptyPlanningInput } from '../../electron/researchPlanning/validation'

type Handler = (event: unknown, value: unknown) => Promise<unknown>
const handlers = vi.hoisted(() => new Map<string, Handler>())
vi.mock('electron', () => ({ ipcMain: { handle: (name: string, handler: Handler) => handlers.set(name, handler) } }))
let root: string, current = true, closed = false
const sender = Object.assign(new EventEmitter(), { mainFrame: {}, isDestroyed: () => closed })
const event = { sender, senderFrame: sender.mainFrame }, scope = { workspaceId: 'space', spaceEpoch: 'epoch' }
beforeEach(() => {
  handlers.clear(); current = true; closed = false
  root = mkdtempSync(join(tmpdir(), 'mimir-planning-'))
  const runtime = createPlanningRuntime({ gate: new WorkspaceOperationGate(), capture: () => ({ id: current ? 'space' : 'another', epoch: 'epoch', root }) })
  registerResearchPlanningHandlers({ windowRef: { current: { webContents: sender, isDestroyed: () => closed } as unknown as BrowserWindow }, runtime })
})
afterEach(() => rmSync(root, { recursive: true, force: true }))
const call = (name: keyof typeof PLANNING_CHANNELS, input: unknown, supplied: unknown = event) => handlers.get(PLANNING_CHANNELS[name])!(supplied, input)
it('四个固定底座接口；启动不收路径，列表必须有当前scope', async () => {
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
