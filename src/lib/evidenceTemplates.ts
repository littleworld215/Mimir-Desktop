import type { EvidenceFields } from '../../shared/libraryEvidenceContracts'
export type EvidenceTemplateId = 'general' | 't2i-fairness'
const hints: Partial<Record<keyof EvidenceFields, string>> = {
  question: '公平性概念：\n适用条件：\n待核查命题：',
  claim: '说明待比较判断及其适用条件，不把框架当作论文结论。',
  method: '生成模型与版本：\n提示词条件：\n干预发生阶段：',
  datasetOrMaterial: '群体/交叉群体：\n属性定义：\n数据来源：\n样本与分组：',
  finding: '论文报告的指标与数值：\n对照条件：\n不确定性：\n未报告事项：',
  limitation: '指标适用范围：\n识别器依赖：\n文化/语言背景：\n未覆盖群体：',
  comment: '证据强弱：\n不可比因素：\n与本人问题的关系：'
}
export function evidenceTemplateHints(id: EvidenceTemplateId): Partial<Record<keyof EvidenceFields, string>> { return id === 't2i-fairness' ? { ...hints } : {} }
export function previewEvidenceTemplate(fields: EvidenceFields, id: EvidenceTemplateId): { next: EvidenceFields; changed: (keyof EvidenceFields)[] } {
  const next = { ...fields, projectIds: [...fields.projectIds], locator: { ...fields.locator } }, changed: (keyof EvidenceFields)[] = []
  const selected = evidenceTemplateHints(id)
  for (const key of ['question', 'method', 'datasetOrMaterial', 'finding', 'limitation', 'comment'] as const) {
    if (fields[key] === '' && selected[key]) { next[key] = selected[key]!; changed.push(key) }
  }
  return { next, changed }
}
