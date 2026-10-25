import { useEffect, useRef, useState } from 'react'
import type { WorkspaceBackupMaintenanceApi } from '../../../shared/workspaceBackupContracts'

export function MaintenanceTaskControls({ api, progress, label }: {
  api: WorkspaceBackupMaintenanceApi
  progress?: { taskId?: string; cancellable?: boolean }
  label: string
}) {
  const id = progress?.taskId
  const current = useRef(id)
  current.current = id
  useEffect(() => () => { current.current = undefined }, [])
  const [request, setRequest] = useState<{ id?: string; pending?: boolean; accepted?: boolean; notice?: string }>({})
  const same = request.id === id
  const disabled = !id || !api.cancelTask || progress?.cancellable === false || (same && (request.pending || request.accepted))
  async function cancel() {
    if (disabled || !id || !api.cancelTask) return
    setRequest({ id, pending: true, notice: '正在发送取消请求…' })
    try {
      const result = await api.cancelTask({ taskId: id })
      if (current.current !== id) return
      setRequest({ id, accepted: result.ok, notice: result.ok ? '已请求取消，正在等待安全点和资源收尾。' : result.code === 'NOT_CANCELLABLE' ? '已进入提交阶段，无法安全取消。' : `取消未被接受（${result.code ?? '未知原因'}）。` })
    } catch {
      if (current.current === id) setRequest({ id, notice: '取消请求未能送达，请重试。' })
    }
  }
  return <div>
    <button type="button" disabled={!!disabled} onClick={() => void cancel()}>{label}</button>
    {progress?.cancellable === false
      ? <p role="status">已进入提交阶段，无法安全取消。</p>
      : same && request.notice ? <p role="status">{request.notice}</p> : !api.cancelTask ? <p>当前版本不支持按任务取消。</p> : null}
  </div>
}
