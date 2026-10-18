import { randomUUID } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'

export const questionVersion = () => ({ version: 1, projectId: 'project-1', title: '研究问题', question: '小样本是否稳定？', note: '', evidenceCardIds: [randomUUID()], archived: false, updatedAt: '2026-10-18T00:00:00.000Z' })
export const question = () => ({ id: randomUUID(), createdAt: '2026-10-18T00:00:00.000Z', currentVersion: 1, versions: [questionVersion()] })
export const item = () => ({ id: randomUUID(), questionId: randomUUID(), questionVersion: 1, cardId: randomUUID(), evidenceVersion: 1, section: '背景', note: '' })
export const packVersion = () => ({ version: 1, projectId: 'project-1', title: '写作材料', note: '', items: [item()], archived: false, updatedAt: '2026-10-18T00:00:00.000Z' })
export const pack = () => ({ id: randomUUID(), createdAt: '2026-10-18T00:00:00.000Z', currentVersion: 1, versions: [packVersion()] })
export function document() {
  const q = question(), p = pack()
  p.versions[0]!.items[0] = { ...p.versions[0]!.items[0]!, questionId: q.id, cardId: q.versions[0]!.evidenceCardIds[0]! }
  return { schemaVersion: 1 as const, revision: 1, questions: [q], packs: [p] }
}
export function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'mimir-research-'))
  return { root, clean: () => {
    if (dirname(resolve(root)) !== resolve(tmpdir()) || !basename(root).startsWith('mimir-research-')) throw Error('Unsafe research cleanup')
    rmSync(root, { recursive: true, force: true })
  } }
}
