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
