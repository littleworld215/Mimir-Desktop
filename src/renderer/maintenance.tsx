import { useEffect, useState } from 'react'
import { createRoot } from 'react-dom/client'
import type {
  DoctorCheck,
  DoctorSeverity,
  MaintenanceArchiveCandidate,
  MaintenanceAuditEntry,
  MaintenanceAuditView,
  MaintenanceDoctorProgress,
  MaintenanceDoctorResult,
  MaintenanceOverview,
  MaintenanceRestoreProgress,
  MaintenanceRestoreResult,
  WorkspaceBackupMaintenanceApi
} from '../../shared/workspaceBackupContracts'
import './maintenance.css'

declare global { interface Window { workspaceBackupMaintenance: WorkspaceBackupMaintenanceApi } }

/** 失败码 → 人话文案（§4.2 S7：渲染层只懂 code，不做任何路径拼接）。 */
function failureText(code: string): string {
  switch (code) {
    case 'TARGET_EXISTS':
      return '目标目录已存在。为避免覆盖你既有的资料，请换一个不存在的目标路径。'
    case 'INVALID_TARGET':
      return '目标路径无效：请确认填写的是绝对路径，且其父目录已存在。'
    case 'LOCK_UNAVAILABLE':
      return '维护会话不可用（可能已有其它窗口在写入）。请关闭其它实例后重试。'
    case 'NOT_LOCAL_DISK':
      return '目标不在本机磁盘上（可能是网络盘）。请选择本机目录后重试。'
    case 'RECHECK_FAILED':
    case 'DIGEST_MISMATCH':
    case 'INTEGRITY_FAILED':
      return '备份内容校验未通过，未完成恢复。请确认归档完整或联系支持。'
    case 'EXTRACT_FAILED':
      return '解压备份时失败，未完成恢复。请检查磁盘空间后重试。'
    default:
      return '恢复未完成。'
  }
}

/**
 * 恢复阶段标识（`MaintenanceRestoreProgress.stage`）→ 中文阶段名。
 *
 * 主进程上报的 `stage` 是稳定的机器标识（`inspecting` …），文案由渲染层映射，
 * 以便文案改动不需改主进程。未知阶段回退为「处理中」而非原样透出，避免露出内部标识。
 */
function stageText(stage: string): string {
  switch (stage) {
    case 'inspecting':
      return '正在校验归档'
    case 'extracting':
      return '正在解压'
    case 'verifying':
      return '正在复核'
    case 'publishing':
      return '正在发布'
    case 'registering':
      return '正在登记'
    default:
      return '正在处理'
  }
}

/**
 * 恢复到 `publishing` / `registering` 阶段后**不可安全取消**（会留下半成品 / 未注册目录）。
 * 取消按钮在这些阶段置灰，并提示不可取消（设计 §3.2）。
 */
function isRestoreUncancellable(stage: string | undefined): boolean {
  return stage === 'publishing' || stage === 'registering'
}

/**
 * 自检严重度 → 中文文字标签。
 *
 * ⚠️ 对齐 D-038 / 设计 §1.1 K1：只给「技术一致性」的**文字**结论，
 * **绝不做**打分、比例数字、环形图或任何替用户做科研判断的汇总结论。
 */
function severityText(severity: DoctorSeverity): string {
  switch (severity) {
    case 'ok':
      return '通过'
    case 'notice':
      return '可注意'
    case 'warning':
      return '偏离'
    case 'error':
      return '阻塞'
    default:
      return '未知'
  }
}

/** 审计动作 → 人话文案（`restore` / `doctor`）。 */
function auditActionText(action: MaintenanceAuditEntry['action']): string {
  switch (action) {
    case 'restore':
      return '恢复'
    case 'doctor':
      return '自检'
    default:
      return '未知'
  }
}

/** 审计结果 → 人话文案（`ok` / `failed`）。 */
function auditOutcomeText(outcome: MaintenanceAuditEntry['outcome']): string {
  return outcome === 'ok' ? '成功' : '失败'
}

