import { expect, it } from 'vitest'
import fixture from '../../fixtures/assets/i5-source-prompts.json'
import { POLISH_PROMPT, RESTRUCTURE_PROMPT, TAG_SUGGEST_PROMPT, ORIGINAL_VAR } from '../../../electron/assets/aiPrompts'
import { parseTagSuggestions } from '../../../electron/assets/tagSuggestions'

it('默认Prompt逐字等于冻结来源输出，目标测试不导入来源树', () => {
  expect({ POLISH_PROMPT, RESTRUCTURE_PROMPT, TAG_SUGGEST_PROMPT, ORIGINAL_VAR }).toEqual(fixture.prompts)
})
it('标签JSON数组/对象与围栏、行降级、去重、规范名和截断', () => {
  const existing = [{ id: 1, name: 'Rust' }]
  expect(parseTagSuggestions('```json\n{"tags":["rust",{"name":"模型"},"RUST",null]}\n```', existing)).toMatchObject({ items: [{ name: 'rust', existingTagId: 1 }, { name: '模型', existingTagId: null }], mode: 'json' })
  expect(parseTagSuggestions('1. Rust\n- 模型\n* 模型\n无效;标签\n无效，标签', existing, 1)).toMatchObject({ items: [{ name: 'Rust', existingTagId: 1 }], truncated: true })
  expect(parseTagSuggestions(' ', existing)).toMatchObject({ items: [], mode: 'empty' })
})
