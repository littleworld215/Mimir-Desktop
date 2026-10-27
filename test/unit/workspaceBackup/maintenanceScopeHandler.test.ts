import { expect, it, vi } from 'vitest'
import { buildRestoreHandler } from '../../../electron/workspaceBackup/maintenanceRestoreHandler'

it('实际原生选包后的范围确认取消，不调用恢复服务或创建暂存', async () => {
  const request = { archivePath: 'C:/synthetic.zip', targetRoot: 'C:/new-synthetic', spaceName: '合成' }
  const run = vi.fn(async () => { throw new Error('synthetic unexpected restore') })
  const handler = buildRestoreHandler({ homeDir: 'C:/synthetic-home', session: { assertUsable() {} },
    selectRequest: async () => ({ request, assertUnchanged() {} }), confirmScope: async () => null, run })
  expect(await handler(request)).toMatchObject({ ok: false, code: 'CANCELLED' })
  expect(run).not.toHaveBeenCalled()
})

it.each(['MANIFEST_LIMIT', 'ENTRY_LIMIT', 'TOTAL_LIMIT'])('确认前读取范围的%s保留原安全错误码且不开始恢复', async code => {
  const request = { archivePath: 'C:/synthetic.zip', targetRoot: 'C:/new-synthetic', spaceName: '合成' }
  const run = vi.fn(async () => { throw new Error('synthetic unexpected restore') })
  const handler = buildRestoreHandler({ homeDir: 'C:/synthetic-home', session: { assertUsable() {} },
    selectRequest: async () => ({ request, assertUnchanged() {} }),
    confirmScope: async () => { throw Object.assign(new Error('synthetic bounded rejection'), { code }) }, run })
  expect(await handler(request)).toMatchObject({ ok: false, code })
  expect(run).not.toHaveBeenCalled()
})
