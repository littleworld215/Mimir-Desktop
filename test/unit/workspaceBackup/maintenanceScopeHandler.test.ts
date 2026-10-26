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
