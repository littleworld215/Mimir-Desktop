import { useEffect, useState } from 'react'
import { localPlanningDate } from '../../shared/researchPlanningDates'

/** 日期变化才触发刷新；窗口恢复焦点时立即校对，长期驻留也不会停在昨天。 */
export function usePlanningToday() {
  const [today, setToday] = useState(localPlanningDate)
  useEffect(() => {
    const update = () => setToday(localPlanningDate()), timer = setInterval(update, 60_000)
    window.addEventListener('focus', update)
    return () => { clearInterval(timer); window.removeEventListener('focus', update) }
  }, [])
  return today
}
