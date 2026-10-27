import { createHash } from 'node:crypto'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { createEvidence, reviseEvidence } from '../../electron/library/evidence/service'
import { saveQuestion } from '../../electron/library/research/questionService'
import { savePack } from '../../electron/library/research/packService'
import type { ResearchContext } from '../../electron/library/research/evidenceAccess'
import type { EvidenceCard } from '../../shared/libraryEvidenceContracts'
import type { PaperRecord, ProjectRecord } from '../../electron/library/types'
import type { SeedData } from './seed'
import { evidencePdf } from './libraryEvidence'
import type { Page } from '@playwright/test'

export const researchQuote = `  完整合成摘录😀\n${'长正文保留空白与相反证据。'.repeat(160)}\n\n`
export function seedResearch(seed: SeedData) {
  const root = seed.workspaces[0]!.path
  mkdirSync(join(root, 'papers'), { recursive: true })
  const pdf = evidencePdf(), pdfPath = join(root, 'papers', encodeURIComponent('doi:10.9/research-0') + '.pdf'); writeFileSync(pdfPath, pdf)
  const projects: ProjectRecord[] = ['research-project', 'second-project', 'lost-project'].map((id, i) => ({ id, title: ['合成研究课题', '第二课题', '失联课题'][i]!, createdAt: '2026-10-18', updatedAt: '2026-10-18' }))
  const papers: PaperRecord[] = Array.from({ length: 10 }, (_, i) => ({ arxivId: `doi:10.9/research-${i}`, title: `研究文献${i}`, authors: ['合成作者'], summary: '离线合成资料', url: 'https://example.org/synthetic', notes: '旧阅读笔记', tags: [], projectIds: ['research-project', 'second-project'], addedAt: '2026-10-18', ...(i === 0 ? { pdfPath } : {}) }))
  const ctx: ResearchContext = { scope: { id: seed.workspaces[0]!.id, epoch: 'fixture', root }, signal: new AbortController().signal, assertCurrent() {}, catalog: { papers: () => papers, projects: () => projects }, sourceObservations: () => new Map() }
  const cards: EvidenceCard[] = []; let eRevision = 0
  for (let i = 0; i < 20; i++) {
    const reply = createEvidence(ctx, { paperId: papers[Math.floor(i / 2)]!.arxivId, projectIds: projects.map(p => p.id), question: `合成证据问题${i}`, claim: '人工判断，不能当作结论', quote: i === 0 ? researchQuote : `原始摘录${i}`, method: '合成方法', datasetOrMaterial: '合成材料', finding: '条件成立', limitation: '样本局限', comment: '', relation: (['supports', 'opposes', 'mixed', 'unassessed'] as const)[i % 4]!, locator: { pageStart: 1 } }, eRevision)
    eRevision = reply.document.revision; cards.push(reply.card)
  }
  // 可信夹具先固定v1，再产生核对版本，让恢复验证同时涵盖旧引用与PDF绑定。
  let rRevision = 0
  const questions = ['research-project', 'research-project', 'lost-project'].map((projectId, i) => {
    const reply = saveQuestion(ctx, { input: { projectId, title: `合成问题组${i}`, question: '相同问题下比较不同证据', note: '', evidenceCardIds: i === 0 ? cards.map(c => c.id) : [cards[0]!.id] }, expectedRevision: rRevision, expectedEvidenceRevision: eRevision })
    rRevision = reply.revision; return reply.question
  })
  const pack = savePack(ctx, { input: { projectId: 'research-project', title: '恢复基线素材', note: `自由文本路径 ${root} 不改写`, items: questions.slice(0, 2).map(q => ({ kind: 'new', questionId: q.id, cardId: cards[0]!.id, section: '讨论', note: '同卡多组保留' })) }, expectedRevision: rRevision, expectedEvidenceRevision: eRevision })
  const checked = reviseEvidence(ctx, cards[0]!.id, eRevision, previous => ({ ...previous, reviewState: 'checked', documentBinding: { sha256: createHash('sha256').update(pdf).digest('hex'), size: pdf.length, checkedAt: new Date().toISOString() } }))
  const firstQuestion = questions[0]!.versions[0]!
  saveQuestion(ctx, { questionId: questions[0]!.id, input: { projectId: firstQuestion.projectId, title: firstQuestion.title, question: firstQuestion.question, note: '问题的新组织版本，素材仍固定旧版本', evidenceCardIds: firstQuestion.evidenceCardIds }, expectedRevision: pack.revision, expectedEvidenceRevision: checked.document.revision })
  return { root, pdf, papers, projects: projects.slice(0, 2), cards, questions, pack: pack.pack, evidenceRevision: checked.document.revision, seed: { ...seed, spaceData: { ...seed.spaceData, 'library:papers': Object.fromEntries(papers.map(p => [p.arxivId, p])), 'library:projects': projects.slice(0, 2) } } }
}
export async function captureResearchViews(page: Page, stage: string) {
  const dir = join(process.cwd(), '../../.git/codex-integration/i9-execution/visual'); mkdirSync(dir, { recursive: true })
  for (const theme of ['light', 'dark', 'system-light', 'system-dark']) for (const width of [1280, 800]) {
    await page.emulateMedia({ colorScheme: theme.endsWith('dark') ? 'dark' : 'light' })
    await page.evaluate(dark => document.documentElement.classList.toggle('dark', dark), theme.endsWith('dark'))
    await page.setViewportSize({ width, height: 900 })
    await page.screenshot({ path: join(dir, `${process.env.MIMIR_E2E_PACKAGED ? 'package' : 'development'}-${stage}-${theme}-${width}.png`) })
  }
  await page.setViewportSize({ width: 1280, height: 900 })
}
