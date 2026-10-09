import { test, expect } from '@playwright/test'
import { launchApp } from '../fixtures/launch'

for (const nativeMessageBoxes of [false, true]) {
  test(`人工原生批准入口保留真实API验证，普通夹具继续拒绝 (${nativeMessageBoxes})`, async () => {
    const options = { nativeMessageBoxes }
    const launched = await launchApp(options)
    try {
      // 无效参数在原生API入口就被拒绝，不打开需要真人点击的窗口。
      const result = await launched.app.evaluate(async ({ dialog }) => {
        try {
        await dialog.showMessageBox({ message: 'API参数验证，不打开弹窗', buttons: 7 as unknown as string[] })
          return 'returned'
        } catch {
          return 'rejected'
        }
      })
      expect(result).toBe(nativeMessageBoxes ? 'rejected' : 'returned')
    } finally { await launched.cleanup() }
  })
}
