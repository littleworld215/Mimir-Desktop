/**
 * `electron/assets/validation.ts` 单元测试。
 *
 * 本文件首要任务：钉住 `assertPositiveId` —— 该函数此前**零用例覆盖**，而它正是
 * 「IPC 参数 → 数据库主键」的唯一闸门。一旦它退化成 `Number(input)` 的隐式转换，
 * `true` / `[1]` 会被凑巧转成 `1` 并命中真实资产（越权读写别人的资产）。
 * 因此下面对每一种「能被 Number() 悄悄转成合法数字」的形态都钉死拒绝。
 */

import { describe, expect, it } from 'vitest'

import { AssetsValidationError, assertPositiveId } from '../../../electron/assets/validation'

describe('assertPositiveId', () => {
  describe('接受', () => {
    it('数字 1 → 1', () => {
      expect(assertPositiveId(1)).toBe(1)
    })

    it('数字 42 → 42', () => {
      expect(assertPositiveId(42)).toBe(42)
    })

    it('数字取 MAX_SAFE_INTEGER 边界仍接受', () => {
      expect(assertPositiveId(Number.MAX_SAFE_INTEGER)).toBe(Number.MAX_SAFE_INTEGER)
    })

    it("字符串 '1' → 1", () => {
      expect(assertPositiveId('1')).toBe(1)
    })

    it("字符串 '42' → 42", () => {
      expect(assertPositiveId('42')).toBe(42)
    })

    it("字符串 '9007199254740991' → 同值", () => {
      expect(assertPositiveId('9007199254740991')).toBe(9007199254740991)
    })

    it('返回值是 number 类型（不是原样返回字符串）', () => {
      expect(typeof assertPositiveId('7')).toBe('number')
    })

    it('自定义 label 出现在报错信息里', () => {
      expect(() => assertPositiveId(-1, 'assetId')).toThrow(/assetId/)
    })
  })

  describe('拒绝：能被 Number() 隐式转成 1 的非数字形态', () => {
    it('true 必须拒绝（Number(true) === 1）', () => {
      expect(() => assertPositiveId(true)).toThrow(AssetsValidationError)
    })

    it('false 必须拒绝（Number(false) === 0）', () => {
      expect(() => assertPositiveId(false)).toThrow(AssetsValidationError)
    })

    it('[1] 必须拒绝（Number([1]) === 1）', () => {
      expect(() => assertPositiveId([1])).toThrow(AssetsValidationError)
    })

    it('[] 必须拒绝（Number([]) === 0）', () => {
      expect(() => assertPositiveId([])).toThrow(AssetsValidationError)
    })

    it('{} 必须拒绝', () => {
      expect(() => assertPositiveId({})).toThrow(AssetsValidationError)
    })
  })

  describe('拒绝：非十进制整数字符串', () => {
    it("'1.5' 必须拒绝（小数）", () => {
      expect(() => assertPositiveId('1.5')).toThrow(AssetsValidationError)
    })

    it("'1e3' 必须拒绝（科学计数法）", () => {
      expect(() => assertPositiveId('1e3')).toThrow(AssetsValidationError)
    })

    it("'-1' 必须拒绝（负号）", () => {
      expect(() => assertPositiveId('-1')).toThrow(AssetsValidationError)
    })

    it("'' 必须拒绝（空串）", () => {
      expect(() => assertPositiveId('')).toThrow(AssetsValidationError)
    })

    it("' 1 ' 必须拒绝（前后空格）", () => {
      expect(() => assertPositiveId(' 1 ')).toThrow(AssetsValidationError)
    })

    it("'+1' 必须拒绝（正号）", () => {
      expect(() => assertPositiveId('+1')).toThrow(AssetsValidationError)
    })

    it("'0x10' 必须拒绝（十六进制）", () => {
      expect(() => assertPositiveId('0x10')).toThrow(AssetsValidationError)
    })

    it("'0' 必须拒绝（零不是正数）", () => {
      expect(() => assertPositiveId('0')).toThrow(AssetsValidationError)
    })

    it("'9007199254740992' 必须拒绝（超出 safe integer）", () => {
      expect(() => assertPositiveId('9007199254740992')).toThrow(AssetsValidationError)
    })
  })

  describe('拒绝：非法数字', () => {
    it('0 必须拒绝', () => {
      expect(() => assertPositiveId(0)).toThrow(AssetsValidationError)
    })

    it('-1 必须拒绝', () => {
      expect(() => assertPositiveId(-1)).toThrow(AssetsValidationError)
    })

    it('1.5 必须拒绝（非整数）', () => {
      expect(() => assertPositiveId(1.5)).toThrow(AssetsValidationError)
    })

    it('NaN 必须拒绝', () => {
      expect(() => assertPositiveId(NaN)).toThrow(AssetsValidationError)
    })

    it('Infinity 必须拒绝', () => {
      expect(() => assertPositiveId(Infinity)).toThrow(AssetsValidationError)
    })

    it('-Infinity 必须拒绝', () => {
      expect(() => assertPositiveId(-Infinity)).toThrow(AssetsValidationError)
    })

    it('MAX_SAFE_INTEGER + 1 必须拒绝', () => {
      expect(() => assertPositiveId(Number.MAX_SAFE_INTEGER + 1)).toThrow(AssetsValidationError)
    })
  })

  describe('拒绝：空值', () => {
    it('null 必须拒绝', () => {
      expect(() => assertPositiveId(null)).toThrow(AssetsValidationError)
    })

    it('undefined 必须拒绝', () => {
      expect(() => assertPositiveId(undefined)).toThrow(AssetsValidationError)
    })
  })
})
