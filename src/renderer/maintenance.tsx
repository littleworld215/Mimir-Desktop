import { useEffect, useState } from 'react'
import { createRoot } from 'react-dom/client'
import type {
  MaintenanceArchiveCandidate,
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

/** 单个归档候选的恢复表单状态。 */
interface RestoreForm { archive: MaintenanceArchiveCandidate; spaceName: string; targetRoot: string }

function MaintenanceApp() {
  const [result, setResult] = useState<MaintenanceOverview>()
  const [loading, setLoading] = useState(false)
  const [form, setForm] = useState<RestoreForm>()
  const [busy, setBusy] = useState(false)
  const [restoreResult, setRestoreResult] = useState<MaintenanceRestoreResult>()
  const [progress, setProgress] = useState<MaintenanceRestoreProgress>()

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

  function openForm(archive: MaintenanceArchiveCandidate) {
    setRestoreResult(undefined)
    setProgress(undefined)
    setForm({ archive, spaceName: '', targetRoot: '' })
  }

  function closeForm() {
    if (busy) return
    setForm(undefined)
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
      {busy && <p role="status">{progress ? `正在恢复：${progress.detail}` : '正在恢复…'}</p>}
      <p>
        <button type="button" disabled={busy} onClick={() => void submit()}>{busy ? '恢复中…' : '开始恢复'}</button>
        <button type="button" disabled={busy} onClick={closeForm}>取消</button>
      </p>
    </section>}

    {restoreResult && <p role={restoreResult.ok ? 'status' : 'alert'}>
      {restoreResult.ok
        ? `已恢复到 ${restoreResult.root}，共 ${restoreResult.entries} 条，改写 ${restoreResult.rewritten} 条。`
        : `${failureText(restoreResult.code)}（${restoreResult.code}）${restoreResult.detail}`}
    </p>}
  </main>
}
createRoot(document.getElementById('root')!).render(<MaintenanceApp />)
