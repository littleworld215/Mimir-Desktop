/**
 * 资产库 IPC 错误与注册面合同测试（I1-08）。
 *
 * 守护点：
 * - 完整注册固定28条资产通道，不注册多余通道；
 * - 返回值恒为判别联合 `{ ok: true, ... } | { ok: false, code, message }`，**从不抛异常**；
 * - 业务错误回传 `AssetsStoreError.code`；分页 / scope 非法 → `BAD_REQUEST`；
 * - 未知异常回 `WRITE_FAILED`，**不回传 SQL / 堆栈**，但主进程要落日志。
 *
 * 说明：共享桩 `test/stubs/electron.ts` 没有 `ipcMain`，故在**本文件内局部** stub electron，
 * 不改共享桩（符合整合计划 §5.1「须局部增补」）。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

const hoisted = vi.hoisted(() => ({
  handlers: new Map<string, (...args: unknown[]) => unknown>(),
  context: vi.fn(),
  getForRequest: vi.fn(),
  logError: vi.fn()
}))

vi.mock('electron', () => ({
  ipcMain: {
    handle: (channel: string, handler: (...args: unknown[]) => unknown): void => {
      hoisted.handlers.set(channel, handler)
    }
  }
}))

vi.mock('../../electron/assets/store', () => ({
  assetsStoreManager: { context: hoisted.context, getForRequest: hoisted.getForRequest }
}))

vi.mock('../../electron/logger', () => ({
  default: { error: hoisted.logError, warn: vi.fn(), info: vi.fn(), scope: vi.fn() }
}))

import { registerAssetsHandlers, parseWriteCondition } from '../../electron/ipc/assets'
import { AssetsStoreError } from '../../electron/assets/types'
import { ASSETS_CHANNELS } from '../../shared/assetsContracts'

const SCOPE = { workspaceId: 'w1', spaceEpoch: 'w1#1' }

/** 取已注册的 handler（未注册则抛，避免测试静默通过）。 */
function handler(channel: string): (...args: unknown[]) => unknown {
  const fn = hoisted.handlers.get(channel)
  if (fn === undefined) throw new Error(`未注册的通道：${channel}`)
  return fn
}

/** 构造一个只用于读取计数的假上下文。 */
function fakeContext(count: number): unknown {
  return {
    write: (operation: (session: unknown) => unknown): unknown =>
      operation({ get: () => ({ n: count }), all: () => [] })
  }
}

beforeEach(() => {
  hoisted.handlers.clear()
  hoisted.context.mockReset()
  hoisted.getForRequest.mockReset()
  hoisted.logError.mockReset()
  registerAssetsHandlers()
})

describe('注册面', () => {
  it('完整注册合同28条通道，不注册任意通道', () => {
    const expected = Object.values(ASSETS_CHANNELS).sort()
    expect([...hoisted.handlers.keys()].sort()).toEqual(expected)
  })
})

describe('assets:context', () => {
  it('有空间时返回 { ok: true, context }', async () => {
    hoisted.context.mockReturnValue(SCOPE)
    const result = await handler(ASSETS_CHANNELS.context)()
    expect(result).toEqual({ ok: true, context: SCOPE })
  })

  it('无空间时返回 NO_ACTIVE_WORKSPACE 而不抛异常', async () => {
    hoisted.context.mockImplementation(() => {
      throw new AssetsStoreError('NO_ACTIVE_WORKSPACE', '当前没有激活的科研空间。')
    })
    const result = await handler(ASSETS_CHANNELS.context)()
    expect(result).toEqual({
      ok: false,
      code: 'NO_ACTIVE_WORKSPACE',
      message: '当前没有激活的科研空间。'
    })
  })
})

describe('parseWriteCondition —— R6 三态（absent / 显式 null / 正整数）', () => {
  it('缺省 expectedCurrentVersionId → 不传该字段', () => {
    expect(parseWriteCondition({ expectedRevision: 1 })).toEqual({ expectedRevision: 1 })
  })
  it('显式 null → 保留为「当前应当无版本」，不静默丢弃（与 WriteCondition 契约一致）', () => {
    expect(parseWriteCondition({ expectedRevision: 1, expectedCurrentVersionId: null })).toEqual({
      expectedRevision: 1,
      expectedCurrentVersionId: null
    })
  })
  it('正整数 → 透传该 id', () => {
    expect(parseWriteCondition({ expectedRevision: 1, expectedCurrentVersionId: 5 })).toEqual({
      expectedRevision: 1,
      expectedCurrentVersionId: 5
    })
  })
  it('key存在但值为undefined不能丢弃版本条件，明确拒绝', () => {
    expect(() => parseWriteCondition({ expectedRevision: 1, expectedCurrentVersionId: undefined })).toThrow()
  })
  it('非法类型（字符串 / 负数）→ BAD_REQUEST', () => {
    expect(() => parseWriteCondition({ expectedRevision: 1, expectedCurrentVersionId: 'x' })).toThrow()
    expect(() => parseWriteCondition({ expectedRevision: 1, expectedCurrentVersionId: -1 })).toThrow()
  })
  it('缺少 expectedRevision → BAD_REQUEST', () => {
    expect(() => parseWriteCondition({ expectedCurrentVersionId: 1 })).toThrow()
  })
})

