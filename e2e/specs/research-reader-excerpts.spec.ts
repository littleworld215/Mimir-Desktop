import { expect, test } from '@playwright/test'
import { launchApp } from '../fixtures/launch'
import { seedResearchWorkflow } from '../fixtures/researchWorkflow'
import { gotoModule } from '../helpers/nav'
import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { evidencePdf } from '../fixtures/libraryEvidence'

test('来源改绑另一篇PDF后只原生查看，返回当前文献后才可摘录且不串来源', async () => {
  let root = '', paperIds: string[] = []
  const otherQuote = 'Distinct second document B'
  const ctx = await launchApp({ executablePath: process.env.MIMIR_E2E_PACKAGED, transformSeed: seed => {
    const fixture = seedResearchWorkflow(seed); root = fixture.root; paperIds = fixture.paperIds
    const pdfPath = join(root, 'papers', encodeURIComponent(paperIds[1]!) + '.pdf')
    writeFileSync(pdfPath, evidencePdf(otherQuote))
    ;(fixture.seed.spaceData['library:papers'] as Record<string, { pdfPath?: string }>)[paperIds[1]!]!.pdfPath = pdfPath
    return fixture.seed
  } })
  try {
    await gotoModule(ctx.page, 'library')
    await ctx.page.locator('button[title="合成科研闭环"]').click()
    await ctx.page.getByRole('button', { name: '证据卡：闭环文献1', exact: true }).click()
    const reader = ctx.page.getByRole('dialog', { name: '文献阅读器', exact: true })
    await reader.getByRole('button', { name: '新建证据卡', exact: true }).click()
    await reader.getByLabel('原文摘录', { exact: true }).fill('人工旧输入')
    await reader.getByLabel('研究问题', { exact: true }).fill('跨文献来源回归')
    await reader.getByRole('button', { name: '保存证据', exact: true }).click()
    await expect(reader.getByText(/编辑已同步/)).toBeVisible()
    await reader.getByLabel('来源文献', { exact: true }).selectOption(paperIds[1]!)
    await reader.getByRole('button', { name: '保存证据', exact: true }).click()
    await expect(reader.getByText(/编辑已同步/)).toBeVisible()
    await reader.getByRole('button', { name: '增强阅读', exact: true }).click()
    await expect(reader.locator('.enhanced-pdf-text span').first()).toHaveText('Synthetic fairness evidence')
    await reader.getByText('打开原文', { exact: true }).click()
    await expect(reader.locator('iframe')).toHaveAttribute('src', `mimir-pdf://paper/${encodeURIComponent(paperIds[1]!)}.pdf`)
    await expect(reader.getByRole('button', { name: '增强阅读', exact: true })).toBeDisabled()
    await expect(reader.getByRole('button', { name: '摘录为证据', exact: true })).toHaveCount(0)
    await reader.getByRole('button', { name: '返回当前文献PDF', exact: true }).click()
    await reader.getByRole('button', { name: '增强阅读', exact: true }).click()
    const text = reader.locator('.enhanced-pdf-text span').first()
    await expect(text).toHaveText('Synthetic fairness evidence')
    const box = await text.boundingBox(); expect(box).not.toBeNull()
    await ctx.page.mouse.move(box!.x + 0.5, box!.y + box!.height / 2); await ctx.page.mouse.down()
    await ctx.page.mouse.move(box!.x + box!.width - 0.5, box!.y + box!.height / 2, { steps: 12 }); await ctx.page.mouse.up()
    const selected = await ctx.page.evaluate(() => document.getSelection()?.toString())
    expect(selected).toBe('Synthetic fairness evidence'); expect(selected).not.toBe(otherQuote)
    await reader.getByRole('button', { name: '摘录为证据', exact: true }).click()
    await expect(reader.getByLabel('原文摘录', { exact: true })).toHaveValue(selected!)
    await expect(reader.getByLabel('来源文献', { exact: true })).toHaveValue(paperIds[0]!)
    await reader.getByLabel('研究问题', { exact: true }).fill('返回后正确来源')
    await reader.getByRole('button', { name: '保存证据', exact: true }).click()
    await expect(reader.getByText(/编辑已同步/)).toBeVisible()
    const cards = JSON.parse(readFileSync(join(root, '.mimir/library/evidence.json'), 'utf8')).cards
    expect(cards).toHaveLength(2)
    expect(cards.map((card: any) => card.versions.at(-1))).toEqual(expect.arrayContaining([
      expect.objectContaining({ paperId: paperIds[0], quote: selected }), expect.objectContaining({ paperId: paperIds[1], quote: '人工旧输入' })
    ]))
  } finally { await ctx.cleanup() }
})

