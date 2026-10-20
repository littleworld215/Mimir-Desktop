import { useEffect, useRef, useState } from 'react'
import type { PlanningApi, PlanningInput, PlanningScope } from '../../shared/researchPlanningContracts'

export interface DraftIdentity { id: string; itemId: string | null; baseRevision: number }
function draftSession(api: PlanningApi, scope: PlanningScope, identity: DraftIdentity) {
  let revision: number | undefined, queue: Promise<unknown> = Promise.resolve()
  const enqueue = <T,>(run: () => Promise<T>) => { const task = queue.then(run); queue = task.catch(() => {}); return task }
  async function read() {
    const result = await api.drafts({ scope })
    if (!result.ok) throw Error(result.message)
    revision = result.revision
    return result.drafts
  }
  return {
    settle: () => queue,
    save: (input: PlanningInput) => enqueue(async () => {
      if (revision === undefined) await read()
      const result = await api.saveDraft({ scope, expectedRevision: revision!, draft: { ...identity, input } })
      if (!result.ok) throw Error(result.message)
      revision = result.revision
    }),
    remove: () => enqueue(async () => {
      // 删除前读取最新独立修订；只删除本编辑会话，不清空其它草稿。
      const drafts = await read()
      if (!drafts.some(d => d.id === identity.id)) return
      const result = await api.removeDraft({ scope, expectedRevision: revision!, draftId: identity.id })
      if (!result.ok) throw Error(result.message)
      revision = result.revision
    })
  }
}
export function usePlanningDraft(scope?: PlanningScope, identity?: DraftIdentity) {
  const [session] = useState(() => {
    const api = window.electronAPI?.researchPlanning
    return scope && typeof api?.drafts === 'function' && typeof api.saveDraft === 'function' && typeof api.removeDraft === 'function' ? draftSession(api, scope, identity ?? { id: crypto.randomUUID(), itemId: null, baseRevision: 0 }) : null
  })
  const [status, setStatus] = useState(session ? '恢复草稿仅在编辑暂停后保存' : '恢复草稿接口不可用，仍可正式保存')
  const [busy, setBusy] = useState(false)
  const timer = useRef<ReturnType<typeof setTimeout>>(), active = useRef(true), paused = useRef(false)
  function cancelTimer() { clearTimeout(timer.current) }
  useEffect(() => { active.current = true; return () => { active.current = false; cancelTimer() } }, [])
  return {
    status, busy,
    schedule(input: PlanningInput, dirty: boolean) {
      cancelTimer()
      if (!session || !dirty || paused.current) return
      timer.current = setTimeout(() => {
        setBusy(true); setStatus('恢复草稿保存中…（尚未正式保存）')
        void session.save(structuredClone(input)).then(() => { if (active.current) setStatus('恢复草稿已保存（尚未正式保存）') }).catch(error => { if (active.current) setStatus(`恢复草稿保存失败：${error instanceof Error ? error.message : '请重试'}；输入保留`) }).finally(() => { if (active.current) setBusy(false) })
      }, 500)
    },
    async pause() { paused.current = true; cancelTimer(); await session?.settle() },
    resume() { paused.current = false },
    async keep(input: PlanningInput) {
      if (!session) { setStatus('恢复草稿接口不可用，输入保留；请正式保存或取消编辑。'); return false }
      paused.current = true; cancelTimer(); setBusy(true)
      try { await session.save(structuredClone(input)); if (active.current) setStatus('恢复草稿已保留，尚未正式保存'); return true }
      catch (error) { paused.current = false; if (active.current) setStatus(`恢复草稿保存失败：${error instanceof Error ? error.message : '请重试'}；输入保留`); return false }
      finally { if (active.current) setBusy(false) }
    },
    async remove() { paused.current = true; cancelTimer(); await session?.remove() }
  }
}
