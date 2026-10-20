import { expect, it } from 'vitest'
import { addCalendarDays, addCalendarMonths, calendarRange, nextRecurringDate } from '../../../shared/researchPlanningDates'

it('日历算术覆盖闰年和跨年，不依赖时区或夏令时的24小时长度', () => {
  expect(addCalendarDays('2024-02-28', 1)).toBe('2024-02-29')
  expect(addCalendarDays('2026-12-31', 1)).toBe('2027-01-01')
  expect(addCalendarMonths('2024-01-31', 1)).toBe('2024-02-29')
  expect(addCalendarMonths('2026-01-31', 1)).toBe('2026-02-28')
})
it.each([
  ['2026-10-01', '2026-10-20', 'daily', 1, '2026-10-21'],
  ['2026-10-01', '2026-10-20', 'weekly', 2, '2026-10-29'],
  ['2026-01-31', '2026-02-28', 'monthly', 1, '2026-03-31'],
  ['2026-11-01', '2026-10-20', 'daily', 1, '2026-11-02']
] as const)('周期%s，完成于%s，%s/%s下一期为%s', (due, today, unit, interval, expected) => {
  expect(nextRecurringDate(due, { unit, interval }, today)).toBe(expected)
})
it('周范围从周一开始；月历完整覆盖整月且不超过42天', () => {
  expect(calendarRange('2026-10-20', 'week')).toEqual({ from: '2026-10-19', to: '2026-10-25' })
  expect(calendarRange('2026-11-15', 'month')).toEqual({ from: '2026-10-26', to: '2026-12-06' })
})
