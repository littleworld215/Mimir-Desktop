import { useEffect, useRef, useState } from 'react'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'

export function SettingsBackupCard({ disabledReason }: { disabledReason?: string }) {
  const [open, setOpen] = useState(false), [busy, setBusy] = useState(false), [error, setError] = useState(''), [requested, setRequested] = useState(false)
  const running = useRef(false), active = useRef(true), errorRef = useRef<HTMLParagraphElement>(null)
  const enter = window.electronAPI?.workspaceBackup?.enterMaintenance
  const reason = disabledReason || (!enter ? '当前版本未提供维护入口，请更新桌面程序，或使用维护启动参数。' : '')
  useEffect(() => { active.current = true; return () => { active.current = false } }, [])
  useEffect(() => { if (error) errorRef.current?.focus() }, [error])
  async function request() {
    if (running.current || reason || !enter) return
    running.current = true; setBusy(true); setError(''); setRequested(false)
    try {
      const result = await enter()
      if (!result?.ok) throw Error('REQUEST_REJECTED')
      if (active.current) setRequested(true)
    } catch {
      if (active.current) setError('未能发起维护交接。当前输入已保留，请处理关闭提示后重试；也可使用维护启动参数。')
    } finally {
      running.current = false
      if (active.current) setBusy(false)
    }
  }
  return <section aria-label="备份与恢复" className="space-y-3 rounded-lg border border-border bg-card p-4">
    <h3 className="text-sm font-semibold">备份与恢复</h3>
    <p className="text-xs text-muted-foreground">保存并关闭工作台后进入离线维护。可备份整个科研空间、检查归档，或恢复为新空间；原空间保留。</p>
    {reason && <p className="text-xs text-muted-foreground">{reason}</p>}
    <Button type="button" variant="outline" disabled={Boolean(reason) || busy} onClick={() => { setError(''); setRequested(false); setOpen(true) }}>备份与恢复</Button>
    <Dialog open={open} onOpenChange={next => { if (!running.current) setOpen(next) }}>
      <DialogContent><DialogHeader><DialogTitle>进入备份与恢复</DialogTitle><DialogDescription>确认后将按现有退出保护关闭日常窗口，等待任务和资源结束，再启动维护窗口。此操作只切换模式，不会自动生成备份或覆盖资料；若取消关闭，则留在工作台。</DialogDescription></DialogHeader>
        {reason && <p role="status" className="text-sm">{reason}</p>}
        {error && <p role="alert" ref={errorRef} tabIndex={-1} className="text-sm text-destructive">{error}</p>}
        {requested && <p role="status" className="text-sm">已请求进入维护，请处理关闭提示；若选择留在这里，可处理输入后再次进入。</p>}
        <DialogFooter><Button type="button" variant="outline" disabled={busy} onClick={() => setOpen(false)}>取消</Button><Button type="button" disabled={busy || Boolean(reason)} onClick={() => void request()}>{busy ? '正在请求…' : '关闭工作台并进入维护'}</Button></DialogFooter>
      </DialogContent>
    </Dialog>
  </section>
}
