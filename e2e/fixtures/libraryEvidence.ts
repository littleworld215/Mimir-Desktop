import { _electron as electron, expect } from '@playwright/test'
import { realpathSync } from 'node:fs'
import type { LaunchedApp } from './launch'
import { mainEntry } from './launch'

/** 可由真实 PDF 阅读器读取的一页合成资料；偏移按实际字节计算。 */
export function evidencePdf(text = 'Synthetic evidence only'): Buffer {
  const content = `BT /F1 14 Tf 40 780 Td (${text}) Tj ET\n`
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    `<< /Length ${Buffer.byteLength(content)} >>\nstream\n${content}endstream`
  ]
  let pdf = '%PDF-1.4\n'
  const offsets = [0]
  objects.forEach((object, index) => { offsets.push(Buffer.byteLength(pdf)); pdf += `${index + 1} 0 obj\n${object}\nendobj\n` })
  const xref = Buffer.byteLength(pdf)
  pdf += `xref\n0 6\n0000000000 65535 f \n${offsets.slice(1).map(n => `${String(n).padStart(10, '0')} 00000 n \n`).join('')}trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`
  return Buffer.from(pdf)
}

/** 不重写 seed；先关闭旧实例，再以同一隔离 profile 真正重启。 */
export async function reopenEvidenceApp(ctx: LaunchedApp) {
  const handle = ctx.app.process()
  await ctx.app.close()
  expect(handle.exitCode).toBe(0)
  const app = await electron.launch({
    executablePath: process.env.MIMIR_E2E_PACKAGED,
    args: [...(process.env.MIMIR_E2E_PACKAGED ? [] : [mainEntry]), `--user-data-dir=${ctx.tempHome.userData}`],
    cwd: ctx.tempHome.root,
    env: { ...process.env, HOME: ctx.tempHome.home, USERPROFILE: ctx.tempHome.home, MIMIR_OTEL_ENDPOINT: '', MIMIR_OTEL_PUBLIC_KEY: '', MIMIR_OTEL_SECRET_KEY: '' }
  })
  try {
    // 与 launchApp 一致：先等窗口，避免启动初始化销毁 CDP 求值上下文。
    const page = await app.firstWindow()
    await page.waitForLoadState('domcontentloaded')
    await page.waitForFunction(() => Boolean(window.electronAPI?.workspaces))
    const actual = await app.evaluate(({ app }) => ({ home: process.getBuiltinModule('os').homedir(), userData: app.getPath('userData') }))
    expect(realpathSync(actual.home)).toBe(realpathSync(ctx.tempHome.home))
    expect(realpathSync(actual.userData)).toBe(realpathSync(ctx.tempHome.userData))
    await app.evaluate(({ dialog }) => { dialog.showMessageBoxSync = (() => 0) as any })
    return { app, page }
  } catch (error) { await app.close(); throw error }
}
