import { it, expect, vi } from 'vitest'
import type { AssetsApi } from '../../shared/assetsContracts'
const state = vi.hoisted(() => ({ exposed: new Map<string, unknown>(), invoke: vi.fn().mockResolvedValue({ ok: true }) }))
vi.mock('electron', () => ({
  contextBridge: { exposeInMainWorld: (name: string, api: unknown) => state.exposed.set(name, api) },
  ipcRenderer: { invoke: state.invoke }
}))
import '../../electron/preload'
import { ASSETS_CHANNELS } from '../../shared/assetsContracts'
it('普通维护桥仅暴露无参数交接请求，不开放归档路径或维护读写方法', async () => {
  const api = (state.exposed.get('electronAPI') as { workspaceBackup?: { enterMaintenance(): Promise<unknown> } }).workspaceBackup
  expect(api).toBeDefined()
  expect(Object.keys(api!)).toEqual(['enterMaintenance'])
  state.invoke.mockClear()
  await api!.enterMaintenance()
  expect(state.invoke).toHaveBeenCalledTimes(1)
  expect(state.invoke).toHaveBeenCalledWith('workspaceBackup:enterMaintenance')
})
it('实际preload暴露完整固定方法（包含旧32及交换入口），原样传递请求且context无参数', async () => {
  const api = (state.exposed.get('electronAPI') as { assets: AssetsApi }).assets
  expect(Object.keys(api).sort()).toEqual(Object.keys(ASSETS_CHANNELS).sort())
  const request = { workspaceId: 'A', spaceEpoch: 'A#1', expectedRevision: 1, expectedCurrentVersionId: null, patch: { content: '' } }
  for (const key of Object.keys(ASSETS_CHANNELS) as (keyof AssetsApi)[]) {
    state.invoke.mockClear()
    if (key === 'context') { await api.context(); expect(state.invoke).toHaveBeenCalledWith(ASSETS_CHANNELS.context) }
    else {
      await (api[key] as (req: unknown) => Promise<unknown>)(request)
      expect(state.invoke).toHaveBeenCalledWith(ASSETS_CHANNELS[key], request)
    }
  }
})