describe('assets:list —— scope 校验', () => {
  it.each([
    ['缺少空间上下文', undefined],
    ['空间标识非法', { spaceEpoch: 'w1#1' }],
    ['空间代际非法', { workspaceId: 'w1' }],
    ['空标识', { workspaceId: '', spaceEpoch: 'w1#1' }]
  ])('%s → BAD_REQUEST', async (_name, request) => {
    const result = (await handler(ASSETS_CHANNELS.list)({}, request)) as { ok: boolean; code?: string }
    expect(result.ok).toBe(false)
    expect(result.code).toBe('BAD_REQUEST')
    expect(hoisted.getForRequest).not.toHaveBeenCalled()
  })
})

describe('assets:list —— 分页校验（不接受隐式类型转换）', () => {
  it.each([
    ['page=0', { page: 0 }],
    ['page=1.5', { page: 1.5 }],
    ['page=true', { page: true }],
    ["page='2'", { page: '2' }],
    ['pageSize=0', { pageSize: 0 }],
    ['pageSize=201', { pageSize: 201 }],
    ['pageSize=NaN', { pageSize: Number.NaN }]
  ])('%s → BAD_REQUEST', async (_name, paging) => {
    const result = (await handler(ASSETS_CHANNELS.list)({}, { ...SCOPE, ...paging })) as {
      ok: boolean
      code?: string
    }
    expect(result.ok).toBe(false)
    expect(result.code).toBe('BAD_REQUEST')
    expect(hoisted.getForRequest).not.toHaveBeenCalled()
  })

  it('合法分页透传并返回真实计数与空列表', async () => {
    hoisted.getForRequest.mockResolvedValue(fakeContext(2))
    const result = (await handler(ASSETS_CHANNELS.list)({}, { ...SCOPE, page: 2, pageSize: 10 })) as {
      ok: boolean
      page?: { items: unknown[]; total: number; page: number; pageSize: number }
    }
    expect(result.ok).toBe(true)
    expect(result.page).toEqual({ items: [], total: 2, page: 2, pageSize: 10 })
  })

  it('缺省分页使用 1 / 50', async () => {
    hoisted.getForRequest.mockResolvedValue(fakeContext(0))
    const result = (await handler(ASSETS_CHANNELS.list)({}, SCOPE)) as {
      page?: { page: number; pageSize: number }
    }
    expect(result.page?.page).toBe(1)
    expect(result.page?.pageSize).toBe(50)
  })
})

describe('assets:list —— 业务错误与未知异常', () => {
  it('空间已切换 → SPACE_CHANGED', async () => {
    hoisted.getForRequest.mockRejectedValue(
      new AssetsStoreError('SPACE_CHANGED', '科研空间已切换，操作已中止，请重新获取空间上下文。')
    )
    const result = (await handler(ASSETS_CHANNELS.list)({}, SCOPE)) as { ok: boolean; code?: string }
    expect(result).toEqual({
      ok: false,
      code: 'SPACE_CHANGED',
      message: '科研空间已切换，操作已中止，请重新获取空间上下文。'
    })
  })

  it('未知异常 → WRITE_FAILED，不泄漏 SQL / 堆栈，但主进程落日志', async () => {
    hoisted.getForRequest.mockRejectedValue(
      new Error('SQLITE_ERROR: near "SELEC": syntax error\n    at Object.<anonymous> (C:\\secret\\store.ts:42:7)')
    )
    const result = (await handler(ASSETS_CHANNELS.list)({}, SCOPE)) as {
      ok: boolean
      code?: string
      message?: string
    }
    expect(result.ok).toBe(false)
    expect(result.code).toBe('WRITE_FAILED')
    expect(result.message ?? '').not.toContain('SQLITE')
    expect(result.message ?? '').not.toContain('store.ts')
    expect(hoisted.logError).toHaveBeenCalledTimes(1)
  })
})
