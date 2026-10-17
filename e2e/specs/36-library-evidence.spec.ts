import { makeTest, expect } from '../fixtures/app'
import { gotoModule } from '../helpers/nav'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

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
