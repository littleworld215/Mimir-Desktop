import { useState } from 'react'
import { Button } from '@/components/ui/button'
import type { EvidenceCard } from '../../../../../shared/libraryEvidenceContracts'
import { evidenceControl } from './EvidenceEditor'
export function EvidenceHistory({ card, onOpenSource }: { card: EvidenceCard; onOpenSource(version: number): void }) {
  const [selected, setSelected] = useState(card.currentVersion)
  const version = card.versions[selected - 1]!
  return <section className="space-y-3 p-3 border-t border-border" aria-label="证据修订历史">
    <label className="text-xs">查看证据版本<select aria-label="查看证据版本" className={evidenceControl} value={selected} onChange={e => setSelected(Number(e.target.value))}>{card.versions.map(v => <option key={v.version} value={v.version}>v{v.version} · {v.updatedAt} · {v.archived ? '已归档' : v.reviewState === 'checked' ? '用户已核对' : '草稿'}</option>)}</select></label>
    <p className="text-xs break-words">来源快照：{version.paperSnapshot.title} · {version.paperId}</p>
    <p className="text-xs break-words">{version.paperSnapshot.authors.join('、')} · {version.paperSnapshot.url}</p>
    <p className="text-xs break-words">用户判断：{{ supports: '支持', opposes: '反对', mixed: '混合', unassessed: '未判断' }[version.relation]} · 项目：{version.projectIds.join('、') || '无关联项目'}</p>
    <p className="text-xs text-muted-foreground">PDF物理页 {version.locator.pageStart ?? '未填写'}{version.locator.pageEnd ? `–${version.locator.pageEnd}` : ''} · 印刷页 {version.locator.printedPageLabel || '未填写'} · 请按页码定位</p>
    {([['研究问题', version.question], ['原文摘录', version.quote], ['待比较判断', version.claim], ['方法', version.method], ['数据或材料', version.datasetOrMaterial], ['主要发现', version.finding], ['局限', version.limitation], ['个人评注', version.comment]] as const).map(([label, value]) => <div key={label}><p className="text-xs font-medium">{label}</p><pre data-testid={label === '原文摘录' ? 'evidence-history-quote' : undefined} className="text-xs whitespace-pre-wrap break-words font-sans">{value || '未填写'}</pre></div>)}
    <p className="text-xs break-all text-muted-foreground">PDF摘要：{version.documentBinding?.sha256 ?? '未绑定'} · 字节数：{version.documentBinding?.size ?? '未知'} · 确认时间：{version.documentBinding?.checkedAt ?? '未确认'} · 章节：{version.locator.section || '未填写'} · 图表：{version.locator.figureOrTable || '未填写'}</p>
    <Button variant="outline" onClick={() => onOpenSource(selected)}>打开此版本来源</Button>
  </section>
}
