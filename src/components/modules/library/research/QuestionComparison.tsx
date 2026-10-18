import { useEffect, useRef, useState } from 'react'
import { Button } from '@/components/ui/button'
import { libraryResearchApi } from '@/lib/libraryResearchApi'
import type { ResearchQuestionDetail, ResearchScope } from '../../../../../shared/libraryResearchContracts'
import type { EvidenceRelation } from '../../../../../shared/libraryEvidenceContracts'
import { researchControl, researchMessage } from './useResearchForm'
import { researchSourceLabel } from './ResearchContent'
export function QuestionComparison({ scope, initial, onOpenCard }: { scope: ResearchScope; initial: ResearchQuestionDetail; onOpenCard(cardId: string): void }) {
  const [detail, setDetail] = useState(initial), [page, setPage] = useState(1), [keyword, setKeyword] = useState(''), [relation, setRelation] = useState(''), [loading, setLoading] = useState(false), [error, setError] = useState('')
  const first = useRef(true), generation = useRef(0)
  useEffect(() => {
    if (first.current) { first.current = false; return }
    const token = ++generation.current; setLoading(true); setError('')
    const timer = setTimeout(() => { void (async () => {
      try {
        const reply = await libraryResearchApi().questionDetail({ scope, questionId: initial.question.id, version: initial.selectedVersion, page, keyword, ...(relation ? { relation: relation as EvidenceRelation } : {}) })
        if (generation.current !== token) return
        if (!reply.ok) throw Error(reply.message)
        setDetail(reply)
      } catch (failure) { if (generation.current === token) setError(researchMessage(failure)) }
      finally { if (generation.current === token) setLoading(false) }
    })() }, 150)
    return () => { clearTimeout(timer); generation.current++ }
  }, [scope.workspaceId, scope.spaceEpoch, initial.question.id, initial.selectedVersion, page, keyword, relation])
  const names = { supports: '支持', opposes: '反对', mixed: '混合', unassessed: '未判断', unknown: '不可读' }
  return <section className="space-y-2" aria-label="研究问题证据比较"><h3 className="font-medium">当前证据比较</h3><p className="text-xs text-muted-foreground">问题组织v{initial.selectedVersion}；证据显示当前版本，缺失项保留。点击查看完整内容，人工关系不代表科学结论。</p><div className="flex flex-wrap gap-2">{Object.entries(names).map(([key, name]) => <span key={key} className="text-xs">{name} {detail.relationCounts[key as keyof typeof names]}</span>)}</div>
    <div className="flex gap-2"><input aria-label="比较关键词" placeholder="搜索完整证据正文" className={researchControl} value={keyword} onChange={e => { setPage(1); setKeyword(e.target.value) }} /><select aria-label="比较人工关系" className={researchControl} value={relation} onChange={e => { setPage(1); setRelation(e.target.value) }}><option value="">全部关系</option>{Object.entries(names).filter(([key]) => key !== 'unknown').map(([key, name]) => <option key={key} value={key}>{name}</option>)}</select></div>
    {loading && <p role="status">正在读取比较…</p>}{error && <p role="alert" className="text-destructive">{error}</p>}
    <div className="max-w-full overflow-x-auto"><table className="w-full text-left text-sm"><thead><tr>{['文献与出处', '摘录与判断', '方法与材料', '发现与局限', '人工关系与状态'].map(label => <th className="min-w-48 p-2" key={label}>{label}</th>)}</tr></thead><tbody>{detail.rows.map(row => <tr key={row.cardId} className="border-t border-border"><td className="p-2 align-top"><Button variant="link" disabled={loading || row.version === null} className="h-auto whitespace-normal text-left" onClick={() => onOpenCard(row.cardId)}>{row.paperTitle ?? row.cardId}</Button><p className="text-xs">v{row.version ?? '?'} · PDF物理页 {row.locator.pageStart ?? '未填'}</p></td><td className="p-2 align-top whitespace-pre-wrap break-words">{row.quote || row.claim || '未填写'}</td><td className="p-2 align-top whitespace-pre-wrap">{row.method || '未填方法'}<br />{row.datasetOrMaterial || '未填材料'}</td><td className="p-2 align-top whitespace-pre-wrap">{row.finding || '未填发现'}<br />{row.limitation || '未填局限'}</td><td className="p-2 align-top"><p>{names[row.relation]} · {row.reviewState === 'checked' ? '用户已核对' : row.reviewState === 'draft' ? '草稿' : '不可读'}</p><p>{researchSourceLabel(row.sourceStatus)}</p><p className="text-destructive">{row.problems.join('；')}</p></td></tr>)}</tbody></table></div>
    {!detail.rows.length && !loading && <p className="text-sm">暂无匹配证据。</p>}<div className="flex items-center gap-2"><Button variant="outline" disabled={loading || page <= 1} onClick={() => setPage(v => v - 1)}>上一页</Button><span className="text-xs">第{page}页 · {detail.total}张卡</span><Button variant="outline" disabled={loading || page * 50 >= detail.total} onClick={() => setPage(v => v + 1)}>下一页</Button></div>
  </section>
}
