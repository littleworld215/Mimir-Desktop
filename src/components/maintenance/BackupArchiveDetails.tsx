import { useEffect, useRef, useState } from 'react'
import type { MaintenanceArchiveDetailsResult, MaintenanceDoctorProgress, WorkspaceBackupMaintenanceApi } from '../../../shared/workspaceBackupContracts'
import { BackupScopeView } from './BackupScopeView'
import { MaintenanceTaskControls } from './MaintenanceTaskControls'

export function BackupArchiveDetails({ api, archiveId, progress, onClose, onBusyChange }: {
  api: WorkspaceBackupMaintenanceApi
  archiveId: string
  progress?: MaintenanceDoctorProgress
  onClose(): void
  onBusyChange?(busy: boolean): void
}) {
  const root = useRef<HTMLElement>(null), originalFocus = useRef(document.activeElement instanceof HTMLElement ? document.activeElement : null)
  const generation = useRef(0)
  const [cursor, setCursor] = useState({ id: archiveId, offset: 0, retry: 0 })
  const offset = cursor.id === archiveId ? cursor.offset : 0
  const [answer, setAnswer] = useState<{ id: string; offset: number; result: MaintenanceArchiveDetailsResult }>()
  const [loading, setLoading] = useState(false)
  const result = answer?.id === archiveId && answer.offset === offset ? answer.result : undefined
  useEffect(() => {
    root.current?.querySelector<HTMLButtonElement>('button')?.focus()
    return () => { if (originalFocus.current?.isConnected) originalFocus.current.focus() }
  }, [])
  useEffect(() => {
    const version = ++generation.current
    let active = true
    setLoading(true); setAnswer(undefined); onBusyChange?.(true)
    let request: Promise<MaintenanceArchiveDetailsResult>
    try {
      request = api.archiveDetails ? api.archiveDetails({ archiveId, offset })
        : Promise.resolve({ ok: false as const, code: 'UNSUPPORTED', detail: '当前主进程不支持展开归档说明，请使用匹配版本。' })
    } catch { request = Promise.resolve({ ok: false, code: 'READ_FAILED', detail: '读取归档说明失败，请重新读取清单后重试。' }) }
    void request.catch(() => ({ ok: false as const, code: 'READ_FAILED', detail: '读取归档说明失败，请重新读取清单后重试。' })).then(result => {
      if (!active || generation.current !== version) return
      setAnswer({ id: archiveId, offset, result }); setLoading(false); onBusyChange?.(false)
    })
    return () => { active = false; onBusyChange?.(false) }
  }, [api, archiveId, offset, cursor.retry, onBusyChange])
  const close = () => {
    if (loading && progress?.stage === 'archive-details' && progress.taskId) void api.cancelTask?.({ taskId: progress.taskId })
    onClose()
  }
  return <div className="backup-scope-overlay"><section ref={root} className="backup-scope-dialog" role="dialog" aria-modal="true" aria-label="归档范围说明" onKeyDown={event => {
    if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); close() }
    if (event.key === 'Tab') {
      const controls = Array.from(root.current?.querySelectorAll<HTMLElement>('button:not([disabled]), [tabindex="0"]') ?? [])
      const first = controls[0], last = controls[controls.length - 1]
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus() }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus() }
    }
  }}>
    <h2>归档范围说明</h2><button type="button" onClick={close}>关闭说明</button>
    {loading && <><p role="status">正在读取归档说明…</p><MaintenanceTaskControls api={api} progress={progress} label="取消读取归档说明" /></>}
    {result && !result.ok && <><p role="alert">{result.detail}</p><button type="button" onClick={() => setCursor({ id: archiveId, offset, retry: cursor.retry + 1 })}>重试读取</button></>}
    {result?.ok && <>
      <BackupScopeView scope={result.page.summary} verification="not-run" />
      <p>范围条目从第 {result.page.offset + 1} 项开始，每页最多100项；外部目标只作文本展示。</p>
      {result.page.items.length ? <ul className="backup-scope-items" tabIndex={0}>{result.page.items.map((item, i) => <li key={result.page.offset + i}>
        {item.kind === 'excluded' ? <>未纳入：{item.entry.path}（{item.entry.size}字节，超限）</>
          : <>未包含/未核实：{item.entry.target}<br />引用：{item.entry.storeKey}　{item.entry.locator}　{item.entry.field}</>}
      </li>)}</ul> : <p>没有可列出的声明；未知范围不能据此认定没有遗漏。</p>}
      {offset > 0 && <button type="button" onClick={() => setCursor({ id: archiveId, offset: Math.max(0, offset - 100), retry: 0 })}>上一页</button>}
      {result.page.nextOffset !== undefined && <button type="button" onClick={() => setCursor({ id: archiveId, offset: result.page.nextOffset!, retry: 0 })}>下一页</button>}
    </>}
  </section></div>
}
