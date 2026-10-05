/**
 * 模板配置校验回归（对齐来源 `shared/src/template-config.ts` 的 `templateConfigError`）。
 *
 * 目的：把「模板配置」的限制从「宽松形状校验」钉成与来源**同一套限制**，
 * 防止目标实现与来源在类型枚举（single/multi vs select/multiselect）、
 * 上限（变量数 / 变量名长度 / options 项数与长度 / separator 长度 / 总 JSON 大小）、
 * 以及多余键（defaultValue 等）上悄悄漂移。
 */
import { describe, expect, it } from 'vitest'
import { AssetsValidationError, assertTemplateConfig } from '../../../electron/assets/validation'

describe('assertTemplateConfig：合法配置往返', () => {
  it('空配置（version=1 + 空 variables）通过且往返一致', () => {
    const cfg = { version: 1, variables: {} }
    const norm = assertTemplateConfig(cfg)
    expect(norm).toEqual(cfg)
    expect(assertTemplateConfig(norm)).toEqual(norm)
  })

  it('undefined / null → 规范化空配置', () => {
    const empty = { version: 1, variables: {} }
    expect(assertTemplateConfig(undefined)).toEqual(empty)
    expect(assertTemplateConfig(null)).toEqual(empty)
  })

  it('text / textarea / single / multi 四类变量往返一致（validate→规范化→再 validate）', () => {
    const cfg = {
      version: 1 as const,
      variables: {
        topic: { type: 'text' as const },
        body: { type: 'textarea' as const },
        field: { type: 'single' as const, options: ['CS', 'Bio'] },
        keywords: { type: 'multi' as const, options: ['nlp', 'cv'], separator: ', ' }
      }
    }
    const norm = assertTemplateConfig(cfg)
    expect(norm).toEqual(cfg)
    // 规范化结果再次校验应完全一致（幂等）
    expect(assertTemplateConfig(norm)).toEqual(norm)
  })

  it('恰好 100 个变量通过', () => {
    const variables: Record<string, unknown> = {}
    for (let i = 0; i < 100; i++) variables[`v${i}`] = { type: 'text' }
    expect(() => assertTemplateConfig({ version: 1, variables })).not.toThrow()
  })

  it('options 恰好 100 项、每项 500 字通过', () => {
    const options = Array.from({ length: 100 }, (_, i) => `${String(i).padStart(3, '0')}${'x'.repeat(497)}`)
    const cfg = { version: 1, variables: { big: { type: 'multi', options } } }
    expect(() => assertTemplateConfig(cfg)).not.toThrow()
  })
})

describe('assertTemplateConfig：非法配置逐条拒绝', () => {
  const reject = (input: unknown): void => {
    expect(() => assertTemplateConfig(input)).toThrow(AssetsValidationError)
  }

  it('非对象 / 数组', () => {
    reject('x')
    reject(42)
    reject([])
  })

  it('版本非法或 variables 非对象', () => {
    reject({ version: 2, variables: {} })
    reject({ version: 1, variables: [] })
    reject({ variables: {} })
  })

  it('多余顶层键', () => {
    reject({ version: 1, variables: {}, extra: 1 })
  })

  it('变量数超过 100', () => {
    const variables: Record<string, unknown> = {}
    for (let i = 0; i < 101; i++) variables[`v${i}`] = { type: 'text' }
    reject({ version: 1, variables })
  })

  it('变量名超长（>64）/ 含 {}: / 首尾空白 / 危险键', () => {
    reject({ version: 1, variables: { ['a'.repeat(65)]: { type: 'text' } } })
    reject({ version: 1, variables: { 'a{b': { type: 'text' } } })
    reject({ version: 1, variables: { 'a:b': { type: 'text' } } })
    reject({ version: 1, variables: { 'a}b': { type: 'text' } } })
    reject({ version: 1, variables: { ' a': { type: 'text' } } })
    reject({ version: 1, variables: { ['__proto__']: { type: 'text' } } })
    reject({ version: 1, variables: { constructor: { type: 'text' } } })
    reject({ version: 1, variables: { prototype: { type: 'text' } } })
  })

  it('type 非法 / 缺失 / 来源已移除的 select、multiselect', () => {
    reject({ version: 1, variables: { v: { type: 'select' } } })
    reject({ version: 1, variables: { v: { type: 'multiselect' } } })
    reject({ version: 1, variables: { v: { type: 'bogus' } } })
    reject({ version: 1, variables: { v: {} } })
  })

  it('变量对象含多余键（含已移除的 defaultValue）', () => {
    reject({ version: 1, variables: { v: { type: 'text', defaultValue: 'x' } } })
    reject({ version: 1, variables: { v: { type: 'text', foo: 1 } } })
  })

  it('single / multi 缺 options 或 options 为空', () => {
    reject({ version: 1, variables: { v: { type: 'single' } } })
    reject({ version: 1, variables: { v: { type: 'single', options: [] } } })
    reject({ version: 1, variables: { v: { type: 'multi' } } })
    reject({ version: 1, variables: { v: { type: 'multi', options: [] } } })
  })

  it('options 重复 / 超长 / 空串 / 非数组 / 超过 100 项', () => {
    reject({ version: 1, variables: { v: { type: 'multi', options: ['a', 'a'] } } })
    reject({ version: 1, variables: { v: { type: 'multi', options: ['x'.repeat(501)] } } })
    reject({ version: 1, variables: { v: { type: 'multi', options: [''] } } })
    reject({ version: 1, variables: { v: { type: 'multi', options: 'a' } } })
    reject({
      version: 1,
      variables: { v: { type: 'multi', options: Array.from({ length: 101 }, (_, i) => `o${i}`) } }
    })
  })

  it('separator 超长（>100）或非字符串', () => {
    reject({ version: 1, variables: { v: { type: 'text', separator: 'x'.repeat(101) } } })
    reject({ version: 1, variables: { v: { type: 'text', separator: 1 } } })
  })

  it('整个配置 JSON 超过 64000 字符', () => {
    const options = Array.from({ length: 100 }, (_, i) => `${String(i).padStart(3, '0')}${'x'.repeat(497)}`)
    const variables = {
      a: { type: 'multi', options },
      b: { type: 'multi', options }
    }
    reject({ version: 1, variables })
  })
})
