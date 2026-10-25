import { useEffect, useRef, useState } from 'react'
import type { MaintenanceRecoveryAction, MaintenanceRecoveryList, MaintenanceRecoveryResult, MaintenanceRecoveryStatus, WorkspaceBackupMaintenanceApi } from '../../../shared/workspaceBackupContracts'

const descriptions: Record<MaintenanceRecoveryStatus, string> = {
  'pending-registration': '已发布，待复核登记', registered: '已登记', 'staging-retained': '暂存已保留，执行前还需核对',
  interrupted: '操作中断，缺少完整摘要，请人工检查', 'no-output': '未发现恢复产物', cleaned: '暂存已清理', blocked: '身份或登记有变化，请人工检查'
}
interface Props {
  api: WorkspaceBackupMaintenanceApi
  refreshVersion: number
  disabled?: boolean
  onChanged?(): void | Promise<void>
  onBusyChange?(busy: boolean): void
}
export function RestoreRecoveryPanel({ api, refreshVersion, disabled, onChanged, onBusyChange }: Props) {
  const [view, setView] = useState<MaintenanceRecoveryList>()
  const [failed, setFailed] = useState(false)
  const [loading, setLoading] = useState(false)
  const [refresh, setRefresh] = useState(0)
  const [page, setPage] = useState<{ version: number; cursor?: string }>({ version: refreshVersion })
  const cursor = page.version === refreshVersion ? page.cursor : undefined
  const [busy, setBusy] = useState(false)
  const [result, setResult] = useState<MaintenanceRecoveryResult>()
  const alive = useRef(true), pending = useRef(false)
  useEffect(() => { alive.current = true; return () => { alive.current = false } }, [])
  useEffect(() => {
    let current = true
    if (typeof api.recoveryList !== 'function') return
    setLoading(true); setFailed(false)
    void api.recoveryList(cursor).then(value => { if (current) setView(value) }).catch(() => { if (current) setFailed(true) }).finally(() => { if (current) setLoading(false) })
    return () => { current = false }
  }, [api, refreshVersion, refresh, cursor])
  async function action(operationId: string, kind: MaintenanceRecoveryAction) {
    if (disabled || busy || loading || pending.current || view?.writable === false || typeof api.recoveryAction !== 'function') return
    pending.current = true
    setBusy(true); setResult(undefined); onBusyChange?.(true)
    try {
      const outcome = await api.recoveryAction({ operationId, action: kind })
      if (!alive.current) return
      setResult(outcome)
      if (outcome.ok) await onChanged?.()
    } catch {
      if (alive.current) setResult({ ok: false, code: 'INTERNAL', detail: '恢复处理请求未能完成，请重新读取记录确认状态。' })
    } finally {
      pending.current = false
      if (alive.current) { setBusy(false); setRefresh(value => value + 1); onBusyChange?.(false) }
    }
  }
  return <section aria-label="中断恢复记录" aria-busy={loading || busy}>
    <h2>中断恢复与登记</h2>
    <p>已发布的新空间可复核后继续登记；暂存清理需要确认，并再次核对目录身份和内容。记录只显示阶段与数量。</p>
    {typeof api.recoveryList !== 'function' ? <p>当前版本尚未提供中断恢复入口。</p> : <>
      {view?.writable === false && <p role="note">当前为只读维护。恢复写入前需按规约确认并处理现有写锁，再重新进入维护。</p>}
      {failed && <p role="alert">恢复记录未能读取，不能据此认定没有中断任务。请重新读取。</p>}
      {loading && <p role="status">正在读取恢复记录…</p>}
      {busy && <p role="status">正在核对恢复资料，请等待操作结果…</p>}
      {!failed && view && (view.items.length ? <ul>{view.items.map(item => <li key={item.operationId}>
        <strong>{item.spaceName}</strong> — {descriptions[item.status]}；{item.entries} 个归档条目；<time dateTime={item.createdAt}>{new Date(item.createdAt).toLocaleString()}</time>
        {item.actions.includes('register') && <button type="button" disabled={disabled || busy || loading || !view.writable || typeof api.recoveryAction !== 'function'} onClick={() => void action(item.operationId, 'register')}>复核并完成登记</button>}
        {item.actions.includes('cleanup') && <button type="button" disabled={disabled || busy || loading || !view.writable || typeof api.recoveryAction !== 'function'} onClick={() => void action(item.operationId, 'cleanup')}>核对并清理暂存…</button>}
      </li>)}</ul> : view.invalidRecords === 0 && !view.truncated ? <p>{cursor ? '本页没有可显示的记录，可返回首页重新读取。' : '没有恢复操作记录。'}</p> : null)}
      {!!view?.invalidRecords && <p role="alert">有 {view.invalidRecords} 份记录无法安全读取，原文件已保留，请人工检查。</p>}
      {view?.truncated && <p role="note">每页最多50条，使用下一页继续查看，原记录保留。</p>}
      {view?.nextCursor && <button type="button" disabled={loading || busy} onClick={() => setPage({ version: refreshVersion, cursor: view.nextCursor })}>下一页恢复记录</button>}
      {cursor && <button type="button" disabled={loading || busy} onClick={() => setPage({ version: refreshVersion })}>返回恢复记录首页</button>}
      <button type="button" disabled={loading || busy} onClick={() => { setPage({ version: refreshVersion }); setRefresh(value => value + 1) }}>重新读取恢复记录</button>
    </>}
    {result && (result.ok
      ? <p role="status">{result.action === 'register' ? result.alreadyRegistered ? '该空间已登记，未重复追加。' : '已完成同一空间的登记。' : '已清理本次恢复暂存。'}</p>
      : <p role={result.code === 'CANCELLED' ? 'status' : 'alert'}>{result.detail}（{result.code}）</p>)}
  </section>
}
