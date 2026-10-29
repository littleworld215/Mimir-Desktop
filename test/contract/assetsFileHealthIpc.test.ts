import { beforeEach, it, expect, vi } from 'vitest'
const state = vi.hoisted(() => ({ handlers: new Map<string, (...args: unknown[]) => unknown>(), run: vi.fn() }))
vi.mock('electron', () => ({ ipcMain: { handle: (name: string, fn: (...args: unknown[]) => unknown) => state.handlers.set(name, fn) } }))
vi.mock('../../electron/assets/store', () => ({ assetsStoreManager: { run: state.run } }))
vi.mock('../../electron/logger', () => ({ default: { error: vi.fn(), info: vi.fn(), warn: vi.fn() } }))
import { registerAssetsHandlers } from '../../electron/ipc/assets'
import { ASSETS_CHANNELS } from '../../shared/assetsContracts'
const request = { workspaceId: 'A', spaceEpoch: 'A#1' }, trusted = {}
beforeEach(() => { state.handlers.clear(); state.run.mockReset(); registerAssetsHandlers({ isTrustedSender: event => event === trusted }) })
const call = (event: unknown, input: unknown) => state.handlers.get(ASSETS_CHANNELS.inspectFileHealth)!(event, input)
it('只接受可信主窗口，缺省未提供发送者守卫也拒绝', async () => {
  expect(await call({}, request)).toMatchObject({ ok: false, code: 'BAD_REQUEST' }); expect(state.run).not.toHaveBeenCalled()
  registerAssetsHandlers()
  expect(await call(trusted, request)).toMatchObject({ ok: false, code: 'BAD_REQUEST' })
})
it('作用域非法不得进入资产任务，合法请求必须由受管任务执行', async () => {
  expect(await call(trusted, {})).toMatchObject({ ok: false, code: 'BAD_REQUEST' })
  expect(state.run).not.toHaveBeenCalled()
  state.run.mockResolvedValue({ items: [] })
  expect(await call(trusted, request)).toMatchObject({ ok: true, batch: { items: [] } })
  expect(state.run).toHaveBeenCalledWith(request, expect.any(Function))
})
