import { expect, it } from 'vitest'
import * as templates from '../../../src/lib/evidenceTemplates'
import { evidenceFields } from '../../../src/components/modules/library/evidence/EvidenceEditor'
const api = templates as unknown as { evidenceTemplateHints(id: string): Record<string, string>; previewEvidenceTemplate(fields: ReturnType<typeof evidenceFields>, id: string): { next: ReturnType<typeof evidenceFields>; changed: string[] } }
it('T2I提示覆盖公平性、模型条件、交叉群体、指标局限，提纲不填实验事实', () => {
  expect(api.evidenceTemplateHints).toBeTypeOf('function')
  const hints = Object.values(api.evidenceTemplateHints('t2i-fairness')).join('\n')
  for (const topic of ['公平性', '模型', '交叉群体', '指标', '不确定性', '识别器', '文化', '证据']) expect(hints).toContain(topic)
  expect(hints).not.toMatch(/Stable Diffusion|DALL|\d+%/)
})
it('仅填六个空字符串，空白与原文/位置/项目/判断完整保留且没有别名', () => {
  expect(api.previewEvidenceTemplate).toBeTypeOf('function')
  const fields = { ...evidenceFields('paper', ['p']), quote: '  原文😀\n', method: '  ', locator: { pageStart: 2 }, relation: 'opposes' as const }
  const before = structuredClone(fields), preview = api.previewEvidenceTemplate(fields, 't2i-fairness')
  expect(fields).toEqual(before); expect(preview.next.quote).toBe(fields.quote); expect(preview.next.method).toBe('  ')
  expect(preview.changed).toEqual(['question', 'datasetOrMaterial', 'finding', 'limitation', 'comment'])
  expect(preview.next.locator).toEqual(fields.locator); expect(preview.next.relation).toBe('opposes')
  preview.next.projectIds.push('other'); preview.next.locator.pageStart = 3
  expect(fields).toEqual(before)
  for (const key of preview.changed) expect(Array.from(preview.next[key as keyof typeof fields] as string).length).toBeLessThan(2000)
})
