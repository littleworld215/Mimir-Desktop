import { makeTest, expect } from '../fixtures/app'
import { gotoModule } from '../helpers/nav'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { test as isolatedTest } from '@playwright/test'
import { mkdirSync, writeFileSync } from 'node:fs'
import { launchApp } from '../fixtures/launch'
import { evidencePdf, reopenEvidenceApp } from '../fixtures/libraryEvidence'

const PAPER = 'doi:10.1/evidence-demo', TITLE = '合成证据文献'
const test = makeTest({ executablePath: process.env.MIMIR_E2E_PACKAGED, transformSeed: seed => ({
  ...seed,
  spaceData: {
    'library:projects': [{ id: 'evidence-project', title: '合成课题', createdAt: '2026-10-17', updatedAt: '2026-10-17' }],
    'library:papers': { [PAPER]: { arxivId: PAPER, title: TITLE, authors: ['合成作者'], summary: '完全离线合成资料', url: 'https://example.org/synthetic', notes: '[2026-10-17 09:00]\n旧阅读笔记保留', tags: [], projectIds: ['evidence-project'], addedAt: '2026-10-17' } }
  }
}) })

test('真实编辑两卡、历史、取消离开与旧笔记保留（不需要PDF或模型）', async ({ page, launched }) => {
  test.setTimeout(120_000)
  await gotoModule(page, 'library')
  await page.getByRole('button', { name: `证据卡：${TITLE}`, exact: true }).click()
  const reader = page.getByRole('dialog', { name: '文献阅读器', exact: true })
  await expect(reader.getByRole('tab', { name: '证据卡' })).toHaveAttribute('aria-selected', 'true')
  for (const [index, relation] of ['supports', 'opposes'].entries()) {
    await reader.getByRole('button', { name: '新建证据卡', exact: true }).click()
    await reader.getByLabel('研究问题', { exact: true }).fill(`问题${index + 1}`)
    await reader.getByLabel('原文摘录', { exact: true }).fill(`  摘录${index + 1}😀\n\n`)
    await reader.getByLabel('待比较判断', { exact: true }).fill('同一判断，不合并相反证据')
    await reader.getByLabel('与判断的关系', { exact: true }).selectOption(relation)
    await reader.getByRole('button', { name: '保存证据', exact: true }).click()
    await expect(reader.getByRole('region', { name: '证据修订历史' })).toBeVisible()
    await expect(reader.getByText(/编辑已同步/)).toBeVisible()
  }
  await expect(reader.getByRole('button', { name: /^问题[12] ·/ })).toHaveCount(2)
  await reader.getByRole('button', { name: /^问题1 ·/ }).click()
  await expect(reader.getByLabel('原文摘录', { exact: true })).toHaveValue('  摘录1😀\n\n')
  await reader.getByLabel('局限', { exact: true }).fill('新增人工局限')
  await reader.getByRole('button', { name: '保存证据', exact: true }).click()
  await expect(reader.getByLabel('查看证据版本')).toHaveValue('2')
  await reader.getByLabel('查看证据版本').selectOption('1')
  await expect(reader.getByTestId('evidence-history-quote')).toHaveText('  摘录1😀\n\n')
  await reader.getByRole('button', { name: '新建证据卡', exact: true }).click()
  await reader.getByLabel('原文摘录', { exact: true }).fill('未保存输入')
  await reader.getByLabel('原文摘录', { exact: true }).press('Escape')
  const leave = page.getByRole('dialog', { name: '存在未保存的证据编辑', exact: true })
  await leave.getByRole('button', { name: '留在这里', exact: true }).click()
  await expect(reader.getByLabel('原文摘录', { exact: true })).toHaveValue('未保存输入')
  await reader.getByRole('button', { name: '取消编辑', exact: true }).click()
  await reader.getByRole('tab', { name: '阅读笔记', exact: true }).click()
  await expect(reader.getByText('旧阅读笔记保留', { exact: true })).toBeVisible()
  await reader.getByRole('button', { name: '关闭', exact: true }).click()
  const global = JSON.parse(readFileSync(join(launched.tempHome.home, '.mimir/store.json'), 'utf8'))
  const root = global['workspaces:list'][0].path
  const doc = JSON.parse(readFileSync(join(root, '.mimir/library/evidence.json'), 'utf8'))
  expect(doc.cards).toHaveLength(2)
  expect(doc.cards[0].versions).toHaveLength(2)
  expect(doc.cards[0].versions[0].quote).toBe('  摘录1😀\n\n')
  expect(doc.cards.map((c: any) => c.versions.at(-1).relation).sort()).toEqual(['opposes', 'supports'])
  expect(JSON.parse(readFileSync(join(root, '.mimir/store.json'), 'utf8'))['library:papers'][PAPER].notes).toBe('[2026-10-17 09:00]\n旧阅读笔记保留')
})

