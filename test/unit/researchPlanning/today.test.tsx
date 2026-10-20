// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest'
import { act, cleanup, renderHook } from '@testing-library/react'
import { usePlanningToday } from '../../../src/lib/usePlanningToday'

afterEach(() => { cleanup(); vi.useRealTimers() })
it('跨午夜或恢复窗口焦点后更新本地日历日期，不一直停留在昨天', () => {
  vi.useFakeTimers(); vi.setSystemTime(new Date('2026-10-20T23:59:50'))
  const hook = renderHook(usePlanningToday)
  expect(hook.result.current).toBe('2026-10-20')
  act(() => { vi.advanceTimersByTime(70_000) })
  expect(hook.result.current).toBe('2026-10-21')
  act(() => { vi.setSystemTime(new Date('2026-10-22T09:00:00')); window.dispatchEvent(new Event('focus')) })
  expect(hook.result.current).toBe('2026-10-22')
})
