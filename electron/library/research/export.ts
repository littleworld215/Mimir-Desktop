import type { ResearchExportPreview, ResearchResolvedItem } from '../../../shared/libraryResearchContracts'
import type { ResearchContext } from './evidenceAccess'
import { packDetail } from './packService'
import { researchItemNeedsAttention } from './references'
import { ResearchError } from './validation'

const text = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/[\\`*_{}\[\]()#!|~]/g, '\\$&')
const sourceNames = { unchecked: '本轮尚未检查', available: '上次检查匹配', unbound: '未绑定PDF', missing: 'PDF缺失', changed: '来源版本变化', detached: '来源文献已移除', unauthorized: '来源未授权', unknown: '来源未能检查' }
const relationNames = { supports: '支持', opposes: '反对', mixed: '混合', unassessed: '未判断' }
const field = (label: string, value: string) => `**${label}**\n\n${text(value === '' ? '未填写' : value)}\n\n`
function itemMarkdown(item: ResearchResolvedItem): string {
  const v = item.evidence!, q = item.question!
  const alerts = [item.status.evidenceHasNewVersion ? '证据已有新版（仍引用原版本）' : '', item.status.questionHasNewVersion ? '问题组已有新版' : '', item.status.evidenceArchived ? '证据当前已归档' : '', item.status.questionArchived ? '问题当前已归档' : '', item.status.missingProject ? '项目已移除' : '', item.status.projectDetached ? '证据已移出项目' : '', item.status.removedFromQuestion ? '当前问题组已移除此卡' : ''].filter(Boolean).join('；')
  return field('问题', q.question) + field('引用标识', `${item.item.questionId} / 问题v${item.item.questionVersion} / ${item.item.cardId} / 证据v${item.item.evidenceVersion}`)
    + field('文献', `${v.paperSnapshot.title}\n${v.paperSnapshot.authors.join('、')}\n${v.paperId}\n${v.paperSnapshot.url}`)
    + field('原文摘录', v.quote) + field('待比较判断', v.claim) + field('方法', v.method) + field('数据或材料', v.datasetOrMaterial)
    + field('主要发现', v.finding) + field('局限', v.limitation) + field('证据个人评注', v.comment) + field('写作个人说明', item.item.note)
    + field('人工关系', relationNames[v.relation]) + field('核对状态', v.reviewState === 'checked' ? '用户已核对（不代表科研事实验证）' : '草稿')
    + field('PDF物理页码', `${v.locator.pageStart ?? '未填'}${v.locator.pageEnd ? `–${v.locator.pageEnd}` : ''}`)
    + field('印刷页标签 / 章节 / 图表', [v.locator.printedPageLabel, v.locator.section, v.locator.figureOrTable].filter(Boolean).join(' / '))
    + field('固定来源绑定', v.documentBinding ? `${v.documentBinding.sha256}\n${v.documentBinding.size}字节\n确认时间 ${v.documentBinding.checkedAt}` : '未绑定PDF')
    + field('来源状态', `${sourceNames[item.sourceStatus]}${item.checkedAt ? ` / 上次检查 ${item.checkedAt}` : ''}`) + field('更新与异常提示', alerts || '没有已知引用异常；来源检查仅代表检查时点')
}
export function serializeResearchPack(ctx: ResearchContext, request: { packId: string; packVersion: number }): { utf8: Buffer; preview: Omit<ResearchExportPreview, 'previewToken' | 'saved'> } {
  const detail = packDetail(ctx, { packId: request.packId, version: request.packVersion }), v = detail.pack.versions[detail.selectedVersion - 1]!
  const missing = detail.items.filter(i => !i.question || !i.evidence)
  if (missing.length) throw new ResearchError('REFERENCE_UNRESOLVED', `无法完整导出；以下条目引用缺失或不可读：${missing.map(i => i.item.id).join('、')}`)
  const sections = new Map<string, ResearchResolvedItem[]>()
  for (const item of detail.items) {
    const name = item.item.section.trim() || '未指定小节'
    const group = sections.get(name) ?? []; group.push(item); sections.set(name, group)
  }
  const entryCount = detail.items.length, uniqueCardCount = new Set(detail.items.map(i => i.item.cardId)).size, problemCount = detail.items.filter(researchItemNeedsAttention).length
  const markdown = `# ${text(v.title)}\n\n人工写作素材，不代表科研结论验证。相同小节按首次出现分组，组内保持原顺序；一卡多组会重复引用。\n\n`
    + field('素材包 / 修订 / 项目', `${detail.pack.id} / v${detail.selectedVersion} / ${v.projectId}`) + field('素材包说明', v.note)
    + field('范围', `${entryCount}条素材 / ${uniqueCardCount}张唯一证据卡 / ${problemCount}条需留意${v.archived ? ' / 包已归档' : ''}`)
    + [...sections].map(([name, items]) => `## ${text(name)}\n\n${items.map((item, i) => `### 材料 ${i + 1}\n\n${itemMarkdown(item)}`).join('')}`).join('\n')
  return { utf8: Buffer.from(markdown, 'utf8'), preview: { revision: detail.revision, evidenceRevision: detail.evidenceRevision, evidenceState: detail.evidenceState, packId: detail.pack.id, packVersion: detail.selectedVersion, markdown, entryCount, uniqueCardCount, problemCount } }
}