isolatedTest('十篇二十卡人工工作流、PDF变化、冲突保留及同profile重启', async () => {
  isolatedTest.setTimeout(240_000)
  let root = ''
  const ids = Array.from({ length: 10 }, (_, n) => `doi:10.2/manual-${n}`)
  const ctx = await launchApp({ executablePath: process.env.MIMIR_E2E_PACKAGED, transformSeed: seed => {
    root = seed.workspaces[0].path
    mkdirSync(join(root, 'papers'), { recursive: true })
    writeFileSync(join(root, 'papers', `${encodeURIComponent(ids[0])}.pdf`), evidencePdf())
    return { ...seed, spaceData: {
      'library:projects': [{ id: 'manual-project', title: '人工比较课题', createdAt: '2026-10-17', updatedAt: '2026-10-17' }],
      'library:papers': Object.fromEntries(ids.map((id, n) => [id, { arxivId: id, title: `人工合成文献${n}`, authors: ['合成作者'], summary: '离线', url: 'https://example.org/synthetic', notes: '[2026-10-17 09:00]\n旧阅读笔记保留', tags: [], projectIds: ['manual-project'], addedAt: '2026-10-17', ...(n === 0 ? { pdfPath: join(root, 'papers', `${encodeURIComponent(id)}.pdf`) } : {}) }]))
    } }
  } })
  let restarted: Awaited<ReturnType<typeof reopenEvidenceApp>> | undefined
  try {
    const { page } = ctx
    await gotoModule(page, 'library')
    for (let n = 0; n < 10; n++) {
      await page.getByRole('button', { name: `证据卡：人工合成文献${n}`, exact: true }).click()
      const reader = page.getByRole('dialog', { name: '文献阅读器', exact: true })
      for (const relation of ['supports', 'opposes']) {
        await reader.getByRole('button', { name: '新建证据卡', exact: true }).click()
        await reader.getByLabel('研究问题', { exact: true }).fill(`问题${n}-${relation}`)
        await reader.getByLabel('原文摘录', { exact: true }).fill(`  原文${n}-${relation}😀\n\n`)
        await reader.getByLabel('与判断的关系', { exact: true }).selectOption(relation)
        await reader.getByLabel('PDF物理起始页', { exact: true }).fill('1')
        await reader.getByRole('button', { name: '保存证据', exact: true }).click()
        await expect(reader.getByText(/编辑已同步/)).toBeVisible()
      }
      await reader.getByRole('button', { name: '关闭', exact: true }).click()
    }
    const file = join(root, '.mimir/library/evidence.json')
    expect(JSON.parse(readFileSync(file, 'utf8')).cards).toHaveLength(20)
    await page.locator('button[title="人工比较课题"]').click()
    await page.getByRole('button', { name: 'BibTeX', exact: true }).first().click()
    await expect(page.getByText(/已加入 references.bib/)).toBeVisible()
    expect(readFileSync(join(root, 'projects/manual-project/references.bib'), 'utf8')).toContain('人工合成文献')
    await page.getByRole('button', { name: '证据卡：人工合成文献0', exact: true }).click()
    const reader = page.getByRole('dialog', { name: '文献阅读器', exact: true })
    await reader.getByRole('button', { name: /^问题0-supports ·/ }).click()
    await reader.getByRole('button', { name: '我已核对原文与页码', exact: true }).click()
    await expect(reader.getByLabel('查看证据版本')).toHaveValue('2')
    await reader.getByLabel('个人评注', { exact: true }).fill('冲突时保留的本地输入')
    await page.evaluate(async paperId => {
      const api = window.electronAPI!.libraryEvidence, boot = await api.list({ filter: { archive: 'exclude', source: 'all' }, page: 1 })
      if (!boot.ok) throw Error(boot.message)
      const cardId = boot.rows.find(r => r.paperId === paperId)!.cards.find(c => c.relation === 'supports')!.cardId
      const detail = await api.detail({ scope: boot.scope, cardId })
      if (!detail.ok) throw Error(detail.message)
      const v = detail.card.versions.at(-1)!
      const input = Object.fromEntries(['paperId', 'projectIds', 'question', 'claim', 'quote', 'method', 'datasetOrMaterial', 'finding', 'limitation', 'comment', 'relation', 'locator'].map(key => [key, v[key as keyof typeof v]])) as any
      const result = await api.update({ scope: boot.scope, cardId, expectedRevision: detail.revision, input: { ...input, limitation: '另一次受控提交' } })
      if (!result.ok) throw Error(result.message)
    }, ids[0])
    await reader.getByRole('button', { name: '保存证据', exact: true }).click()
    await expect(reader.getByRole('alert')).toContainText('CONFLICT')
    await expect(reader.getByLabel('个人评注', { exact: true })).toHaveValue('冲突时保留的本地输入')
    await reader.getByRole('button', { name: '取消编辑', exact: true }).click()
    await reader.getByRole('button', { name: /^问题0-supports ·/ }).click()
    await reader.getByRole('button', { name: '归档证据', exact: true }).click()
    await reader.getByLabel('包含归档').check()
    await expect(reader.getByRole('button', { name: /^问题0-supports ·/ })).toContainText('已归档')
    const visualDir = join(process.cwd(), '../../.git/codex-integration/i8-evidence/visual')
    mkdirSync(visualDir, { recursive: true })
    for (const theme of ['light', 'dark']) for (const width of [1280, 800]) {
      await page.evaluate(theme => { document.documentElement.classList.toggle('dark', theme === 'dark') }, theme)
      await page.setViewportSize({ width, height: 900 })
      await expect(reader.getByRole('button', { name: '取消归档', exact: true })).toBeVisible()
      await page.screenshot({ path: join(visualDir, `${process.env.MIMIR_E2E_PACKAGED ? 'packaged' : 'development'}-${theme}-${width}.png`) })
    }
    await page.setViewportSize({ width: 1280, height: 900 })
    await reader.getByRole('button', { name: '关闭', exact: true }).click()
    const before = readFileSync(file)
    writeFileSync(join(root, 'papers', `${encodeURIComponent(ids[0])}.pdf`), evidencePdf('Changed synthetic source'))
    await page.getByRole('button', { name: '证据卡：人工合成文献0', exact: true }).click()
    await reader.getByLabel('包含归档').check()
    await reader.getByRole('button', { name: /^问题0-supports ·/ }).click()
    await reader.getByRole('button', { name: '检查来源', exact: true }).click()
    await expect(reader.getByText(/^来源版本变化 · 上次检查/)).toBeVisible()
    expect(readFileSync(file)).toEqual(before)
    await reader.getByRole('tab', { name: '阅读笔记', exact: true }).click()
    await expect(reader.getByText('旧阅读笔记保留', { exact: true })).toBeVisible()
    await reader.getByRole('button', { name: '关闭', exact: true }).click()
    restarted = await reopenEvidenceApp(ctx)
    await gotoModule(restarted.page, 'library')
    await restarted.page.getByRole('button', { name: '证据比较矩阵', exact: true }).click()
    const matrix = restarted.page.getByRole('region', { name: '文献证据比较矩阵', exact: true })
    await expect(matrix.getByRole('table', { name: '证据比较表' })).toBeVisible()
    expect(readFileSync(file)).toEqual(before)
    const doc = JSON.parse(readFileSync(file, 'utf8'))
    expect(doc.cards).toHaveLength(20)
    expect(doc.cards.find((c: any) => c.versions[0].question === '问题0-supports').versions).toHaveLength(4)
  } finally { try { await restarted?.app.close() } finally { await ctx.cleanup() } }
})

