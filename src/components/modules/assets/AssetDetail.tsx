import {lazy,Suspense,useState} from 'react'
import { Button } from '@/components/ui/button'
import type { AssetDetail as Detail } from '../../../../shared/assetsContracts'
const SafeMarkdown=lazy(()=>import('./SafeMarkdown').then(m=>({default:m.SafeMarkdown})))
export function AssetDetail({ asset, disabled, onEdit, onHistory, onArchive, onDelete, onImport, onDownload, onCopy, onFavorite, onFill, onAi, onDrafts, onAiTags, onOpenLink, onBack }: { asset: Detail; disabled: boolean; onEdit: () => void; onHistory: () => void; onArchive: () => void; onDelete: () => void; onImport: () => void; onDownload: () => void; onCopy: () => void; onFavorite: () => void; onFill?: () => void; onAi?: () => void; onDrafts?: () => void; onAiTags?: () => void; onOpenLink: () => void; onBack: () => void }) {
  const [reading, setReading] = useState(false)
  return <article aria-label="资产详情" className="min-w-0 space-y-4">
    <Button variant="outline" size="sm" className="lg:hidden" onClick={onBack} disabled={disabled}>返回列表</Button>
    <header className="space-y-1">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <h2 className="min-w-0 break-words text-lg font-medium">{asset.name}</h2>
        <Button variant="outline" size="sm" disabled={disabled || Boolean(asset.archivedAt)} onClick={onFavorite}>{asset.isFavorite ? '取消收藏' : '收藏资产'}</Button>
      </div>
      <p className="break-words text-xs text-muted-foreground">{asset.categoryPath.join(' / ')} · {asset.code} · {asset.currentVersion === null ? '无版本' : 'v' + asset.currentVersion} {asset.archivedAt ? '· 已归档' : ''}</p>
      <p className="break-words text-xs text-muted-foreground">更新时间：{asset.updatedAt}</p>
    </header>
    {asset.archivedAt && <p className="text-sm text-muted-foreground">已归档；恢复后可编辑或新增版本。</p>}
    {asset.description && <p className="whitespace-pre-wrap break-words text-sm">{asset.description}</p>}
    <section aria-label="阅读与取用" className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-2">
      <h3 className="text-xs font-medium text-muted-foreground">阅读与取用</h3>
      {asset.storageType === 'inline_text' && <>
        <div className="flex flex-wrap gap-2">
          <Button size="sm" disabled={disabled} onClick={onCopy}>复制正文</Button>
          {onFill && <Button size="sm" variant="outline" disabled={disabled} onClick={onFill}>填值复制</Button>}
          <Button size="sm" variant="outline" onClick={() => setReading(value => !value)}>{reading ? '原文' : '阅读预览'}</Button>
        </div>
      </>}
      {asset.storageType === 'external_link' && <>
        <p className="w-full break-words text-sm">{asset.externalUrl}</p>
        <div className="flex flex-wrap gap-2">
          <Button size="sm" disabled={disabled} onClick={onCopy}>复制外链</Button>
          <Button size="sm" variant="outline" disabled={disabled} onClick={onOpenLink}>打开外链</Button>
        </div>
      </>}
      {asset.storageType === 'file' && <>
        <p className="w-full break-words text-sm">{asset.currentFileName ?? '尚未导入文件'} · {asset.fileAvailable ? '文件可用' : '文件不可用'}</p>
        <Button size="sm" disabled={disabled || !asset.fileAvailable} onClick={onDownload}>下载当前文件</Button>
      </>}
    </section>
    <section aria-label="管理与历史" className="flex flex-wrap items-center gap-x-3 gap-y-2 border-t border-border pt-3">
      <h3 className="text-xs font-medium text-muted-foreground">管理与历史</h3>
      <div className="flex flex-wrap gap-2">
        <Button size="sm" variant="outline" disabled={disabled || Boolean(asset.archivedAt)} onClick={onEdit}>编辑资产</Button>
        <Button size="sm" variant="outline" disabled={disabled} onClick={onHistory}>历史版本</Button>
        <Button size="sm" variant="outline" disabled={disabled} onClick={onArchive}>{asset.archivedAt ? '恢复资产' : '归档资产'}</Button>
        {asset.storageType === 'file' && <Button size="sm" variant="outline" disabled={disabled || Boolean(asset.archivedAt)} onClick={onImport}>导入新文件版本</Button>}
      </div>
    </section>
    {asset.storageType === 'inline_text' && (onAi || onDrafts || onAiTags) && <section aria-label="辅助整理" className="flex flex-wrap items-center gap-x-3 gap-y-2">
      <h3 className="text-xs font-medium text-muted-foreground">辅助整理</h3>
      <div className="flex flex-wrap gap-2">
        {onAi && <Button size="sm" variant="outline" disabled={disabled || Boolean(asset.archivedAt) || !asset.currentContent.trim()} onClick={onAi}>AI 整理</Button>}
        {onDrafts && <Button size="sm" variant="outline" disabled={disabled} onClick={onDrafts}>待采纳草稿</Button>}
        {onAiTags && <Button size="sm" variant="outline" disabled={disabled || Boolean(asset.archivedAt) || !asset.currentContent.trim()} onClick={onAiTags}>AI 标签建议</Button>}
      </div>
    </section>}
    {asset.storageType === 'inline_text' && <section aria-label="资产正文" className="min-w-0">
      {reading ? <Suspense fallback={<p role="status">正在加载阅读预览…</p>}><SafeMarkdown content={asset.currentContent} /></Suspense> : <pre className="overflow-auto whitespace-pre-wrap break-words rounded border border-border bg-muted/30 p-4 font-mono text-sm">{asset.currentContent}</pre>}
    </section>}
    <p className="break-words text-sm">{asset.tags.map(tag => '#' + tag.name).join(' ') || '无标签'}</p>
    {asset.notes && <section><h3 className="text-sm font-medium">备注</h3><p className="whitespace-pre-wrap break-words text-sm">{asset.notes}</p></section>}
    <details>
      <summary className="cursor-pointer text-sm">来源与变量配置</summary>
      <p className="mt-2 text-sm">来源任务：{asset.sourceTask || '未填写'}</p>
      <pre className="mt-2 whitespace-pre-wrap break-words text-xs">{asset.sourceJson}</pre>
      <pre className="mt-2 whitespace-pre-wrap break-words text-xs">{JSON.stringify(asset.templateConfig, null, 2)}</pre>
    </details>
    <section aria-label="危险操作" className="space-y-2 rounded-md border border-destructive/40 p-3">
      <h3 className="text-sm font-medium text-destructive">危险操作</h3>
      <p className="text-xs text-muted-foreground">先查看删除预览，再在确认窗口中明确确认。</p>
      <Button variant="destructive" size="sm" disabled={disabled} onClick={onDelete}>永久删除</Button>
    </section>
  </article>
}
