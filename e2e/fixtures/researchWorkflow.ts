import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { SeedData } from './seed'
import { evidencePdf } from './libraryEvidence'

export function seedResearchWorkflow(seed: SeedData) {
  const root = seed.workspaces[0]!.path, expectedQuote = 'Synthetic fairness evidence'
  const paperIds = ['doi:10.30/workflow-first', 'doi:10.30/workflow-second']
  const project = { id: 'workflow-project', title: '合成科研闭环', createdAt: '2026-10-30', updatedAt: '2026-10-30' }
  mkdirSync(join(root, 'papers'), { recursive: true })
  const pdfPath = join(root, 'papers', encodeURIComponent(paperIds[0]!) + '.pdf')
  writeFileSync(pdfPath, evidencePdf(expectedQuote))
  const papers = Object.fromEntries(paperIds.map((id, index) => [id, {
    arxivId: id, title: `闭环文献${index + 1}`, authors: ['合成作者'], summary: '纯合成资料，不涉及真实实验',
    notes: '旧自由笔记保留', tags: [], projectIds: [project.id], addedAt: '2026-10-30', url: 'https://example.org/synthetic',
    ...(index === 0 ? { pdfPath } : {})
  }]))
  const secondRoot = join(root, '..', 'workflow-second-space')
  mkdirSync(join(secondRoot, '.mimir'), { recursive: true })
  writeFileSync(join(secondRoot, '.mimir/store.json'), JSON.stringify({ 'library:papers': { [paperIds[0]!]: { ...papers[paperIds[0]!]!, pdfPath: undefined, title: '第二空间同标识', notes: 'B空间原记录' } }, 'library:projects': [project] }))
  return { root, secondRoot, paperIds, expectedQuote, expectedPage: 1, seed: { ...seed,
    workspaces: [...seed.workspaces, { ...seed.workspaces[0]!, id: 'e2e-workflow-second', name: '闭环第二空间', path: secondRoot }],
    spaceData: { ...seed.spaceData, 'library:papers': papers, 'library:projects': [project] }
  } }
}
