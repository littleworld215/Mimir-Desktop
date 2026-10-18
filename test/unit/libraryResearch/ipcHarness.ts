import { vi } from 'vitest'
import { EventEmitter } from 'node:events'
import type { BrowserWindow } from 'electron'
import { RESEARCH_CHANNELS, type ResearchApi } from '../../../shared/libraryResearchContracts'
import { registerLibraryResearchHandlers } from '../../../electron/ipc/libraryResearch'
import { createResearchRuntime } from '../../../electron/library/research/runtime'
import { createEvidenceSourceService } from '../../../electron/library/evidence/source'
import { WorkspaceOperationGate } from '../../../electron/workspaceBackup/operationGate'
import { savePack } from '../../../electron/library/research/packService'
import { materialFixture } from './fixtures'

type Handler = (event: unknown, value: unknown) => Promise<unknown>
const handlers = vi.hoisted(() => new Map<string, Handler>())
export const registeredResearch = () => handlers
vi.mock('electron', () => ({ ipcMain: { handle: (name: string, handler: Handler) => handlers.set(name, handler) } }))
export function researchIpcHarness() {
  handlers.clear()
  const f = materialFixture(), saved = savePack(f.ctx, { input: f.packInput, expectedRevision: 2, expectedEvidenceRevision: 1 })
  const state = { closed: false, path: undefined as string | undefined, beforeDialogReturn: undefined as (() => void | Promise<void>) | undefined }
  const sender = Object.assign(new EventEmitter(), { mainFrame: {}, isDestroyed: () => state.closed })
  const win = { isDestroyed: () => state.closed, webContents: sender }
  const event = { sender, senderFrame: sender.mainFrame }, scope = { workspaceId: f.ctx.scope.id, spaceEpoch: f.ctx.scope.epoch }
  const gate = new WorkspaceOperationGate(), source = { ...createEvidenceSourceService(), sourceObservations: () => new Map(f.observations) }
  const runtime = createResearchRuntime({ gate, capture: () => f.ctx.scope, catalog: f.ctx.catalog, source })
  registerLibraryResearchHandlers({ windowRef: { current: win as unknown as BrowserWindow }, runtime, selectExportPath: async () => { await state.beforeDialogReturn?.(); return state.path } })
  const call = async <K extends keyof ResearchApi>(name: K, payload: unknown, supplied: unknown = event): Promise<Awaited<ReturnType<ResearchApi[K]>>> => await handlers.get(RESEARCH_CHANNELS[name])!(supplied, payload) as Awaited<ReturnType<ResearchApi[K]>>
  const exportRequest = { scope, packId: saved.pack.id, packVersion: 1, expectedRevision: 3, expectedEvidenceRevision: 1 }
  return { ...f, saved, state, gate, source, runtime, event, sender, scope, call, exportRequest }
}
