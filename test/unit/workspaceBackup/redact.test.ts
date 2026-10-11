/**
 * `redact.ts` 单测（I6 批次 4 · T01）。
 *
 * 覆盖设计稿 §6 `redact.test.ts` 一行：绝对路径 → basename（含 Windows 盘符与 POSIX）；
 * 敏感键名剔除（嵌套对象里也剔除）；数组递归；URL 不被误伤；`redactText` 对中文文案生效；
 * **必须含**「凭据键值绝不出现在输出中」的断言（并做变异验证，见任务说明）。
 */

import { describe, expect, it } from 'vitest'

import {
  isSensitiveKey,
  redactText,
  redactValue,
  SENSITIVE_KEY_PATTERNS
} from '../../../electron/workspaceBackup/redact'

describe('redactValue · 绝对路径 → basename', () => {
  it('Windows 盘符路径 → basename', () => {
    expect(redactValue('D:\\a\\b.pdf')).toBe('b.pdf')
    expect(redactValue('C:/科研/我的空间/papers/a.pdf')).toBe('a.pdf')
  })

  it('POSIX 绝对路径 → basename', () => {
    expect(redactValue('/home/u/a.pdf')).toBe('a.pdf')
  })

  it('相对路径/普通字符串原样保留', () => {
    expect(redactValue('papers/a.pdf')).toBe('papers/a.pdf')
    expect(redactValue('hello world')).toBe('hello world')
  })
})

describe('redactValue · 敏感键名剔除', () => {
  it('顶层敏感键整个移除', () => {
    const input = { apiKey: 'SECRET123', name: 'ok' }
    const output = redactValue(input) as Record<string, unknown>
    expect(output).not.toHaveProperty('apiKey')
    expect(output.name).toBe('ok')
  })

  it('嵌套对象里的敏感键也剔除', () => {
    const input = { outer: { inner: { token: 'abc', keep: 1 } } }
    const output = redactValue(input) as Record<string, unknown>
    expect(JSON.stringify(output)).not.toContain('abc')
    expect(JSON.stringify(output)).toContain('keep')
  })

  it('大小写不敏感 + 包含匹配', () => {
    expect(isSensitiveKey('Authorization')).toBe(true)
    expect(isSensitiveKey('my_API_TOKEN')).toBe(true)
    expect(isSensitiveKey('userPassword')).toBe(true)
    expect(isSensitiveKey('credential')).toBe(true)
    expect(isSensitiveKey('note')).toBe(false)
  })
})

describe('redactValue · 数组递归', () => {
  it('数组元素逐项脱敏（路径 → basename）', () => {
    const input = ['/home/u/a.pdf', 'D:\\x\\y.pdf', 'plain']
    expect(redactValue(input)).toEqual(['a.pdf', 'y.pdf', 'plain'])
  })

  it('数组内对象的敏感键也被剔除', () => {
    const input = [{ secret: 'S1', file: '/a/b/c.pdf' }]
    const output = redactValue(input) as Array<Record<string, unknown>>
    expect(output[0]).not.toHaveProperty('secret')
    expect(output[0].file).toBe('c.pdf')
  })
})

describe('redactValue · URL 不被误伤', () => {
  it('https URL 保持原样', () => {
    expect(redactValue('https://example.com/a/b')).toBe('https://example.com/a/b')
    expect(redactValue('http://host:8080/x.pdf')).toBe('http://host:8080/x.pdf')
  })
})

describe('redactText · 混在中文文案里的绝对路径', () => {
  it('替换文案中的绝对路径片段为 basename', () => {
    expect(redactText('归档内旧空间根：D:\\a\\b')).toBe('归档内旧空间根：b')
    expect(redactText('已从 /home/u/papers/a.pdf 读取')).toBe('已从 a.pdf 读取')
  })

  it('URL 在文案里也不被误伤', () => {
    expect(redactText('参考 https://example.com/a/b 与 /home/u/x.pdf')).toBe(
      '参考 https://example.com/a/b 与 x.pdf'
    )
  })
})

describe('redactValue · 凭据零泄漏（红线断言）', () => {
  it('凭据键值绝不出现在输出中', () => {
    const input = {
      ok: true,
      nested: {
        apiKey: 'SECRET123',
        authorization: 'Bearer XYZ',
        list: [{ password: 'PWD!', file: '/home/u/a.pdf' }]
      }
    }
    const serialized = JSON.stringify(redactValue(input))
    expect(serialized).not.toContain('SECRET123')
    expect(serialized).not.toContain('Bearer XYZ')
    expect(serialized).not.toContain('PWD!')
    // 非敏感信息保留（含 basename 化后的文件名），证明不是「整个对象被清空」的假绿。
    expect(serialized).toContain('a.pdf')
  })
})

describe('redactValue · 纯函数性（不修改入参）', () => {
  it('入参对象不被改写', () => {
    const input = { apiKey: 'SECRET123', file: '/home/u/a.pdf' }
    const snapshot = JSON.stringify(input)
    redactValue(input)
    expect(JSON.stringify(input)).toBe(snapshot)
  })
})

describe('SENSITIVE_KEY_PATTERNS · 表本身是非空（支撑变异验证）', () => {
  it('至少包含 6 条敏感模式', () => {
    expect(SENSITIVE_KEY_PATTERNS.length).toBe(6)
  })
})
