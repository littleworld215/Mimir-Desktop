import { useEffect, useRef, useState } from 'react'
import { Button } from '@/components/ui/button'
import { useResearchBusy, useResearchForm } from '../library/research/useResearchForm'
import type { PlanningBackgroundInput, PlanningBackgroundState, PlanningScope } from '../../../../shared/researchPlanningContracts'

export function SettingsPlanningCard() {
  const [loaded, setLoaded] = useState<{ state: PlanningBackgroundState; scope: PlanningScope } | null>(null), [error, setError] = useState(''), [reload, setReload] = useState(0), [loading, setLoading] = useState(true)
  useResearchBusy(loading)
  useEffect(() => {
    let active = true; setLoading(true); setError('')
    void (async () => {
      try {
        const api = window.electronAPI?.researchPlanning
        if (!api?.background) throw Error('请使用新版桌面程序打开科研计划后台设置')
        const bootstrap = await api.bootstrap({}); if (!bootstrap.ok) throw Error(bootstrap.message)
        const result = await api.background({ scope: bootstrap.scope }); if (!result.ok) throw Error(result.message)
        if (active) setLoaded({ state: result.state, scope: bootstrap.scope })
      } catch (failure) { if (active) setError(failure instanceof Error ? failure.message : '读取失败，原设置保留') }
      finally { if (active) setLoading(false) }
    })()
    return () => { active = false }
  }, [reload])
  return <section aria-label="科研计划后台设置" className="space-y-3 rounded-lg border border-border bg-card p-4">
    <h3 className="text-sm font-semibold">提醒、托盘与开机启动</h3>
    <p className="text-sm text-muted-foreground">三个开关默认关闭，使用下方按钮单独保存。提醒仅在本程序运行期间检查当前科研空间；明确退出后不再提醒，不会自动切换空间。</p>
    {loading ? <p role="status">正在读取后台偏好…</p> : error ? <><p role="alert" className="text-sm text-destructive">{error}</p><Button variant="outline" onClick={() => setReload(v => v + 1)}>重试读取后台偏好</Button></> : loaded && <BackgroundForm key={reload} initial={loaded.state} scope={loaded.scope} onReload={() => setReload(v => v + 1)} />}
  </section>
}
function BackgroundForm({ initial, scope, onReload }: { initial: PlanningBackgroundState; scope: PlanningScope; onReload(): void }) {
  const [state, setState] = useState(initial), [notice, setNotice] = useState(''), revision = useRef(initial.preferences.revision)
  const p = initial.preferences
  const editor = useResearchForm<PlanningBackgroundInput>({ tray: p.tray, startup: p.startup, reminders: p.reminders }, async input => {
    const api = window.electronAPI?.researchPlanning
    if (!api) throw Error('桌面接口不可用，输入已保留')
    const result = await api.saveBackground({ scope, expectedRevision: revision.current, input })
    if (!result.ok) throw Error(result.message)
    revision.current = result.state.preferences.revision
    return () => { setState(result.state); setNotice('后台偏好已保存') }
  })
  const fields = [
    { key: 'tray' as const, label: '关闭窗口后驻留托盘', enabled: state.trayAvailable, text: '关闭按钮隐藏窗口并保留输入和运行任务；从托盘“退出”仍检查未保存内容并等待任务结束。' },
    { key: 'startup' as const, label: '开机启动', enabled: state.startupAvailable, text: state.startupAvailable ? '保存后为当前安装启用或关闭开机启动。更换安装位置后，请在这里核对并重新保存。' : '当前运行方式不支持开机启动，请在桌面安装包中设置。' },
    { key: 'reminders' as const, label: '运行期间提醒', enabled: state.notificationsAvailable, text: '启动、切换空间及每15分钟检查未完成到期/逾期待办，覆盖全部待办类型。每轮最多成功提醒5条，其余保留到下一轮；系统勿扰可能隐藏通知。' }
  ]
  const needsReapply = state.trayAvailable && state.trayActive !== editor.form.tray || state.startupAvailable && state.startupRegistered !== null && state.startupRegistered !== editor.form.startup
  return <div className="space-y-4">
    <fieldset disabled={editor.busy} className="space-y-4">{fields.map(field => <div key={field.key} className="space-y-1"><label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={editor.form[field.key]} disabled={!field.enabled} onChange={event => { setNotice(''); editor.setForm({ ...editor.form, [field.key]: event.target.checked }) }} />{field.label}</label><p className="text-xs text-muted-foreground">{field.text}</p></div>)}</fieldset>
    <p className="text-xs text-muted-foreground">托盘：{state.trayActive ? '运行中' : '未运行'} · 本安装开机项：{state.startupRegistered === null ? '无法确认' : state.startupRegistered ? '已启用' : '未启用'} · 偏好修订 {state.preferences.revision}</p>
    {needsReapply && !editor.dirty && <p className="text-sm">本安装的后台状态与保存偏好不一致，可点击下方保存按钮重新应用。</p>}
    {state.reminderStatus && <p role="status" className="text-xs text-muted-foreground">最近检查：{state.reminderStatus.checkedAt ?? '尚未检查'}；本轮送达 {state.reminderStatus.delivered}，待后续提醒 {state.reminderStatus.pending}{state.reminderStatus.errorCode ? `；检查状态 ${state.reminderStatus.errorCode}，可核对系统通知后重新保存或重启程序` : ''}</p>}
    {editor.error && <p role="alert" ref={editor.errorRef} tabIndex={-1} className="text-sm text-destructive">{editor.error}</p>}
    {notice && <p role="status" className="text-sm">{notice}</p>}
    <div className="flex flex-wrap gap-2"><Button disabled={editor.busy || !editor.dirty && !needsReapply} onClick={() => void editor.persist()}>保存科研计划后台偏好</Button><Button variant="outline" disabled={editor.busy} onClick={() => void editor.leave(onReload)}>重新读取后台状态</Button></div>
  </div>
}
