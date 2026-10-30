import { expect, test } from '@playwright/test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { launchApp } from '../fixtures/launch'
import { gotoModule } from '../helpers/nav'
import { reopenEvidenceApp } from '../fixtures/libraryEvidence'
import { seedResearchWorkflow } from '../fixtures/researchWorkflow'
import * as researchFixture from '../fixtures/libraryResearch'

test('研究截图目录按本轮指定或新建，不写历史I9证据目录', async () => {
  const directory = (researchFixture as unknown as { researchEvidenceDirectory?: () => string }).researchEvidenceDirectory
  expect(typeof directory).toBe('function')
  const value = directory!()
  expect(value).not.toContain('i9-execution')
  expect(value).not.toContain('codex-integration')
})

test('从新建笔记与证据到矩阵、问题、固定素材、导出及重启找回', async () => {
  test.setTimeout(180_000)
  let fixture!: ReturnType<typeof seedResearchWorkflow>
  const ctx = await launchApp({ executablePath: process.env.MIMIR_E2E_PACKAGED, transformSeed: seed => { fixture = seedResearchWorkflow(seed); return fixture.seed } })
  let reopened: Awaited<ReturnType<typeof reopenEvidenceApp>> | undefined
  try {
    const otherFile = join(fixture.secondRoot, '.mimir/store.json'), otherBefore = readFileSync(otherFile)
    const { page } = ctx
    await gotoModule(page, 'library')
    await page.locator('button[title="合成科研闭环"]').click()
    await page.getByRole('button', { name: '证据卡：闭环文献1', exact: true }).click()
    const reader = page.getByRole('dialog', { name: '文献阅读器', exact: true })
    await reader.getByRole('tab', { name: '阅读笔记', exact: true }).click()
    await reader.getByRole('button', { name: '添加', exact: true }).click()
    await reader.getByPlaceholder('记录阅读心得、关键公式、待办...').fill('本次合成阅读笔记😀\n\n保留第二段')
    await reader.getByRole('button', { name: '保存', exact: true }).click()
    await expect(reader.getByPlaceholder('记录阅读心得、关键公式、待办...')).toHaveCount(0)
    await expect(reader.getByText('旧自由笔记保留', { exact: true })).toBeVisible()
    await reader.getByRole('tab', { name: '证据卡', exact: true }).click()
    await reader.getByRole('button', { name: '新建证据卡', exact: true }).click()
    await reader.getByLabel('研究问题', { exact: true }).fill('合成公平性条件')
    await reader.getByLabel('填写框架', { exact: true }).selectOption('t2i-fairness')
    await reader.getByRole('button', { name: '预览空白填写提纲', exact: true }).click()
    const template = page.getByRole('dialog', { name: '插入填写提纲预览', exact: true })
    await template.getByRole('button', { name: '取消插入', exact: true }).click()
    await expect(reader.getByLabel('方法', { exact: true })).toHaveValue('')
    await reader.getByRole('button', { name: '预览空白填写提纲', exact: true }).click()
    await template.getByRole('button', { name: '仅插入空字段', exact: true }).click()
    const expectedMethod = '生成模型与版本：\n提示词条件：\n干预发生阶段：'
    await expect(reader.getByLabel('方法', { exact: true })).toHaveValue(expectedMethod)
    await expect(reader.getByLabel('研究问题', { exact: true })).toHaveValue('合成公平性条件')
    await reader.getByLabel('原文摘录', { exact: true }).fill(fixture.expectedQuote)
    await reader.getByLabel('PDF物理起始页', { exact: true }).fill(String(fixture.expectedPage))
    await reader.getByLabel('与判断的关系', { exact: true }).selectOption('mixed')
    await reader.getByRole('button', { name: '保存证据', exact: true }).click()
    await expect(reader.getByText(/编辑已同步/)).toBeVisible()
    await reader.getByRole('button', { name: '关闭', exact: true }).click()
    const evidencePath = join(fixture.root, '.mimir/library/evidence.json')
    const evidence = JSON.parse(readFileSync(evidencePath, 'utf8')), card = evidence.cards[0]
    expect(card.versions[0].quote).toBe(fixture.expectedQuote)
    expect(card.versions[0].method).toBe(expectedMethod)
    expect(card.versions[0].locator.pageStart).toBe(fixture.expectedPage)
    expect(card.versions[0].reviewState).toBe('draft')
    await page.getByRole('button', { name: '证据比较矩阵', exact: true }).click()
    await expect(page.getByRole('table', { name: '证据比较表' })).toContainText('合成公平性条件')
    await page.getByRole('button', { name: '研究问题与写作素材', exact: true }).click()
    await page.getByRole('button', { name: '新建问题', exact: true }).click()
    await page.getByLabel('问题标题', { exact: true }).fill('闭环问题')
    await page.getByRole('button', { name: '选择证据', exact: true }).click()
    const picker = page.getByRole('dialog', { name: '选择已有证据', exact: true })
    await picker.getByLabel(`选择证据 ${card.id}`, { exact: true }).check()
    await picker.getByRole('button', { name: '应用选择', exact: true }).click()
    await page.getByRole('button', { name: '保存问题', exact: true }).click()
    await expect(page.getByText('问题已保存', { exact: true })).toBeVisible()
    const researchPath = join(fixture.root, '.mimir/library/research.json')
    const question = JSON.parse(readFileSync(researchPath, 'utf8')).questions[0]
    await page.getByRole('button', { name: '写作素材', exact: true }).click()
    await page.getByRole('button', { name: '新建素材包', exact: true }).click()
    await page.getByLabel('素材包标题', { exact: true }).fill('闭环写作素材')
    await page.getByLabel('选入问题', { exact: true }).selectOption(question.id)
    await page.getByRole('button', { name: '从问题组选入证据', exact: true }).click()
    await picker.getByLabel(`选择证据 ${card.id}`, { exact: true }).check()
    await picker.getByRole('button', { name: '应用选择', exact: true }).click()
    await page.getByLabel('拟写小节 1', { exact: true }).fill('适用条件')
    await page.getByRole('button', { name: '保存素材包', exact: true }).click()
    await expect(page.getByText('素材包已保存，历史引用保留', { exact: true })).toBeVisible()
    const pack = JSON.parse(readFileSync(researchPath, 'utf8')).packs[0]
    expect(pack.versions[0].items[0].evidenceVersion).toBe(1)
    await page.getByRole('button', { name: '导出素材', exact: true }).click()
    const exportDialog = page.getByRole('dialog', { name: '导出写作素材', exact: true })
    const preview = await exportDialog.locator('pre').textContent(), output = join(ctx.tempHome.root, 'workflow.md')
    expect(preview).toContain(fixture.expectedQuote)
    expect(preview).toContain(expectedMethod)
    await ctx.app.evaluate(({ dialog }, filePath) => { dialog.showSaveDialog = (async () => ({ canceled: false, filePath })) as never }, output)
    await exportDialog.getByRole('button', { name: '保存为新文件', exact: true }).click()
    await expect(exportDialog.getByText('已保存为 workflow.md', { exact: true })).toBeVisible()
    expect(readFileSync(output, 'utf8')).toBe(preview)
    await exportDialog.getByRole('button', { name: '关闭预览', exact: true }).click()
    const frozen = readFileSync(researchPath), originalEvidence = readFileSync(evidencePath)
    reopened = await reopenEvidenceApp(ctx)
    await gotoModule(reopened.page, 'library')
    await expect(reopened.page.getByRole('button', { name: '新建素材包', exact: true })).toBeVisible()
    await expect(reopened.page.getByLabel('素材包标题', { exact: true })).toHaveValue('闭环写作素材')
    expect(readFileSync(researchPath)).toEqual(frozen)
    expect(readFileSync(evidencePath)).toEqual(originalEvidence)
    expect(readFileSync(otherFile)).toEqual(otherBefore)
  } finally { try { await reopened?.app.close() } finally { await ctx.cleanup() } }
})
