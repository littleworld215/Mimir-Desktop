import { useRef, useState } from 'react'
import { Button } from '@/components/ui/button'
import type { AssetDetail, WorkspaceRequest } from '../../../../shared/assetsContracts'
import type { AiTagsResult } from '../../../../shared/assetsAiContracts'
import { assetsApi } from './assetsApi'
import { AssetError, AssetModal, useAssetsEditorGuard } from './assetsUi'
import { useAiOperation, type AiWrite } from './useAiOperation'

export function AiTags({ asset, scope, write, onChanged, onClose, returnFocus }: {
  asset: AssetDetail; scope: WorkspaceRequest; write: AiWrite; onChanged: (asset?: AssetDetail) => void; onClose: () => void; returnFocus?: Element | null
}) {
  const op = useAiOperation(scope, write), composing = useRef(false)
  const [send, setSend] = useState(false), [confirmed, setConfirmed] = useState(false)
  const [result, setResult] = useState<AiTagsResult | null>(null), [selected, setSelected] = useState<string[]>([])
  useAssetsEditorGuard({ isDirty: () => false, isBusy: () => op.working.current, save: async () => false, discard: onClose })
  async function generate() {
    if (!send || composing.current) return
    const r = await op.run((s, requestId) => assetsApi.suggestAiTags({ ...s, requestId, confirmSend: true, input: { assetId: asset.id, sourceVersionId: asset.currentVersionId!, max: 8 } }), true)
    if (r) { setResult(r); setSelected([]); setConfirmed(false) }
  }
  async function adopt() {
    if (!result || !confirmed || !selected.length || composing.current) return
    const r = await op.run(s => assetsApi.adoptSuggestedTags({ ...s, confirm: true, input: { assetId: asset.id, expectedRevision: result.sourceRevision, names: selected } }))
    if (r) { onChanged(r.asset); onClose() }
  }
  return <AssetModal returnFocus={returnFocus} title={`${asset.name} · AI 标签建议`} onClose={() => { if (!op.working.current && !composing.current) onClose() }} onEscape={() => op.working.current || composing.current}>
    <div className="space-y-4" onCompositionStart={() => { composing.current = true }} onCompositionEnd={() => { composing.current = false }}>
      <p className="text-sm">建议只读，不修改原文或已有标签。模型最多读取正文前 4000 字符、40 个常用标签名；结果最多 8 项。使用“设置”中选择的模型。</p>
      <label className="flex items-start gap-2 text-sm"><input type="checkbox" checked={send} disabled={op.busy} onChange={e => setSend(e.target.checked)} />同意发送正文摘要与常用标签名给当前配置的模型</label>
      <Button disabled={op.busy || !send} onClick={() => void generate()}>生成标签建议</Button>
      {result && <fieldset disabled={op.busy} className="space-y-3"><legend className="text-sm">候选标签 · {result.model}</legend>
        {result.contentTruncated && <p className="text-xs text-muted-foreground">正文已截取前 4000 字符用于建议。</p>}{result.truncated && <p className="text-xs">候选超过数量上限，已保留前 8 项。</p>}
        {!result.suggestions.length && <p className="text-sm">模型没有返回有效候选，可重新生成。</p>}
        {result.suggestions.map(t => <label key={t.name} className="flex items-center gap-2 text-sm"><input aria-label={`选择标签 ${t.name}`} type="checkbox" checked={selected.includes(t.name)} onChange={e => { setSelected(old => e.target.checked ? [...old, t.name] : old.filter(n => n !== t.name)); setConfirmed(false) }} />{t.name} {t.existingTagId === null ? '（新标签）' : '（复用已有标签）'}</label>)}
        <label className="flex items-start gap-2 text-sm"><input type="checkbox" checked={confirmed} onChange={e => setConfirmed(e.target.checked)} />确认添加所选标签，保留已有标签</label>
        <Button disabled={op.busy || !confirmed || !selected.length} onClick={() => void adopt()}>采纳所选标签</Button>
      </fieldset>}
      <AssetError message={op.error} />{op.notice && <p role="status">{op.notice}</p>}
      {op.busy && <p role="status">已用 {op.elapsed} 秒 · 正在处理…</p>}
      <div className="flex flex-wrap gap-2">{op.busy && <Button variant="outline" onClick={() => void op.cancel()}>取消模型请求</Button>}<Button variant="outline" disabled={op.busy} onClick={onClose}>关闭</Button></div>
    </div>
  </AssetModal>
}