isolatedTest('原生丢弃关闭拒绝在途导出，完成后允许显式丢弃空闲输入', async () => {
  isolatedTest.setTimeout(90_000)
  const ctx = await launchApp({ executablePath: process.env.MIMIR_E2E_PACKAGED, transformSeed: seed => ({ ...seed, spaceData: { 'library:papers': { native: { arxivId: 'native', title: '原生关闭合成资料', authors: [], summary: '', url: 'https://example.org/synthetic', notes: '', tags: [], projectIds: [], addedAt: '2026-10-17' } } } }) })
  try {
    const { page, app } = ctx
    await gotoModule(page, 'library')
    await page.getByRole('button', { name: '证据卡：原生关闭合成资料', exact: true }).click()
    const reader = page.getByRole('dialog', { name: '文献阅读器', exact: true })
    await reader.getByRole('button', { name: '新建证据卡', exact: true }).click()
    await reader.getByLabel('原文摘录', { exact: true }).fill('合成来源')
    await reader.getByRole('button', { name: '保存证据', exact: true }).click()
    await expect(reader.getByText(/编辑已同步/)).toBeVisible()
    await reader.getByRole('button', { name: '关闭', exact: true }).click()
    await page.getByRole('button', { name: '证据比较矩阵', exact: true }).click()
    await page.getByRole('button', { name: '导出证据', exact: true }).click()
    await app.evaluate(({ dialog }) => {
      const state = globalThis as any
      state.evidenceNativeCalls = 0
      dialog.showMessageBoxSync = (() => { state.evidenceNativeCalls++; return 2 }) as any
      dialog.showSaveDialog = (() => new Promise(resolve => { state.evidenceSaveRelease = () => resolve({ canceled: true, filePath: '' }) })) as any
    })
    await page.getByRole('button', { name: '选择新文件并导出', exact: true }).click()
    await expect.poll(() => app.evaluate(() => Boolean((globalThis as any).evidenceSaveRelease))).toBe(true)
    await page.evaluate(() => {
      const original = window.mimirRequestEvidenceLeave!
      window.mimirRequestEvidenceLeave = async choice => {
        const allowed = await original(choice)
        ;(window as any).evidenceNativeGuardResult = allowed
        return allowed
      }
    })
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.close())
    await expect.poll(() => app.evaluate(() => (globalThis as any).evidenceNativeCalls)).toBe(1)
    await page.waitForFunction(() => (window as any).evidenceNativeGuardResult === false)
    expect(page.isClosed()).toBe(false)
    await app.evaluate(() => (globalThis as any).evidenceSaveRelease())
    await expect(page.getByText('已取消，未写入导出文件')).toBeVisible()
    await page.getByRole('dialog', { name: '导出文献证据', exact: true }).getByRole('button', { name: '取消', exact: true }).click()
    await page.getByRole('button', { name: /查看证据 .* 方法/ }).click()
    const detail = page.getByRole('dialog', { name: '证据详情', exact: true })
    await detail.getByLabel('个人评注', { exact: true }).fill('明确丢弃的合成输入')
    const closed = page.waitForEvent('close')
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.close())
    await closed
  } finally {
    if (ctx.app.process().exitCode === null) await ctx.app.evaluate(() => (globalThis as any).evidenceSaveRelease?.()).catch(() => {})
    await ctx.cleanup()
  }
})

