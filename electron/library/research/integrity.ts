import { existsSync, lstatSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { evidencePath, readEvidence } from '../evidence/repository'
import { RestoreError } from '../../workspaceBackup/restoreContracts'
import { readResearch, researchPath } from './repository'
import { isPaperTrashed } from '../../../shared/libraryLifecycle'
import { assertPaperMetadata } from '../integrity'

export interface ResearchIntegrity {
  state: 'unused' | 'valid' | 'warning' | 'invalid' | 'unsupported'
  questionCount: number; packCount: number; unresolvedCount: number; code?: string
}
/** 只读、无运行时初始化；检查全部历史，不把摘要验包当作引用健康。 */
export function inspectResearchIntegrity(root: string): ResearchIntegrity {
  let questionCount = 0, packCount = 0
  try {
    if (!existsSync(researchPath(root))) return { state: 'unused', questionCount, packCount, unresolvedCount: 0 }
    const doc = readResearch(root)
    questionCount = doc.questions.length; packCount = doc.packs.length
    const evidence = readEvidence(root), cards = new Map(evidence.cards.map(c => [c.id, c])), questions = new Map(doc.questions.map(q => [q.id, q]))
    const storePath = join(root, '.mimir/store.json'), projectIds = new Set<string>(), paperIds = new Set<string>()
    if (existsSync(storePath)) {
      const entry = lstatSync(storePath)
      if (!entry.isFile() || entry.isSymbolicLink() || entry.size > 64 * 1024 * 1024) throw Error('CORRUPT_DATA')
      const store: unknown = JSON.parse(readFileSync(storePath, 'utf8'))
      if (!store || typeof store !== 'object' || Array.isArray(store)) throw Error('CORRUPT_DATA')
      const projects = (store as Record<string, unknown>)['library:projects'], papers = (store as Record<string, unknown>)['library:papers']
      if (projects !== undefined) {
        if (!Array.isArray(projects)) throw Error('CORRUPT_DATA')
        for (const p of projects) { if (!p || typeof p.id !== 'string') throw Error('CORRUPT_DATA'); projectIds.add(p.id) }
      }
      if (papers !== undefined) {
        if (!papers || typeof papers !== 'object' || Array.isArray(papers)) throw Error('CORRUPT_DATA')
        for (const [id, paper] of Object.entries(papers)) {
          if (!paper || typeof paper !== 'object' || Array.isArray(paper) || typeof paper.arxivId !== 'string' || paper.arxivId !== id) throw Error('CORRUPT_DATA')
          assertPaperMetadata(paper)
          if (!isPaperTrashed(paper)) paperIds.add(id)
        }
      }
    }
    const unresolved = new Set<string>()
    for (const q of doc.questions) for (const v of q.versions) {
      if (!projectIds.has(v.projectId)) unresolved.add(`q:${q.id}:${v.version}:project`)
      for (const id of v.evidenceCardIds) {
        const card = cards.get(id), current = card?.versions.at(-1)
        if (!current || !current.projectIds.includes(v.projectId) || !paperIds.has(current.paperId)) unresolved.add(`q:${q.id}:${v.version}:${id}`)
      }
    }
    for (const p of doc.packs) for (const v of p.versions) {
      if (!projectIds.has(v.projectId)) unresolved.add(`p:${p.id}:${v.version}:project`)
      for (const item of v.items) {
        const q = questions.get(item.questionId)?.versions[item.questionVersion - 1], card = cards.get(item.cardId)?.versions[item.evidenceVersion - 1]
        if (!q || !card || q.projectId !== v.projectId || !q.evidenceCardIds.includes(item.cardId) || !card.projectIds.includes(v.projectId) || !paperIds.has(card.paperId)) unresolved.add(`p:${p.id}:${v.version}:${item.id}`)
      }
    }
    const missingReferencedEvidence = !existsSync(evidencePath(root)) && (doc.questions.some(q => q.versions.some(v => v.evidenceCardIds.length)) || doc.packs.some(p => p.versions.some(v => v.items.length)))
    return { state: unresolved.size ? 'warning' : 'valid', questionCount, packCount, unresolvedCount: unresolved.size, ...(missingReferencedEvidence ? { code: 'EVIDENCE_MISSING' } : {}) }
  } catch (error) {
    const code = error && typeof error === 'object' && 'code' in error && error.code === 'FORMAT_UNSUPPORTED' ? 'FORMAT_UNSUPPORTED' : 'CORRUPT_DATA'
    return { state: code === 'FORMAT_UNSUPPORTED' ? 'unsupported' : 'invalid', questionCount, packCount, unresolvedCount: 0, code }
  }
}
export function assertRestoredResearchIntegrity(root: string): void {
  const result = inspectResearchIntegrity(root)
  if (result.state === 'invalid' || result.state === 'unsupported') throw new RestoreError('RECHECK_FAILED', `研究组织无法校验（${result.code}），原备份保留，请使用兼容版本检查`)
}
