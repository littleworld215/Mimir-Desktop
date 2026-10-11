import { useEffect, useState } from 'react'
import { createRoot } from 'react-dom/client'
import type { MaintenanceOverview, WorkspaceBackupMaintenanceApi } from '../../shared/workspaceBackupContracts'
import './maintenance.css'

declare global { interface Window { workspaceBackupMaintenance: WorkspaceBackupMaintenanceApi } }

function MaintenanceApp() {
  const [result, setResult] = useState<MaintenanceOverview>()
  const [loading, setLoading] = useState(false)
  async function refresh() {
    setLoading(true)
    try { setResult(await window.workspaceBackupMaintenance.overview()) }
    catch { setResult({ ok: false, code: 'REGISTRY_INVALID' }) }
    finally { setLoading(false) }
  }
  useEffect(() => { void refresh() }, [])
  return <main>
    <h1>备份与恢复维护窗口</h1>
    <p>当前提供科研空间与备份归档的只读清单。恢复功能尚未开放，关闭后可重新启动日常工作台。</p>
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
            </li>)}</ul>
          : <p>未发现备份归档。</p>}
      </>}
      <button type="button" disabled={loading} onClick={() => void refresh()}>重新读取</button>
    </section>
  </main>
}
createRoot(document.getElementById('root')!).render(<MaintenanceApp />)
