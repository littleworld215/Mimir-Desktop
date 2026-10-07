import { useEffect, useRef, useState } from 'react'
import type { WorkspaceRequest } from '../../../../shared/assetsContracts'
import { assetsApi } from './assetsApi'
import { errorMessage } from './assetsUi'

export type AiWrite = <T>(operation: (scope: WorkspaceRequest) => Promise<T>) => Promise<T>

/** 取消独立于父级忙碌守卫；卸载后仍通知主进程，但不更新旧界面。 */
export function useAiOperation(scope: WorkspaceRequest, write: AiWrite) {
  const [busy, setBusy] = useState(false), [elapsed, setElapsed] = useState(0)
  const [error, setError] = useState(''), [notice, setNotice] = useState('')
  const alive = useRef(false), working = useRef(false)
  const pending = useRef<{ id: string; cancelRequested: boolean; canceled: boolean } | null>(null)
  useEffect(() => {
    alive.current = true
    return () => {
      alive.current = false
      if (pending.current) {
        pending.current.cancelRequested = true
        void assetsApi.cancelAiRequest({ ...scope, requestId: pending.current.id }).catch(() => {})
      }
    }
  }, [scope.workspaceId, scope.spaceEpoch])
  useEffect(() => {
    if (!busy) return
    const timer = setInterval(() => setElapsed(s => s + 1), 1000)
    return () => clearInterval(timer)
  }, [busy])
  async function run<T>(operation: (s: WorkspaceRequest, requestId: string) => Promise<T>, model = false): Promise<T | undefined> {
    if (working.current) return
    working.current = true
    const request = { id: crypto.randomUUID(), cancelRequested: false, canceled: false }
    if (model) pending.current = request
    setBusy(true); setElapsed(0); setError(''); setNotice('')
    try {
      const result = await write(s => operation(s, request.id))
      if (!alive.current) return
      if (request.cancelRequested) {
        setNotice(request.canceled ? '已取消模型请求。' : '取消请求已发出；结果可能已完成，请在待采纳草稿中核对。')
        return
      }
      return result
    } catch (e) {
      if (alive.current) {
        if (request.canceled) setNotice('已取消模型请求。')
        else setError(`${errorMessage(e)} 输入已保留，可重试或检查模型设置。`)
      }
    } finally {
      if (pending.current === request) pending.current = null
      working.current = false
      if (alive.current) setBusy(false)
    }
  }
  async function cancel() {
    const request = pending.current
    if (!request || request.cancelRequested) return
    request.cancelRequested = true
    try {
      const result = await assetsApi.cancelAiRequest({ ...scope, requestId: request.id })
      request.canceled = result.canceled
      if (alive.current) setNotice(result.canceled ? '正在取消模型请求…' : '请求可能已完成；请等待返回并检查草稿。')
    } catch (e) {
      if (alive.current) setError(`取消未确认：${errorMessage(e)}；请等待返回并检查草稿。`)
    }
  }
  return { busy, elapsed, error, notice, working, alive, run, cancel, setError, setNotice }
}
