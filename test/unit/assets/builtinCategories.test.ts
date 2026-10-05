/**
 * 预置分类回归（`electron/assets/schema.ts` 的 BUILTIN_CATEGORIES）。
 *
 * 目的：把预置分类从「随意 15 项」钉成与来源 `server/src/db/seed.ts`
 * （CATEGORIES / AI_TREE / inbox）**语义一致**：code / name / defaultStorageType / parentCode
 * 必须对齐来源，防止后续漂移（如漏掉 skill、把 experiment-paradigm 写成 experiment-log、
 * 把 file 型分类写成 inline_text）。
 */
import { describe, expect, it } from 'vitest'
import { BUILTIN_CATEGORIES } from '../../../electron/assets/schema'
import type { BuiltinCategory } from '../../../electron/assets/schema'

const EXPECTED_CODES = [
  'inbox',
  'literature-note',
  'code-template',
  'experiment-paradigm',
  'workflow-spec',
  'rule',
  'skill',
  'prompt',
  'glossary',
  'writing-material',
  'experience',
  'ai-collab',
  'domain-nlp',
  'task-polish',
  'scene-pre-submit'
]

const byCode: Record<string, BuiltinCategory> = Object.fromEntries(
  BUILTIN_CATEGORIES.map((c) => [c.code, c])
)

describe('BUILTIN_CATEGORIES：与来源 seed.ts 对齐', () => {
  it('共 15 项，code 集合精确匹配', () => {
    expect(BUILTIN_CATEGORIES).toHaveLength(15)
    const codes = BUILTIN_CATEGORIES.map((c) => c.code)
    expect(new Set(codes).size).toBe(15)
    expect([...codes].sort()).toEqual([...EXPECTED_CODES].sort())
  })

  it('file 型分类：code-template / experiment-paradigm / inbox', () => {
    expect(byCode['code-template'].defaultStorageType).toBe('file')
    expect(byCode['experiment-paradigm'].defaultStorageType).toBe('file')
    expect(byCode['inbox'].defaultStorageType).toBe('file')
  })

  it('其余顶层分类均为 inline_text', () => {
    const inlineCodes = [
      'literature-note',
      'workflow-spec',
      'rule',
      'skill',
      'prompt',
      'glossary',
      'writing-material',
      'experience'
    ]
    for (const code of inlineCodes) {
      expect(byCode[code].defaultStorageType).toBe('inline_text')
    }
  })

  it('关键名称与来源一致（skill / 规则约束 / 实验记录范式）', () => {
    expect(byCode['skill'].name).toBe('Skill')
    expect(byCode['rule'].name).toBe('规则约束')
    expect(byCode['experiment-paradigm'].name).toBe('实验记录范式')
    expect(byCode['inbox'].name).toBe('未分类')
  })

  it('AI 子树 parent 链：ai-collab → domain-nlp → task-polish → scene-pre-submit', () => {
    expect(byCode['ai-collab'].parentCode).toBeNull()
    expect(byCode['domain-nlp'].parentCode).toBe('ai-collab')
    expect(byCode['task-polish'].parentCode).toBe('domain-nlp')
    expect(byCode['scene-pre-submit'].parentCode).toBe('task-polish')
    expect(byCode['ai-collab'].defaultStorageType).toBe('inline_text')
    expect(byCode['domain-nlp'].defaultStorageType).toBe('inline_text')
    expect(byCode['task-polish'].defaultStorageType).toBe('inline_text')
    expect(byCode['scene-pre-submit'].defaultStorageType).toBe('inline_text')
  })

  it('inbox 为顶层（parentCode null）', () => {
    expect(byCode['inbox'].parentCode).toBeNull()
  })

  it('所有 parentCode 均指向存在的分类 code', () => {
    const codes = new Set(BUILTIN_CATEGORIES.map((c) => c.code))
    for (const c of BUILTIN_CATEGORIES) {
      if (c.parentCode !== null) expect(codes.has(c.parentCode)).toBe(true)
    }
  })
})
