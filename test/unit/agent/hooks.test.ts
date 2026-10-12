/**
 * 插件 Hooks 运行时消费单测（新批次 B）。
 *
 * 守护点（本文件存在的理由）：
 * 1. **防御式解析**：store 未就绪 / 非数组 / 坏项一律不抛，只取 enabled 且事件匹配的项。
 * 2. **事件名以 UI 为准**：只认 `agent:beforeTool` / `agent:afterTool`；
 *    旧注释里的 `onBeforeTool` / `onContextReady` 永不命中（防止接线接了个空）。
 * 3. **失败隔离**：钩子分派绝不能让工具调用失败——loadHooks 抛错也要吞。
 * 4. **脱敏**：describeToolCall 只出工具名与错误**类名**，绝不出 message / 参数值。
 * 5. **不执行**：本批 actionType 为 script/command/http 时**只记录，不执行**（零安全面扩张）。
 *
 * 说明：`electron/library/store` 由 vitest alias 指向内存桩（见 vitest.config.ts），
 * 故本测试直接 `setStoreValue('plugins:hooks', ...)` 即可驱动「用户配置」。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

const hoisted = vi.hoisted(() => ({ logInfo: vi.fn(), logError: vi.fn() }))

// logger 走真实 electron-log（会 import electron app）→ 测试中打桩。
vi.mock('../../../electron/logger', () => ({
  default: { info: hoisted.logInfo, error: hoisted.logError, warn: vi.fn(), scope: vi.fn() }
}))

import { HOOKS_STORE_KEY, dispatchHooks, describeToolCall, loadHooks, type HookConfig } from '../../../electron/agent/hooks'
import { setStoreValue } from '../../stubs/store'

const hook = (over: Partial<HookConfig> = {}): HookConfig => ({
  id: 'h-1',
  name: '测试钩子',
  description: '',
  event: 'agent:beforeTool',
  actionType: 'script',
  payload: 'console.log(1)',
  enabled: true,
  createdAt: '2026-10-12T00:00:00.000Z',
  ...over
})

beforeEach(() => {
  hoisted.logInfo.mockClear()
  hoisted.logError.mockClear()
  setStoreValue(HOOKS_STORE_KEY, [])
})

describe('loadHooks —— 防御式解析', () => {
  it('store 为空数组 → 空结果，不抛', () => {
    expect(loadHooks('agent:beforeTool')).toEqual([])
  })

  it('store 非数组（字符串/对象/null）→ 空结果，不抛', () => {
    for (const bad of ['x', { a: 1 }, null, 42]) {
      setStoreValue(HOOKS_STORE_KEY, bad)
      expect(loadHooks('agent:beforeTool')).toEqual([])
    }
  })

  it('只取 enabled === true 的项', () => {
    setStoreValue(HOOKS_STORE_KEY, [
      hook({ id: 'on', enabled: true }),
      hook({ id: 'off', enabled: false })
    ])
    const result = loadHooks('agent:beforeTool')
    expect(result.map((h) => h.id)).toEqual(['on'])
  })

  it('只取事件精确匹配的项', () => {
    setStoreValue(HOOKS_STORE_KEY, [
      hook({ id: 'before', event: 'agent:beforeTool' }),
      hook({ id: 'after', event: 'agent:afterTool' }),
      hook({ id: 'msg', event: 'message:beforeSend' })
    ])
    expect(loadHooks('agent:beforeTool').map((h) => h.id)).toEqual(['before'])
    expect(loadHooks('agent:afterTool').map((h) => h.id)).toEqual(['after'])
  })

  it('旧注释事件名 onBeforeTool / onContextReady 永不命中（UI 里不存在）', () => {
    setStoreValue(HOOKS_STORE_KEY, [
      hook({ id: 'legacy-1', event: 'onBeforeTool' }),
      hook({ id: 'legacy-2', event: 'onContextReady' })
    ])
    expect(loadHooks('agent:beforeTool')).toEqual([])
    expect(loadHooks('agent:afterTool')).toEqual([])
  })

  it('坏项（非对象 / actionType 非法）被跳过，其余项保留', () => {
    setStoreValue(HOOKS_STORE_KEY, [
      'not-an-object',
      null,
      hook({ id: 'bad-action', actionType: 'wat' as HookConfig['actionType'] }),
      hook({ id: 'good' })
    ])
    expect(loadHooks('agent:beforeTool').map((h) => h.id)).toEqual(['good'])
  })

  it('顺序 = store 数组顺序（不额外排序）', () => {
    setStoreValue(HOOKS_STORE_KEY, [
      hook({ id: 'c' }),
      hook({ id: 'a' }),
      hook({ id: 'b' })
    ])
    expect(loadHooks('agent:beforeTool').map((h) => h.id)).toEqual(['c', 'a', 'b'])
  })
})

describe('dispatchHooks —— 分派与失败隔离', () => {
  it('无匹配钩子 → 返回 0，不写日志', () => {
    expect(dispatchHooks('agent:beforeTool', { toolName: 'read_file', detail: 'tool=read_file' })).toBe(0)
    expect(hoisted.logInfo).not.toHaveBeenCalled()
  })

  it('匹配 N 条 → 返回 N 且逐条记录', () => {
    setStoreValue(HOOKS_STORE_KEY, [hook({ id: '1' }), hook({ id: '2' })])
    expect(dispatchHooks('agent:beforeTool', { toolName: 't', detail: 'tool=t' })).toBe(2)
    expect(hoisted.logInfo).toHaveBeenCalledTimes(2)
  })

  it('【安全面】三种 actionType 均只记录、不执行（日志含 unsupported）', () => {
    setStoreValue(HOOKS_STORE_KEY, [
      hook({ id: 's', actionType: 'script', payload: 'rm -rf /' }),
      hook({ id: 'c', actionType: 'command', payload: 'calc.exe' }),
      hook({ id: 'h', actionType: 'http', payload: 'http://evil.example/x' })
    ])
    expect(dispatchHooks('agent:beforeTool', { toolName: 't', detail: 'tool=t' })).toBe(3)
    // payload 原文**绝不**出现在日志里（脱敏）。
    for (const call of hoisted.logInfo.mock.calls) {
      const line = String(call[0])
      expect(line).toContain('unsupported')
      expect(line).not.toContain('rm -rf /')
      expect(line).not.toContain('calc.exe')
      expect(line).not.toContain('evil.example')
    }
  })

  it('日志设施抛错时仍不抛、且不影响返回值（失败隔离）', () => {
    hoisted.logInfo.mockImplementation(() => {
      throw new Error('日志设施坏了')
    })
    setStoreValue(HOOKS_STORE_KEY, [hook({ id: '1' })])
    expect(() => dispatchHooks('agent:beforeTool', { toolName: 't', detail: 'tool=t' })).not.toThrow()
    // 记录失败的那条不计入 dispatched（逐条隔离），但不抛。
    expect(dispatchHooks('agent:beforeTool', { toolName: 't', detail: 'tool=t' })).toBe(0)
  })
})

describe('describeToolCall —— 脱敏', () => {
  it('无错误 → 只含工具名', () => {
    expect(describeToolCall('read_file')).toBe('tool=read_file')
  })

  it('有错误 → 只出错误**类名**，不出 message（message 可能含路径）', () => {
    const err = new TypeError('ENOENT: D:/secret/private.txt')
    const detail = describeToolCall('read_file', err)
    expect(detail).toBe('tool=read_file error=TypeError')
    expect(detail).not.toContain('secret')
    expect(detail).not.toContain('private.txt')
    expect(detail).not.toContain('ENOENT')
  })

  it('非 Error 错误 → 出 typeof，不出内容', () => {
    expect(describeToolCall('t', 'some-string-error')).toBe('tool=t error=string')
    expect(describeToolCall('t', 42)).toBe('tool=t error=number')
  })
})
