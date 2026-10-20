// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { PlanningCalendar } from '../../../src/components/modules/planning/PlanningCalendar'
afterEach(cleanup)
it('日历定位不能把不可表示的完整周范围交给父组件导致渲染崩溃', () => {
  const onChange = vi.fn()
  render(<PlanningCalendar anchor="2026-10-20" mode="week-grid" days={[]} selected={null} busy={false} onChange={onChange} onSelect={vi.fn()} onCreate={vi.fn()} onOpen={vi.fn()} />)
  fireEvent.change(screen.getByLabelText('日历定位日期'), { target: { value: '9999-12-31' } })
  expect(onChange).not.toHaveBeenCalled()
  expect(screen.getByRole('alert')).toBeTruthy()
})
