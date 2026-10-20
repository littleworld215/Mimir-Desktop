import { useEffect, useRef, useState } from 'react'
import { registerEvidenceEditor, requestEvidenceLeave } from '@/lib/evidenceEditGuard'

export const researchControl = 'w-full rounded-md border border-border bg-background px-2 py-1.5 text-sm text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring'
export const researchMessage = (error: unknown) => error instanceof Error ? error.message.replace(/^[A-Z_]+:\s*/, '') : '操作未完成，输入已保留，请重试'
/** 已接受的保存用固定输入；父刷新不得重置正在编辑的表单。 */
export function useResearchForm<T>(initial: T, save: (input: T) => Promise<void | (() => void)>, externalBusy = false, beforeDiscard?: () => Promise<void>) {
  const [form, setFormState] = useState(() => structuredClone(initial)), [busy, setBusy] = useState(false), [error, setError] = useState('')
  const errorRef = useRef<HTMLParagraphElement>(null)
  useEffect(() => { if (error && !busy) errorRef.current?.focus() }, [error, busy])
  const current = useRef(form), base = useRef(JSON.stringify(form)), active = useRef(true), working = useRef(false), external = useRef(externalBusy), action = useRef(save)
  const discardAction = useRef(beforeDiscard); discardAction.current = beforeDiscard
  external.current = externalBusy; action.current = save
  function setForm(next: T) { if (!working.current && !external.current) { current.current = next; setFormState(next) } }
  function discard() {
    if (working.current || external.current) return
    const reset = () => { const next = JSON.parse(base.current) as T; current.current = next; setFormState(next); setError('') }
    if (!discardAction.current) { reset(); return }
    working.current = true; setBusy(true)
    return discardAction.current().then(reset).catch(failure => { if (active.current) setError(researchMessage(failure)); throw failure }).finally(() => { working.current = false; if (active.current) setBusy(false) })
  }
  async function persist(): Promise<boolean> {
    if (!active.current || working.current || external.current) return false
    working.current = true; setBusy(true); setError('')
    const input = structuredClone(current.current)
    try {
      const notify = await action.current(input)
      if (!active.current) return false
      base.current = JSON.stringify(input)
      if (typeof notify === 'function') notify()
      return true
    } catch (failure) { if (active.current) setError(researchMessage(failure)); return false }
    finally { working.current = false; if (active.current) setBusy(false) }
  }
  const persistRef = useRef(persist); persistRef.current = persist
  async function leave(onLeave?: () => void) {
    if (!active.current || working.current || external.current) return
    if (await requestEvidenceLeave() && active.current) onLeave?.()
  }
  useEffect(() => {
    active.current = true
    const remove = registerEvidenceEditor({ isDirty: () => JSON.stringify(current.current) !== base.current, isBusy: () => working.current || external.current, save: () => persistRef.current(), discard })
    return () => { active.current = false; remove() }
  }, [])
  // 仅用于调用方已经成功持久化恢复草稿后的显式离开；不代表正式业务保存。
  function acceptPersistedDraft() { base.current = JSON.stringify(current.current) }
  return { form, setForm, persist, discard, leave, acceptPersistedDraft, error, errorRef, dirty: JSON.stringify(form) !== base.current, busy: busy || externalBusy }
}
export function useResearchBusy(busy: boolean) {
  const current = useRef(busy); current.current = busy
  useEffect(() => registerEvidenceEditor({ isDirty: () => false, isBusy: () => current.current, save: async () => !current.current, discard() {} }), [])
}
