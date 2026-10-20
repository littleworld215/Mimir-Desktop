import type { PlanningInput } from './researchPlanningContracts'

function date(value: string) {
  const parsed = new Date(`${value}T12:00:00Z`)
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value) || !Number.isFinite(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== value) throw Error('日期不存在')
  return parsed
}
function format(value: Date) { const text = value.toISOString().slice(0, 10); if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) throw Error('日期超出支持范围'); return text }
export function localPlanningDate(value = new Date()) { return `${value.getFullYear().toString().padStart(4, '0')}-${(value.getMonth() + 1).toString().padStart(2, '0')}-${value.getDate().toString().padStart(2, '0')}` }
export function addCalendarDays(value: string, days: number) { const parsed = date(value); parsed.setUTCDate(parsed.getUTCDate() + days); return format(parsed) }
export function addCalendarMonths(value: string, months: number) {
  const parsed = date(value), day = parsed.getUTCDate()
  parsed.setUTCDate(1); parsed.setUTCMonth(parsed.getUTCMonth() + months)
  const end = new Date(parsed); end.setUTCMonth(end.getUTCMonth() + 1, 0)
  parsed.setUTCDate(Math.min(day, end.getUTCDate()))
  return format(parsed)
}
export function nextRecurringDate(due: string, rule: NonNullable<PlanningInput['recurrence']>, today: string) {
  if (!Number.isInteger(rule.interval) || rule.interval < 1 || rule.interval > 99) throw Error('重复间隔非法')
  const base = date(due), now = date(today)
  if (rule.unit === 'daily' || rule.unit === 'weekly') {
    const step = rule.interval * (rule.unit === 'weekly' ? 7 : 1)
    const periods = Math.max(1, Math.floor((now.getTime() - base.getTime()) / 86_400_000 / step) + 1)
    return addCalendarDays(due, periods * step)
  }
  const distance = (now.getUTCFullYear() - base.getUTCFullYear()) * 12 + now.getUTCMonth() - base.getUTCMonth()
  let periods = Math.max(1, Math.floor(distance / rule.interval))
  let candidate = addCalendarMonths(due, periods * rule.interval)
  while (candidate <= today) candidate = addCalendarMonths(due, ++periods * rule.interval)
  return candidate
}
export function calendarRange(anchor: string, mode: 'week' | 'month') {
  const parsed = date(anchor), first = mode === 'month' ? `${anchor.slice(0, 7)}-01` : anchor
  const from = addCalendarDays(first, -(date(first).getUTCDay() + 6) % 7)
  if (mode === 'week') return { from, to: addCalendarDays(from, 6) }
  parsed.setUTCMonth(parsed.getUTCMonth() + 1, 0)
  const last = format(parsed)
  return { from, to: addCalendarDays(last, (7 - date(last).getUTCDay()) % 7) }
}
