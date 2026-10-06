import { it, expect, vi } from 'vitest'
import type { AssetsApi } from '../../shared/assetsContracts'
const state = vi.hoisted(() => ({ exposed: new Map<string, unknown>(), invoke: vi.fn().mockResolvedValue({ ok: true }) }))
vi.mock('electron', () => ({
  contextBridge: { exposeInMainWorld: (name: string, api: unknown) => state.exposed.set(name, api) },
  ipcRenderer: { invoke: state.invoke }
}))
import '../../electron/preload'
import { ASSETS_CHANNELS } from '../../shared/assetsContracts'
it('实际preload暴露32个固定方法（旧28加参见4），原样传递请求且context无参数', async () => {
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
