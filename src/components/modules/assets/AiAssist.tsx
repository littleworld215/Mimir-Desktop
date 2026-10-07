import { useEffect, useRef, useState } from 'react'
import { Button } from '@/components/ui/button'
import type { AssetDetail, AssetPage, TemplateValues, WorkspaceRequest } from '../../../../shared/assetsContracts'
import type { AiAssistMode, AiDraft } from '../../../../shared/assetsAiContracts'
import { POLISH_PROMPT, RESTRUCTURE_PROMPT } from '../../../../shared/assetsAiPrompts'
import { buildConfiguredFinalPrompt, initialTemplateValues } from '../../../../shared/assetsTemplate'
import { assetsApi } from './assetsApi'
import { AssetError, AssetField, AssetModal, controlClass, errorMessage, useAssetsEditorGuard } from './assetsUi'
import { TemplateFields } from './TemplateFields'
import { useAiOperation, type AiWrite } from './useAiOperation'

export function AiAssist({ asset, scope, write, onGenerated, onClose, returnFocus }: {
  asset: AssetDetail; scope: WorkspaceRequest; write: AiWrite; onGenerated: (draft: AiDraft) => void; onClose: () => void; returnFocus?: Element | null
}) {
  const op = useAiOperation(scope, write)
  const [mode, setMode] = useState<AiAssistMode>('polish'), [confirmed, setConfirmed] = useState(false)
  const [promptId, setPromptId] = useState(''), [prompt, setPrompt] = useState<AssetDetail | null>(null)
  const [values, setValues] = useState<TemplateValues>({}), [page, setPage] = useState(1)
  const [prompts, setPrompts] = useState<AssetPage | null>(null), [listLoading, setListLoading] = useState(false)
  const [promptLoading, setPromptLoading] = useState(false), [readError, setReadError] = useState(''), [retry, setRetry] = useState(0)
  const composing = useRef(false)
  useEffect(() => {
    let active = true; setListLoading(true); setReadError('')
    void assetsApi.list({ ...scope, kind: 'prompt', storageType: 'inline_text', page, pageSize: 20 }).then(r => { if (active) setPrompts(r.page) })
      .catch(e => { if (active) setReadError(errorMessage(e)) }).finally(() => { if (active) setListLoading(false) })
    return () => { active = false }
  }, [scope.workspaceId, scope.spaceEpoch, page, retry])
  useEffect(() => {
    let active = true; setPrompt(null); setValues({}); setConfirmed(false)
    if (!promptId) { setPromptLoading(false); return }
    setPromptLoading(true); setReadError('')
    void assetsApi.get({ ...scope, assetId: Number(promptId) }).then(r => {
      if (active) { setPrompt(r.asset); const initial = initialTemplateValues(r.asset.currentContent, r.asset.templateConfig); delete initial['原文']; setValues(initial) }
    }).catch(e => { if (active) setReadError(errorMessage(e)) }).finally(() => { if (active) setPromptLoading(false) })
    return () => { active = false }
  }, [promptId, scope.workspaceId, scope.spaceEpoch, retry])
  const template = promptId ? prompt?.currentContent ?? '' : mode === 'polish' ? POLISH_PROMPT : RESTRUCTURE_PROMPT
  const supplied = { ...values }
  delete supplied['原文']
  let preview = '', previewError = ''
  try { preview = buildConfiguredFinalPrompt(template, supplied, asset.currentContent, prompt?.templateConfig) } catch (e) { previewError = errorMessage(e) }
  const unavailable = !confirmed || promptLoading || Boolean(promptId && !prompt) || Boolean(previewError) || !asset.currentContent.trim() || Boolean(asset.archivedAt)
  useAssetsEditorGuard({ isDirty: () => false, isBusy: () => op.working.current, save: async () => false, discard: onClose })
  async function generate() {
    if (unavailable || composing.current) return
    const result = await op.run((s, requestId) => assetsApi.generateAiDraft({ ...s, requestId, confirmSend: true,
      input: { assetId: asset.id, sourceVersionId: asset.currentVersionId!, mode, ...(promptId ? { promptAssetId: Number(promptId) } : {}), values: supplied } }), true)
    if (result) onGenerated(result.draft)
  }
  return <AssetModal returnFocus={returnFocus} title={`${asset.name} · AI 整理`} onClose={() => { if (!op.working.current && !composing.current) onClose() }} onEscape={() => op.working.current || composing.current}>
    <div className="space-y-4" onCompositionStart={() => { composing.current = true }} onCompositionEnd={() => { composing.current = false }} onKeyDown={e => {
      if ((e.ctrlKey || e.metaKey) && e.key === 'Enter' && !e.nativeEvent.isComposing && e.keyCode !== 229 && !composing.current) { e.preventDefault(); void generate() }
    }}>
      <p className="text-sm">仅生成待采纳草稿，原文和历史保留。模型使用“设置”中选择的配置；打开此窗口不会调用模型。</p>
      <fieldset disabled={op.busy} className="space-y-3">
        <AssetField label="整理模式"><select className={controlClass} value={mode} onChange={e => { setMode(e.target.value as AiAssistMode); setConfirmed(false) }}><option value="polish">润色（保持语义）</option><option value="restructure">重构整理（默认派生）</option></select></AssetField>
        <AssetField label="Prompt 模板"><select className={controlClass} value={promptId} onChange={e => setPromptId(e.target.value)}><option value="">内置默认模板</option>{prompt && !prompts?.items.some(p => p.id === prompt.id) && <option value={prompt.id}>{prompt.name}</option>}{prompts?.items.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}</select></AssetField>
        <div className="flex flex-wrap items-center gap-2"><Button size="sm" variant="outline" disabled={listLoading || page <= 1} onClick={() => setPage(p => p - 1)}>模板上一页</Button><span className="text-xs">模板第 {page} 页，共 {prompts?.total ?? 0} 项</span><Button size="sm" variant="outline" disabled={listLoading || page * 20 >= (prompts?.total ?? 0)} onClick={() => setPage(p => p + 1)}>模板下一页</Button></div>
        {promptLoading && <p role="status">正在读取模板…</p>}
        <TemplateFields template={template} excludeNames={['原文']} config={prompt?.templateConfig} values={supplied} onChange={v => { delete v['原文']; setValues(v); setConfirmed(false) }} />
        <details><summary className="cursor-pointer text-sm">发送内容预览（原文自动注入）</summary><pre aria-label="发送内容预览" className="max-h-64 overflow-auto whitespace-pre-wrap break-words rounded border p-3 text-xs">{preview}</pre><p className="text-xs text-muted-foreground">实际发送的 Prompt 快照会保存在草稿中；模板如被其他操作修改，以该快照为准。</p></details>
        <details open><summary className="text-sm">原文 · 当前版本</summary><pre className="max-h-48 overflow-auto whitespace-pre-wrap break-words text-sm">{asset.currentContent}</pre></details>
        <label className="flex items-start gap-2 text-sm"><input type="checkbox" checked={confirmed} onChange={e => setConfirmed(e.target.checked)} />同意将原文与所选 Prompt 发送给当前配置的模型</label>
      </fieldset>
      <AssetError message={op.error || readError || previewError} />{op.notice && <p role="status">{op.notice}</p>}
      {readError && <Button size="sm" variant="outline" disabled={op.busy} onClick={() => setRetry(n => n + 1)}>重试读取模板</Button>}
      {op.busy && <p role="status">已用 {op.elapsed} 秒 · 正在等待模型返回…</p>}
      <div className="flex flex-wrap gap-2"><Button disabled={op.busy || unavailable} onClick={() => void generate()}>生成待采纳草稿</Button>{op.busy && <Button variant="outline" onClick={() => void op.cancel()}>取消模型请求</Button>}<Button variant="outline" disabled={op.busy} onClick={onClose}>关闭</Button></div>
    </div>
  </AssetModal>
}