test('真实矩阵保留相反判断，JSON/CSV全范围导出且已有目标不覆盖', async ({ page, electronApp, launched }) => {
  test.setTimeout(120_000)
  await gotoModule(page, 'library')
  await page.evaluate(async paperId => {
    const api = window.electronAPI!.libraryEvidence
    const boot = await api.list({ filter: { archive: 'exclude', source: 'all' }, page: 1 })
    if (!boot.ok) throw Error(boot.message)
    let revision = boot.revision
    for (const relation of ['supports', 'opposes'] as const) {
      const saved = await api.create({ scope: boot.scope, expectedRevision: revision, input: { paperId, projectIds: ['evidence-project'], question: `矩阵试点${relation}`, claim: '相同判断', quote: relation === 'supports' ? '  矩阵原文😀\n\n' : '=1+1\n"原文"', method: '人工方法', datasetOrMaterial: '合成材料', finding: '互不合并', limitation: '', comment: '', relation, locator: { pageStart: 1 } } })
      if (!saved.ok) throw Error(saved.message)
      revision = saved.revision
    }
  }, PAPER)
  await page.getByRole('button', { name: '证据比较矩阵', exact: true }).click()
  const matrix = page.getByRole('region', { name: '文献证据比较矩阵', exact: true })
  await matrix.getByLabel('证据关键词', { exact: true }).fill('矩阵试点')
  await expect(matrix.getByRole('table', { name: '证据比较表' })).toBeVisible()
  await expect(matrix.getByText(/· 支持 ·/)).toHaveCount(1)
  await expect(matrix.getByText(/· 反对 ·/)).toHaveCount(1)
  await matrix.getByRole('button', { name: /查看证据 .* 方法/ }).first().click()
  const detail = page.getByRole('dialog', { name: '证据详情', exact: true })
  await expect(detail.getByLabel('原文摘录', { exact: true })).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(detail).toHaveCount(0)
  const jsonPath = join(launched.tempHome.home, 'evidence-matrix.json'), csvPath = join(launched.tempHome.home, 'evidence-matrix.csv')
  await electronApp.evaluate(({ dialog }, path) => { dialog.showSaveDialog = (async () => ({ canceled: false, filePath: path })) as any }, jsonPath)
  await matrix.getByRole('button', { name: '导出证据', exact: true }).click()
  const exported = page.getByRole('dialog', { name: '导出文献证据', exact: true })
  await expect(exported.getByText(/2 张证据卡/)).toBeVisible()
  await exported.getByRole('button', { name: '选择新文件并导出', exact: true }).click()
  await expect(exported.getByText('已保存新文件：evidence-matrix.json')).toBeVisible()
  const json = JSON.parse(readFileSync(jsonPath, 'utf8'))
  expect(json.cards).toHaveLength(2)
  expect(json.cards.find((c: any) => c.versions[0].relation === 'supports').versions[0].quote).toBe('  矩阵原文😀\n\n')
  await electronApp.evaluate(({ dialog }, path) => { dialog.showSaveDialog = (async () => ({ canceled: false, filePath: path })) as any }, csvPath)
  await exported.getByLabel('导出格式', { exact: true }).selectOption('csv')
  await exported.getByRole('button', { name: '选择新文件并导出', exact: true }).click()
  await expect(exported.getByText('已保存新文件：evidence-matrix.csv')).toBeVisible()
  const csv = readFileSync(csvPath, 'utf8')
  expect(csv).toContain('"\'=1+1\n""原文"""')
  await exported.getByRole('button', { name: '取消', exact: true }).click()
  await matrix.getByRole('button', { name: '导出证据', exact: true }).click()
  await exported.getByLabel('导出格式', { exact: true }).selectOption('csv')
  await exported.getByRole('button', { name: '选择新文件并导出', exact: true }).click()
  await expect(exported.getByRole('alert')).toContainText('WRITE_FAILED')
  expect(readFileSync(csvPath, 'utf8')).toBe(csv)
  await exported.getByRole('button', { name: '取消', exact: true }).click()
})
