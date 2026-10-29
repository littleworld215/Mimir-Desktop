import { useEffect, useRef, useState } from 'react'
import { Button } from '@/components/ui/button'
import type { WorkspaceRequest } from '../../../../shared/assetsContracts'
import { FILE_HEALTH_LABELS, type FileHealthItem, type FileHealthCursor } from '../../../../shared/assetsFileHealthContracts'
import { assetsApi } from './assetsApi'
import { AssetModal, AssetError, errorMessage } from './assetsUi'

type Phase = 'idle' | 'running' | 'completed' | 'cancelled' | 'failed'
const empty = () => ({ checked: 0, openable: 0, latest: [] as FileHealthItem[], issues: [] as FileHealthItem[], at: '' })
export function FileHealthReport({ scope, onClose }: { scope: WorkspaceRequest; onClose: () => void }) {
  const [phase, setPhase] = useState<Phase>('idle'), [result, setResult] = useState(empty), [error, setError] = useState('')
  const [view, setView] = useState<'latest' | 'issues'>('latest'), [page, setPage] = useState(1)
  const generation = useRef(0), scopeKey = scope.workspaceId + ':' + scope.spaceEpoch, currentKey = useRef(scopeKey)
  currentKey.current = scopeKey
  useEffect(() => {
    ++generation.current; setPhase('idle'); setResult(empty()); setError(''); setPage(1); setView('latest')
    return () => { ++generation.current }
  }, [scopeKey])
  function stop() { ++generation.current; setPhase('cancelled') }
  function close() { ++generation.current; onClose() }
  async function start() {
    const token = ++generation.current, key = scopeKey, captured = { ...scope }
    const active = () => token === generation.current && key === currentKey.current
    let cursor: FileHealthCursor | undefined
    setPhase('running'); setResult(empty()); setError(''); setPage(1); setView('latest')
    try {
      do {
        const response = await assetsApi.inspectFileHealth({ ...captured, ...(cursor ? { cursor } : {}) })
        if (!active()) return
        const { batch } = response
        setResult(old => ({ checked: old.checked + batch.items.length, openable: old.openable + batch.items.filter(item => item.status === 'openable').length,
          latest: batch.items, issues: [...old.issues, ...batch.items.filter(item => item.status !== 'openable')].slice(0, 500), at: batch.checkedAt }))
        setPage(1)
        if (batch.nextCursor && JSON.stringify(batch.nextCursor) === JSON.stringify(cursor)) throw Error('检查分页未前进，请重新检查。')
        cursor = batch.nextCursor ?? undefined
        // Yield between bounded batches so Cancel/close/navigation can stop further work.
        if (cursor) await new Promise(resolve => setTimeout(resolve, 0))
        if (!active()) return
      } while (cursor)
      setPhase('completed')
    } catch (error) { if (active()) { setError(errorMessage(error)); setPhase('failed') } }
  }
  const rows = view === 'latest' ? result.latest : result.issues, pages = Math.max(1, Math.ceil(rows.length / 50))
  const status = { idle: '尚未开始检查。', running: '正在检查…', completed: '检查完成', cancelled: '已取消（检查未完成）', failed: '检查中断，结果不完整' }[phase]
  return <AssetModal title="资产文件健康报告" onClose={close}>
    <p className="text-sm">手动检查当前空间的文件资产及历史版本，包含归档。仅检查版本记录引用的文件，不扫描额外目录或联网检查外链。</p>
    <p className="text-sm text-muted-foreground">在线检查时点结果，期间编辑、导入或删除可能影响覆盖范围，请按需重检。可打开不等于内容完整；摘要基准：未建立。数据库结构、外键及全文读取检查请使用“备份与恢复”的维护自检。</p>
    <div className="flex flex-wrap gap-2">
      <Button size="sm" disabled={phase === 'running'} onClick={() => void start()}>{phase === 'idle' ? '开始检查' : '重新检查'}</Button>
      {phase === 'running' && <Button size="sm" variant="outline" onClick={stop}>取消检查</Button>}
      <Button size="sm" variant="outline" onClick={close}>关闭报告</Button>
    </div>
    <p role="status" className="text-sm">{status}</p>
    <p className="text-sm">已检查 {result.checked} 条版本记录（无版本的文件资产计1条）；可打开 {result.openable}，需关注 {result.checked - result.openable}。</p>
    {phase === 'cancelled' && <p className="text-xs text-muted-foreground">后续批次已停止；当前批次可能继续完成，其迟到结果不会加入报告。</p>}
    <AssetError message={error} />
    {result.at && <p className="break-words text-xs text-muted-foreground">最近一批检查时间：{result.at}。报告仅存本窗口，关闭后清空。</p>}
    <div className="flex flex-wrap items-center gap-2">
      <Button size="sm" variant="outline" aria-pressed={view === 'latest'} onClick={() => { setView('latest'); setPage(1) }}>最近一批</Button>
      <Button size="sm" variant="outline" aria-pressed={view === 'issues'} onClick={() => { setView('issues'); setPage(1) }}>问题列表</Button>
      <span className="text-xs text-muted-foreground">每批最多50条；问题明细最多保留前500条，汇总继续计数。</span>
    </div>
    <div className="max-h-80 overflow-auto rounded border border-border">
      <table className="w-full text-left text-sm"><thead><tr className="border-b border-border"><th className="p-2">资产</th><th className="p-2">版本</th><th className="p-2">检查结果</th></tr></thead><tbody>
        {rows.slice((page - 1) * 50, page * 50).map(item => <tr key={`${item.assetId}:${item.versionId ?? 0}`} className="border-b border-border align-top">
          <td className="max-w-56 break-words p-2">{item.assetName}<span className="block break-all text-xs text-muted-foreground">{item.assetCode}{item.archived ? ' · 已归档' : ''}</span></td>
          <td className="p-2">{item.version === null ? '无版本' : 'v' + item.version}</td>
          <td className="max-w-48 break-words p-2">{FILE_HEALTH_LABELS[item.status]}</td>
        </tr>)}
      </tbody></table>
      {!rows.length && <p className="p-3 text-sm text-muted-foreground">暂无明细。</p>}
    </div>
    <div className="flex items-center gap-2 text-sm"><Button size="sm" variant="outline" disabled={page <= 1} onClick={() => setPage(p => p - 1)}>上一页</Button><span>{page} / {pages}</span><Button size="sm" variant="outline" disabled={page >= pages} onClick={() => setPage(p => p + 1)}>下一页</Button></div>
  </AssetModal>
}