function actionPdf() {
  const first = 'BT /F1 14 Tf 40 780 Td (Synthetic active PDF) Tj ET\n', blank = 'q Q\n'
  const objects = ['<< /Type /Catalog /Pages 2 0 R /OpenAction 7 0 R >>', '<< /Type /Pages /Kids [3 0 R 4 0 R] /Count 2 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 5 0 R >> >> /Contents 6 0 R /Annots [8 0 R] >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << >> /Contents 9 0 R >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>', `<< /Length ${Buffer.byteLength(first)} >>\nstream\n${first}endstream`,
    '<< /S /JavaScript /JS (app.launchURL\("https://mimir-invalid.example/action"\)) >>',
    '<< /Type /Annot /Subtype /Link /Rect [40 760 250 800] /A << /S /URI /URI (https://mimir-invalid.example/link) >> >>',
    `<< /Length ${Buffer.byteLength(blank)} >>\nstream\n${blank}endstream`]
  let bytes = '%PDF-1.4\n'; const offsets = [0]
  for (const object of objects) { offsets.push(Buffer.byteLength(bytes)); bytes += `${offsets.length - 1} 0 obj\n${object}\nendobj\n` }
  const xref = Buffer.byteLength(bytes)
  bytes += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.slice(1).map(offset => `${String(offset).padStart(10, '0')} 00000 n \n`).join('')}trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`
  return bytes
}

test('实际文字选择进入未保存证据，显式保存才产生未核对历史', async () => {
  let root = ''
  const ctx = await launchApp({ executablePath: process.env.MIMIR_E2E_PACKAGED, transformSeed: seed => { const fixture = seedResearchWorkflow(seed); root = fixture.root; return fixture.seed } })
  try {
    await gotoModule(ctx.page, 'library')
    await ctx.page.locator('button[title="合成科研闭环"]').click()
    await ctx.page.getByRole('button', { name: '证据卡：闭环文献1', exact: true }).click()
    const reader = ctx.page.getByRole('dialog', { name: '文献阅读器', exact: true })
    await reader.getByRole('button', { name: '增强阅读', exact: true }).click()
    await reader.getByRole('button', { name: '新建证据卡', exact: true }).click()
    await reader.getByLabel('原文摘录', { exact: true }).fill('原有未保存输入')
    const text = reader.locator('.enhanced-pdf-text span').first()
    await expect(text).toBeVisible()
    const box = await text.boundingBox()
    expect(box).not.toBeNull()
    await ctx.page.mouse.move(box!.x + 0.5, box!.y + box!.height / 2)
    await ctx.page.mouse.down()
    await ctx.page.mouse.move(box!.x + box!.width - 0.5, box!.y + box!.height / 2, { steps: 12 })
    await ctx.page.mouse.up()
    const quote = await ctx.page.evaluate(() => document.getSelection()?.toString())
    expect(quote).toContain('Synthetic fairness evidence')
    const endpoints = await text.evaluate(element => {
      const root = element.closest('.enhanced-pdf-text')!, selection = document.getSelection()!
      return { anchorInside: root.contains(selection.anchorNode), focusInside: root.contains(selection.focusNode), commonInside: root.contains(selection.getRangeAt(0).commonAncestorContainer), anchor: selection.anchorNode?.nodeName, focus: selection.focusNode?.nodeName }
    })
    expect(await reader.getByRole('button', { name: '摘录为证据', exact: true }).isEnabled(), JSON.stringify(endpoints)).toBe(true)
    await reader.getByRole('button', { name: '摘录为证据', exact: true }).click()
    const leave = ctx.page.getByRole('dialog', { name: '存在未保存的研究资料编辑', exact: true })
    await leave.getByRole('button', { name: '留在这里', exact: true }).click()
    await expect(reader.getByLabel('原文摘录', { exact: true })).toHaveValue('原有未保存输入')
    await reader.getByRole('button', { name: '接收PDF摘录为新卡', exact: true }).click()
    await leave.getByRole('button', { name: '丢弃后离开', exact: true }).click()
    await expect(reader.getByLabel('原文摘录', { exact: true })).toHaveValue(quote!)
    await expect(reader.getByLabel('PDF物理起始页', { exact: true })).toHaveValue('1')
    const file = join(root, '.mimir/library/evidence.json')
    expect(existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')).cards.length : 0).toBe(0)
    await reader.getByLabel('研究问题', { exact: true }).fill('选区合成问题')
    await reader.getByRole('button', { name: '保存证据', exact: true }).click()
    await expect(reader.getByText(/编辑已同步/)).toBeVisible()
    const stored = JSON.parse(readFileSync(file, 'utf8')).cards
    expect(stored).toHaveLength(1)
    expect(stored[0].versions[0]).toMatchObject({ quote, locator: { pageStart: 1, pageEnd: 1 }, reviewState: 'draft', documentBinding: null })
    await reader.getByRole('button', { name: '原阅读', exact: true }).click()
    await expect(reader.locator('iframe')).toHaveCount(1)
  } finally { await ctx.cleanup() }
})

test('双页与扫描页、动作不执行、窄窗深浅主题及已完成页恢复', async () => {
  const ctx = await launchApp({ executablePath: process.env.MIMIR_E2E_PACKAGED, transformSeed: seed => {
    const fixture = seedResearchWorkflow(seed)
    writeFileSync(join(fixture.root, 'papers', encodeURIComponent(fixture.paperIds[0]!) + '.pdf'), actionPdf())
    return fixture.seed
  } })
  try {
    const external: string[] = []
    await ctx.page.route(/^https?:\/\//, async route => { external.push(route.request().url()); await route.abort() })
    await ctx.page.setViewportSize({ width: 920, height: 720 })
    await ctx.page.emulateMedia({ reducedMotion: 'reduce' })
    await gotoModule(ctx.page, 'library')
    await ctx.page.locator('button[title="合成科研闭环"]').click()
    const open = async () => {
      await ctx.page.getByRole('button', { name: '证据卡：闭环文献1', exact: true }).click()
      return ctx.page.getByRole('dialog', { name: '文献阅读器', exact: true })
    }
    const reader = await open()
    await reader.getByRole('button', { name: '增强阅读', exact: true }).click()
    await expect(reader.locator('.enhanced-pdf-surface[data-pdf-page="1"]')).toBeVisible()
    for (const theme of ['light', 'dark']) {
      await ctx.page.evaluate(dark => document.documentElement.classList.toggle('dark', dark), theme === 'dark')
      await expect(reader.getByRole('button', { name: '原阅读', exact: true })).toBeVisible()
      await expect(reader.getByLabel('PDF物理页', { exact: true })).toBeVisible()
      await reader.screenshot({ path: test.info().outputPath(`enhanced-narrow-${theme}.png`) })
      const contrast = await reader.getByRole('button', { name: '原阅读', exact: true }).evaluate(button => {
        const luminance = (color: string) => {
          const rgb = color.match(/[\d.]+/g)!.slice(0, 3).map(channel => { const value = Number(channel) / 255; return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4 })
          return rgb[0]! * 0.2126 + rgb[1]! * 0.7152 + rgb[2]! * 0.0722
        }
        const foreground = luminance(getComputedStyle(button).color), background = luminance(getComputedStyle(button.closest('[role="dialog"]')!).backgroundColor)
        return (Math.max(foreground, background) + 0.05) / (Math.min(foreground, background) + 0.05)
      })
      expect(contrast, `${theme}阅读模式按钮对比度`).toBeGreaterThanOrEqual(4.5)
    }
    await reader.getByRole('button', { name: '下一页', exact: true }).click()
    await expect(reader.locator('.enhanced-pdf-surface[data-pdf-page="2"]')).toBeVisible()
    await expect(reader.getByText(/没有可用文字层/)).toBeVisible()
    await expect(reader.getByRole('button', { name: '下一页', exact: true })).toBeDisabled()
    await reader.getByRole('button', { name: '关闭', exact: true }).click()
    const reopened = await open()
    await expect(reopened.locator('iframe')).toHaveCount(1)
    await reopened.getByRole('button', { name: '增强阅读', exact: true }).click()
    await expect(reopened.locator('.enhanced-pdf-surface[data-pdf-page="2"]')).toBeVisible()
    expect(external).toEqual([])
    expect(await reopened.locator('a[href],.annotationLayer,.xfaLayer').count()).toBe(0)
  } finally { await ctx.cleanup() }
})

test('增强模式显式启动本地worker，画布与可选文字层呈现同一物理页', async () => {
  const ctx = await launchApp({ executablePath: process.env.MIMIR_E2E_PACKAGED, transformSeed: seed => seedResearchWorkflow(seed).seed })
  try {
    const external: string[] = []
    await ctx.page.route(/^https?:\/\//, async route => { external.push(route.request().url()); await route.abort() })
    await gotoModule(ctx.page, 'library')
    await ctx.page.locator('button[title="合成科研闭环"]').click()
    await ctx.page.getByRole('button', { name: '证据卡：闭环文献1', exact: true }).click()
    const reader = ctx.page.getByRole('dialog', { name: '文献阅读器', exact: true })
    await expect(reader.locator('iframe')).toHaveCount(1)
    await reader.getByRole('button', { name: '增强阅读', exact: true }).click()
    const surface = reader.locator('.enhanced-pdf-surface[data-pdf-page="1"]')
    await expect(surface).toBeVisible()
    await expect(surface.locator('.enhanced-pdf-text')).toContainText('Synthetic fairness evidence')
    const layout = await surface.evaluate(element => {
      const canvas = element.querySelector('canvas')!, text = element.querySelector('.enhanced-pdf-text')!, span = text.querySelector('span')!
      const visual = canvas.getBoundingClientRect(), layer = text.getBoundingClientRect(), glyph = span.getBoundingClientRect()
      const context = canvas.getContext('2d')!, pixels = context.getImageData(0, 0, canvas.width, canvas.height).data
      let ink = 0
      for (let offset = 0; offset < pixels.length; offset += 4) if (pixels[offset] < 220 && pixels[offset + 3] > 0) ink++
      return { pixels: canvas.width * canvas.height, widthDelta: Math.abs(visual.width - layer.width), heightDelta: Math.abs(visual.height - layer.height), glyphWidth: glyph.width, ink }
    })
    expect(layout.pixels).toBeLessThanOrEqual(16000000)
    expect(layout.widthDelta).toBeLessThan(1)
    expect(layout.heightDelta).toBeLessThan(1)
    expect(layout.glyphWidth).toBeGreaterThan(10)
    expect(layout.ink).toBeGreaterThan(10)
    await reader.getByLabel('PDF缩放', { exact: true }).selectOption('1.5')
    await expect(surface.locator('canvas')).toHaveCSS('width', '892.5px')
    await reader.getByRole('button', { name: '原阅读', exact: true }).click()
    await expect(reader.locator('iframe')).toHaveCount(1)
    expect(external).toEqual([])
  } finally { await ctx.cleanup() }
})

test('受管PDF协议在当前安全策略下提供可读流，不借任意文件路径', async () => {
  let paperId = ''
  const ctx = await launchApp({ executablePath: process.env.MIMIR_E2E_PACKAGED, transformSeed: seed => { const fixture = seedResearchWorkflow(seed); paperId = fixture.paperIds[0]!; return fixture.seed } })
  try {
    await gotoModule(ctx.page, 'library')
    let externalRequests = 0
    await ctx.page.route('https://mimir-invalid.example/**', async route => { externalRequests++; await route.abort() })
    const reply = await ctx.page.evaluate(async id => {
      const denied: string[] = []
      const observe = (event: SecurityPolicyViolationEvent) => { denied.push(event.effectiveDirective) }
      document.addEventListener('securitypolicyviolation', observe)
      try {
        const response = await fetch(`mimir-pdf://paper/${encodeURIComponent(id)}.pdf`, { credentials: 'omit', redirect: 'error' })
        const reader = response.body?.getReader()
        if (!response.ok || !reader) return { ok: false, status: response.status, message: 'no readable PDF stream' }
        let bytes = 0, signature = ''
        try {
          while (true) {
            const result = await reader.read()
            if (result.done) break
            bytes += result.value.byteLength
            if (!signature) signature = new TextDecoder().decode(result.value.slice(0, 5))
            if (bytes > 1024 * 1024) throw Error('synthetic PDF unexpectedly large')
          }
        } finally { reader.releaseLock() }
        return { ok: true, bytes, signature }
      } catch (failure) {
        await new Promise(resolve => setTimeout(resolve, 25))
        return { ok: false, message: failure instanceof Error ? failure.message : 'fetch rejected', denied }
      } finally { document.removeEventListener('securitypolicyviolation', observe) }
    }, paperId)
    expect(reply, JSON.stringify(reply)).toMatchObject({ ok: true, signature: '%PDF-' })
    const rejected = await ctx.page.evaluate(async () => {
      const results: boolean[] = [], denied: string[] = []
      const observe = (event: SecurityPolicyViolationEvent) => { denied.push(event.blockedURI) }
      document.addEventListener('securitypolicyviolation', observe)
      try {
        for (const url of ['mimir-pdf://paper/unknown-synthetic-id.pdf', 'mimir-pdf://wrong/unknown.pdf', 'mimir-pdf://paper/invalid/path.pdf', 'https://mimir-invalid.example/blocked']) {
          try { const response = await fetch(url, { credentials: 'omit', redirect: 'error' }); results.push(!response.ok) } catch { results.push(true) }
        }
        await new Promise(resolve => setTimeout(resolve, 30))
        return { results, denied }
      } finally { document.removeEventListener('securitypolicyviolation', observe) }
    })
    expect(rejected.results).toEqual([true, true, true, true])
    expect(rejected.denied.some(url => url.startsWith('https://mimir-invalid.example'))).toBe(true)
    expect(await ctx.page.locator('meta[http-equiv="Content-Security-Policy"]').getAttribute('content')).toContain("connect-src 'self' mimir-pdf://paper;")
    expect(externalRequests).toBe(0)
  } finally { await ctx.cleanup() }
})
