import { useEffect, useRef, useState } from 'react'
import { Button } from '@/components/ui/button'
import { requestAssetsLeave } from '@/lib/assetsEditGuard'
import type { AssetCategory, AssetDetail, AssetVersion, WorkspaceRequest } from '../../../../shared/assetsContracts'
import type { AiDraft, AiDraftSummary } from '../../../../shared/assetsAiContracts'
import { assetsApi } from './assetsApi'
import { AssetError, AssetField, AssetModal, controlClass, errorMessage, useAssetsEditorGuard } from './assetsUi'
import { useAiOperation, type AiWrite } from './useAiOperation'

export function AiDrafts({ asset, scope, categories, write, initialDraft, onChanged, onClose, returnFocus }: {
  asset: AssetDetail; scope: WorkspaceRequest; categories: AssetCategory[]; write: AiWrite
  initialDraft?: AiDraft; onChanged: (asset?: AssetDetail) => void; onClose: () => void; returnFocus?: Element | null
}) {
  const op = useAiOperation(scope, write)
  const [page, setPage] = useState(1), [list, setList] = useState<{ items: AiDraftSummary[]; total: number } | null>(null)
  const [loading, setLoading] = useState(true), [readError, setReadError] = useState(''), [reload, setReload] = useState(0)
  const [draft, setDraft] = useState<AiDraft | null>(null), [source, setSource] = useState<AssetVersion | null>(null)
  const [current, setCurrent] = useState(asset), [content, setContent] = useState('')
  const [carry, setCarry] = useState<'version' | 'derived'>('version'), [name, setName] = useState(''), [category, setCategory] = useState(asset.category)
  const [confirmed, setConfirmed] = useState(false), [discardConfirm, setDiscardConfirm] = useState(false)
  const composing = useRef(false)
  const dirty = Boolean(draft && (content !== draft.content || name !== '' || category !== asset.category))
  useEffect(() => {
    let active = true; setLoading(true); setReadError('')
    void assetsApi.listAiDrafts({ ...scope, query: { assetId: asset.id, page, pageSize: 10 } }).then(r => { if (active) setList(r.page) })
      .catch(e => { if (active) setReadError(errorMessage(e)) }).finally(() => { if (active) setLoading(false) })
    return () => { active = false }
  }, [scope.workspaceId, scope.spaceEpoch, asset.id, page, reload])
  async function choose(id: number, ready?: AiDraft) {
    if (dirty || op.working.current) return
    const result = await op.run(async s => {
      const selected = ready ?? (await assetsApi.getAiDraft({ ...s, draftId: id })).draft
      const [original, latest] = await Promise.all([assetsApi.getVersion({ ...s, assetId: asset.id, versionId: selected.sourceVersionId }), assetsApi.get({ ...s, assetId: asset.id })])
      return { selected, original: original.version, latest: latest.asset }
    })
    if (result) {
      setDraft(result.selected); setSource(result.original); setCurrent(result.latest); setContent(result.selected.content)
      setCarry(result.selected.mode === 'polish' ? 'version' : 'derived'); setName(''); setCategory(result.latest.category)
      setConfirmed(false); setDiscardConfirm(false)
    }
  }
  useEffect(() => { if (initialDraft) void choose(initialDraft.id, initialDraft) }, [initialDraft?.id])
  async function adopt(): Promise<boolean> {
    if (!draft || !source || !confirmed || composing.current || current.archivedAt) return false
    // 离开守卫会直接调用本函数，不能只依赖采纳按钮的disabled。
    if (!content.trim()) { op.setError('采纳正文不能为空；输入与草稿已保留。'); return false }
    const result = await op.run(s => assetsApi.adoptAiDraft({ ...s, draftId: draft.id, confirm: true, input: {
      expectedRevision: current.revision, carry, content,
      ...(carry === 'derived' ? { ...(name ? { name } : {}), category } : {})
    } }))
    if (!result) return false
    onChanged(result.asset); onClose(); return true
  }
  useAssetsEditorGuard({ isDirty: () => dirty, isBusy: () => op.working.current, save: adopt, discard: onClose })
  async function close() { if (!op.working.current && !composing.current && await requestAssetsLeave()) onClose() }
  async function discard() {
    if (!draft || !discardConfirm) return
    const result = await op.run(s => assetsApi.discardAiDraft({ ...s, draftId: draft.id, confirm: true }))
    if (result) { setDraft(null); setContent(''); setName(''); setDiscardConfirm(false); setReload(n => n + 1); onChanged(); op.setNotice('草稿已丢弃，原文与历史保留。') }
  }
  return <AssetModal returnFocus={returnFocus} title={`${asset.name} · 待采纳草稿`} onClose={() => void close()} onEscape={() => op.working.current || composing.current}>
    <div className="space-y-4" onCompositionStart={() => { composing.current = true }} onCompositionEnd={() => { composing.current = false }}>
      <p className="text-sm">草稿尚未进入版本历史。采纳会新增版本或派生资产，原文始终保留。</p>
      <AssetError message={op.error || readError} />{op.notice && <p role="status">{op.notice}</p>}
      {loading && <p role="status">正在读取草稿列表…</p>}
      {!loading && list?.total === 0 && <p className="text-sm">暂无待采纳草稿。可从“AI 整理”生成。</p>}
      <div className="space-y-2">{list?.items.map(d => <div key={d.id} className="flex flex-wrap items-center justify-between gap-2 rounded border p-2"><span className="text-sm">草稿 #{d.id} · {d.mode === 'polish' ? '润色' : '重构'} · {d.model} · {d.createdAt}</span><Button size="sm" variant="outline" disabled={op.busy || dirty} onClick={() => void choose(d.id)}>查看草稿 {d.id}</Button></div>)}</div>
      <div className="flex flex-wrap items-center gap-2"><Button size="sm" variant="outline" disabled={loading || op.busy || page <= 1} onClick={() => setPage(p => p - 1)}>草稿上一页</Button><span className="text-xs">第 {page} 页，共 {list?.total ?? 0} 项</span><Button size="sm" variant="outline" disabled={loading || op.busy || page * 10 >= (list?.total ?? 0)} onClick={() => setPage(p => p + 1)}>草稿下一页</Button><Button size="sm" variant="outline" disabled={op.busy} onClick={() => setReload(n => n + 1)}>刷新草稿列表</Button></div>
      {draft && source && <section className="space-y-3 rounded border p-3">
        <p className="text-xs text-muted-foreground">AI 生成 · {draft.model} · {draft.createdAt} · 来源 v{source.version}（#{draft.sourceVersionId}）· 用量 {draft.usage.totalTokens ?? 0} tokens</p>
        <div className="grid gap-3 md:grid-cols-2"><section><h3 className="text-sm font-medium">生成时原文</h3><pre aria-label="草稿来源原文" className="max-h-64 overflow-auto whitespace-pre-wrap break-words rounded border bg-muted/30 p-3 text-sm">{source.content}</pre></section><section><h3 className="text-sm font-medium">模型原始结果</h3><pre className="max-h-64 overflow-auto whitespace-pre-wrap break-words rounded border bg-muted/30 p-3 text-sm">{draft.content}</pre></section></div>
        <details><summary className="cursor-pointer text-sm">实际 Prompt 与来源快照</summary><pre className="max-h-48 overflow-auto whitespace-pre-wrap break-words text-xs">{draft.promptSnapshot}</pre><p className="text-xs">来源资产 #{draft.assetId}，生成时 revision {draft.sourceRevision}；Prompt资产 {draft.promptAssetId ?? '内置默认'}。</p></details>
        <fieldset disabled={op.busy} className="space-y-3">
          <AssetField label="编辑后采纳正文"><textarea className={`${controlClass} min-h-48 font-mono`} value={content} onChange={e => { setContent(e.target.value); setConfirmed(false) }} /></AssetField>
          <AssetField label="承载方式"><select className={controlClass} value={carry} onChange={e => { setCarry(e.target.value as 'version' | 'derived'); setConfirmed(false) }}><option value="version">同资产新增版本（保留历史）</option><option value="derived">派生新资产（保留参见）</option></select></AssetField>
          {carry === 'derived' && <div className="grid gap-3 sm:grid-cols-2"><AssetField label="派生名称"><input className={controlClass} value={name} placeholder="留空自动命名" maxLength={200} onChange={e => { setName(e.target.value); setConfirmed(false) }} /></AssetField><AssetField label="派生分类"><select className={controlClass} value={category} onChange={e => { setCategory(e.target.value); setConfirmed(false) }}>{categories.map(c => <option key={c.code} value={c.code}>{c.name}</option>)}</select></AssetField></div>}
          <label className="flex items-start gap-2 text-sm"><input type="checkbox" checked={confirmed} onChange={e => setConfirmed(e.target.checked)} />确认采纳此草稿，按当前承载方式保存</label>
        </fieldset>
        {dirty && <p role="status" className="text-sm">有未采纳的编辑；关闭前可留在这里或放弃本次编辑，数据库草稿仍保留。</p>}
        {(current.currentVersionId !== draft.sourceVersionId || current.revision !== draft.sourceRevision) && <p className="text-sm">当前来源已变化；同资产采纳可能冲突，可明确选择派生。不会覆盖草稿输入。</p>}
        <div className="flex flex-wrap gap-2"><Button disabled={op.busy || !confirmed || !content.trim() || Boolean(current.archivedAt)} onClick={() => void adopt()}>采纳草稿</Button><Button variant="outline" disabled={op.busy} onClick={() => void op.run(s => assetsApi.get({ ...s, assetId: asset.id })).then(r => { if (r) { setCurrent(r.asset); setConfirmed(false); op.setNotice('来源资产已重新读取，编辑内容保留；请再次确认承载方式。') } })}>重新读取来源资产</Button>{dirty && <Button variant="outline" disabled={op.busy} onClick={() => { setContent(draft.content); setName(''); setCategory(asset.category); setConfirmed(false) }}>放弃本次编辑</Button>}<Button variant="destructive" disabled={op.busy} onClick={() => setDiscardConfirm(true)}>丢弃草稿</Button></div>
        {discardConfirm && <div role="alert" className="space-y-2 rounded border border-destructive p-3"><p className="text-sm">确认永久丢弃草稿 #{draft.id} 及本次编辑？原文和历史不受影响。</p><Button variant="destructive" disabled={op.busy} onClick={() => void discard()}>确认丢弃</Button><Button variant="outline" disabled={op.busy} onClick={() => setDiscardConfirm(false)}>保留草稿</Button></div>}
      </section>}
      {op.busy && <p role="status">正在处理草稿…</p>}
      <Button variant="outline" disabled={op.busy} onClick={() => void close()}>关闭</Button>
    </div>
  </AssetModal>
}
