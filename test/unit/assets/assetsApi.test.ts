import { afterEach, it, expect, vi } from 'vitest'
import { assetsApi, AssetsApiError, listAssets } from '../../../src/components/modules/assets/assetsApi'
import { ASSETS_CHANNELS } from '../../../shared/assetsContracts'
afterEach(() => vi.unstubAllGlobals())
it('完整类型门面保留空正文/null条件及筛选，返回成功数据', async () => {
  const update = vi.fn().mockResolvedValue({ ok: true, asset: { id: 1, currentContent: '' } })
  const list = vi.fn().mockResolvedValue({ ok: true, page: { items: [], total: 0 } })
  vi.stubGlobal('window', { electronAPI: { assets: { update, list } } })
  expect(Object.keys(assetsApi).sort()).toEqual(Object.keys(ASSETS_CHANNELS).sort())
  const request = { workspaceId: 'A', spaceEpoch: 'A#1', assetId: 1, expectedRevision: 1, expectedCurrentVersionId: null, patch: { content: '' } }
  expect(await assetsApi.update(request)).toEqual({ asset: { id: 1, currentContent: '' } })
  expect(update).toHaveBeenCalledWith(request)
  await listAssets({ workspaceId: 'A', spaceEpoch: 'A#1' }, 2, 10, { archived: 'only', tagIds: [3], tagMode: 'or' })
  expect(list).toHaveBeenCalledWith({ workspaceId: 'A', spaceEpoch: 'A#1', page: 2, pageSize: 10, archived: 'only', tagIds: [3], tagMode: 'or' })
})
it('冲突回传details；无桥接返回可读错误', async () => {
  vi.stubGlobal('window', { electronAPI: { assets: { update: vi.fn().mockResolvedValue({ ok: false, code: 'REVISION_CONFLICT', message: 'changed', details: { currentRevision: 9, currentVersionId: null } }) } } })
  const req = { workspaceId: 'A', spaceEpoch: 'A#1', assetId: 1, expectedRevision: 1, patch: {} }
  await expect(assetsApi.update(req)).rejects.toMatchObject({ code: 'REVISION_CONFLICT', details: { currentRevision: 9, currentVersionId: null } })
  vi.stubGlobal('window', {})
  await expect(assetsApi.context()).rejects.toBeInstanceOf(AssetsApiError)
  await expect(assetsApi.context()).rejects.toMatchObject({ code: 'NO_BRIDGE' })
})