/** 把审计条目的计数对象压成「k=v」短串（无计数则返回空串）。 */
function auditCountsText(counts: Readonly<Record<string, number>> | undefined): string {
  if (!counts) return ''
  const parts = Object.entries(counts).map(([key, value]) => `${key}=${value}`)
  return parts.join('，')
}

/** 单个归档候选的恢复表单状态。 */
interface RestoreForm { archive: MaintenanceArchiveCandidate; spaceName: string; targetRoot: string }

function MaintenanceApp() {
  const [result, setResult] = useState<MaintenanceOverview>()
  const [loading, setLoading] = useState(false)
  const [form, setForm] = useState<RestoreForm>()
  const [busy, setBusy] = useState(false)
  const [restoreResult, setRestoreResult] = useState<MaintenanceRestoreResult>()
  const [progress, setProgress] = useState<MaintenanceRestoreProgress>()

  // 自检面板状态：报告 / 进行中 / 自检进度 / 自检失败。
  const [doctorResult, setDoctorResult] = useState<MaintenanceDoctorResult>()
  const [doctorRunning, setDoctorRunning] = useState(false)
  const [doctorProgress, setDoctorProgress] = useState<MaintenanceDoctorProgress>()

  // 审计查看状态：最近条目（只读）。
  const [audit, setAudit] = useState<MaintenanceAuditView>()

  // 取消接线状态：恢复取消被拒时如实显示原因（不假装成功）。
  const [cancelNotice, setCancelNotice] = useState<string>()

  const api = window.workspaceBackupMaintenance

  async function refresh() {
    setLoading(true)
    try { setResult(await api.overview()) }
    catch { setResult({ ok: false, code: 'REGISTRY_INVALID' }) }
    finally { setLoading(false) }
  }
  useEffect(() => { void refresh() }, [])

  // 订阅恢复进度（可选增强）：旧主进程不提供时 `onRestoreProgress` 可能不存在，需降级。
  useEffect(() => {
    if (typeof api.onRestoreProgress !== 'function') return
    const unsubscribe = api.onRestoreProgress((next) => setProgress(next))
    return unsubscribe
  }, [api])

  // 订阅自检进度（可选增强）：照 `onRestoreProgress` 的降级写法（判存在再订阅，返回 unsubscribe）。
  useEffect(() => {
    if (typeof api.onDoctorProgress !== 'function') return
    const unsubscribe = api.onDoctorProgress((next) => setDoctorProgress(next))
    return unsubscribe
  }, [api])

  function openForm(archive: MaintenanceArchiveCandidate) {
    setRestoreResult(undefined)
    setProgress(undefined)
    setCancelNotice(undefined)
    setForm({ archive, spaceName: '', targetRoot: '' })
  }

  /**
   * 关闭恢复对话框 —— 修复批次 3 的 bug（原为 `busy` 时静默 `return`，用户无法中断）。
   *
   * 新语义（对齐设计 §3.2）：
   * - 非 busy：直接关闭表单。
   * - busy 且处于**可取消**阶段（`inspecting`/`extracting`/`verifying`）→ 调 `api.cancelRestore?.()`；
   *   如实反映返回：`NOT_SUPPORTED` → 「当前版本不支持中途取消」；`ok:false` 其它码亦如实提示。
   * - busy 且处于**不可取消**阶段（`publishing`/`registering`）→ 显示「已进入发布阶段，无法安全取消」。
   */
  async function closeForm() {
    if (!busy) {
      setForm(undefined)
      return
    }
    if (isRestoreUncancellable(progress?.stage)) {
      setCancelNotice('已进入发布阶段，无法安全取消')
      return
    }
    // 判存在再调用（旧主进程不提供 cancelRestore）；不假装成功。
    if (typeof api.cancelRestore !== 'function') {
      setCancelNotice('当前版本不支持中途取消')
      return
    }
    try {
      const outcome = await api.cancelRestore()
      if (outcome.ok) {
        setCancelNotice('已请求取消，将在安全点中止')
      } else if (outcome.code === 'NOT_SUPPORTED') {
        setCancelNotice('当前版本不支持中途取消')
      } else {
        setCancelNotice(`无法取消（${outcome.code ?? '未知原因'}）`)
      }
    } catch {
      setCancelNotice('取消请求未能送达主进程')
    }
  }

  async function submit() {
    if (!form || busy) return
    // 渲染层只做最轻的非空校验；真正的规范化与拒绝由主进程完成（§4.2 S7）。
    if (form.spaceName.trim() === '' || form.targetRoot.trim() === '') {
      setRestoreResult({ ok: false, code: 'INVALID_TARGET', detail: '请填写新空间名与目标目录绝对路径。', retryable: false })
      return
    }
    // 旧主进程可能不暴露 restore：判存在后再调用，避免直接抛错。
    if (typeof api.restore !== 'function') {
      setRestoreResult({ ok: false, code: 'LOCK_UNAVAILABLE', detail: '当前版本不支持恢复，请更新应用后重试。', retryable: false })
      return
    }
    setBusy(true)
    setRestoreResult(undefined)
    try {
      const outcome = await api.restore({
        archivePath: form.archive.path,
        targetRoot: form.targetRoot,
        spaceName: form.spaceName
      })
      setRestoreResult(outcome)
      if (outcome.ok) {
        // 成功后清空表单并刷新清单（新空间已登记，应出现在空间清单里）。
        setForm(undefined)
        await refresh()
      }
    } catch {
      setRestoreResult({ ok: false, code: 'INTERNAL', detail: '恢复请求未能送达主进程，请重试。', retryable: true })
    } finally {
      setBusy(false)
      setProgress(undefined)
    }
  }

  /** 运行只读自检（判存在再调 `api.doctor`，照 `api.restore` 的降级写法）。 */
  async function runDoctor() {
    if (doctorRunning) return
    if (typeof api.doctor !== 'function') {
      setDoctorResult({ ok: false, code: 'NOT_SUPPORTED', detail: '当前版本不支持自检，请更新应用后重试。' })
      return
    }
    setDoctorRunning(true)
    setDoctorResult(undefined)
    try {
      setDoctorResult(await api.doctor())
    } catch {
      setDoctorResult({ ok: false, code: 'INTERNAL', detail: '自检请求未能送达主进程，请重试。' })
    } finally {
      setDoctorRunning(false)
      setDoctorProgress(undefined)
    }
  }

  /** 读取最近维护审计（只读；判存在再调，旧主进程不提供时降级为 undefined）。 */
  async function loadAudit() {
    if (typeof api.auditRecent !== 'function') {
      setAudit({ entries: [], skipped: 0 })
      return
    }
    try {
      setAudit(await api.auditRecent(50))
    } catch {
      setAudit({ entries: [], skipped: 0 })
    }
  }
  useEffect(() => { void loadAudit() }, [api])

  return <main>
    <h1>备份与恢复维护窗口</h1>
    <p>选择一份备份归档，即可把它恢复成一个新的科研空间。恢复过程不会改动你现有的任何空间。</p>
    <section aria-label="科研空间清单" aria-busy={loading}>
      <h2>已登记的科研空间</h2>
      {loading && <p role="status">正在读取清单…</p>}
      {result?.ok && (result.spaces.length ? <ul>{result.spaces.map(space => <li key={space.id}>{space.name}</li>)}</ul> : <p>尚未登记科研空间。</p>)}
      {result && !result.ok && <p role="alert">空间登记文件无法读取。原文件已保留，请关闭窗口后检查文件或备份。</p>}
      {result?.ok && <>
        <h2>可恢复的备份归档</h2>
        {result.archives && result.archives.length
          ? <ul>{result.archives.map(archive => <li key={archive.path}>
              {archive.name}（{(archive.bytes / 1024 / 1024).toFixed(1)} MB，{new Date(archive.modifiedAt).toLocaleString()}）
              {!archive.remappable && <span role="note">（无法自动改写论文路径，恢复后需人工确认）</span>}
              <button type="button" disabled={busy} onClick={() => openForm(archive)}>恢复为新空间…</button>
            </li>)}</ul>
          : <p>未发现备份归档。</p>}
      </>}
      <button type="button" disabled={loading || busy} onClick={() => void refresh()}>重新读取</button>
    </section>

    {/* 自检面板（放在「归档候选」之下）：只读报告，只陈述技术事实，不做任何汇总结论。 */}
    <section aria-label="只读自检" aria-busy={doctorRunning}>
      <h2>只读自检</h2>
      <p>对注册表、归档、已发布空间一致性做一次只读检查。自检不会改动任何文件。</p>
      <button type="button" disabled={doctorRunning} onClick={() => void runDoctor()}>{doctorRunning ? '自检中…' : '运行自检'}</button>
      {doctorRunning && <p role="status">{doctorProgress ? `正在自检：${doctorProgress.detail}` : '正在自检…'}</p>}
      {doctorResult && !doctorResult.ok && <p role="alert">自检未能完成（{doctorResult.code}）{doctorResult.detail}</p>}
      {doctorResult?.ok && <>
        <table>
          <caption>自检结果（每行一项技术事实，按检查项排列）</caption>
          <thead><tr><th scope="col">检查项</th><th scope="col">结论</th><th scope="col">说明</th></tr></thead>
          <tbody>
            {doctorResult.checks.map((check: DoctorCheck) => <tr key={check.id}>
              <td>{check.title}</td>
              <td><span className={`severity severity-${check.severity}`}>{severityText(check.severity)}</span></td>
              <td>{check.detail}</td>
            </tr>)}
          </tbody>
        </table>
        <p role="status">共 {doctorResult.checks.length} 项：通过 {doctorResult.summary.ok}，可注意 {doctorResult.summary.notice}，偏离 {doctorResult.summary.warning}，阻塞 {doctorResult.summary.error}。</p>
      </>}
    </section>

    {form && <section aria-label="恢复为新空间" role="dialog" aria-modal="true">
      <h2>恢复「{form.archive.name}」为新空间</h2>
      <p><label>新空间名
        <input
          type="text"
          value={form.spaceName}
          disabled={busy}
          onChange={(event) => setForm({ ...form, spaceName: event.target.value })}
        />
      </label></p>
      <p><label>目标目录（绝对路径，且必须尚不存在）
        <input
          type="text"
          value={form.targetRoot}
          disabled={busy}
          placeholder="例如：D:\\Mimir\\我的新空间"
          onChange={(event) => setForm({ ...form, targetRoot: event.target.value })}
        />
      </label></p>
      {busy && <p role="status">{progress ? `阶段：${stageText(progress.stage)}；明细：${progress.detail}` : '正在恢复…'}</p>}
      {cancelNotice && <p role="status">{cancelNotice}</p>}
      <p>
        <button type="button" disabled={busy} onClick={() => void submit()}>{busy ? '恢复中…' : '开始恢复'}</button>
        <button type="button" disabled={busy && isRestoreUncancellable(progress?.stage)} onClick={() => void closeForm()}>取消</button>
      </p>
    </section>}

    {restoreResult && <p role={restoreResult.ok ? 'status' : 'alert'}>
      {restoreResult.ok
        ? `已恢复到 ${restoreResult.root}，共 ${restoreResult.entries} 条，改写 ${restoreResult.rewritten} 条。`
        : `${failureText(restoreResult.code)}（${restoreResult.code}）${restoreResult.detail}`}
    </p>}

    {/* 审计查看（页面底部）：只读列表，无删除按钮。 */}
    <section aria-label="最近维护审计">
      <h2>最近维护审计</h2>
      <p>这里只展示已脱敏的维护留痕（动作 / 结果 / 计数），不含本机路径与凭据。</p>
      {audit
        ? (audit.entries.length
            ? <ul>{audit.entries.map((entry, index) => <li key={`${entry.at}-${index}`}>
                {new Date(entry.at).toLocaleString()}　{auditActionText(entry.action)}　{auditOutcomeText(entry.outcome)}
                {entry.code ? `（${entry.code}）` : ''}
                {auditCountsText(entry.counts) ? `　${auditCountsText(entry.counts)}` : ''}
              </li>)}</ul>
            : <p>暂无维护审计记录。</p>)
        : <p role="status">正在读取审计…</p>}
      <button type="button" onClick={() => void loadAudit()}>刷新审计</button>
    </section>
  </main>
}
createRoot(document.getElementById('root')!).render(<MaintenanceApp />)
