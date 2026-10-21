import { closeSync, fstatSync, lstatSync, openSync, readSync, realpathSync } from 'node:fs'
import { isUtf8 } from 'node:buffer'
import { isAbsolute, join, relative, sep } from 'node:path'
import { RestoreError } from '../workspaceBackup/restoreContracts'
import { createPlanningDeliveryRepository, createPlanningDraftRepository, createPlanningRepository } from './repository'
import { planningReferenceReport, type PlanningHostReader } from './references'
import { PlanningError } from './validation'

export interface PlanningIntegrity {
  state: 'unused' | 'valid' | 'warning' | 'invalid' | 'unsupported'
  itemCount: number; draftCount: number; deliveryCount: number; unresolvedCount: number; code?: string
}
const stat = (path: string) => { try { return lstatSync(path) } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw error } }
/** Fixed metadata path, no global store initialization, no file migrations or model access. */
function readHostStore(root: string): Record<string, unknown> {
  const path = join(root, '.mimir/store.json'), entry = stat(path)
  if (!entry) return {}
  const canonical = realpathSync.native(root)
  const checkPath = () => {
    const parent = lstatSync(join(root, '.mimir')), info = lstatSync(path)
    if (parent.isSymbolicLink() || !parent.isDirectory() || info.isSymbolicLink() || !info.isFile()) throw new PlanningError('SOURCE_UNAUTHORIZED')
    const rel = relative(canonical, realpathSync.native(path))
    if (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) throw new PlanningError('SOURCE_UNAUTHORIZED')
    return info
  }
  checkPath()
  if (entry.size > 64 * 1024 * 1024) throw new PlanningError('LIMIT_EXCEEDED')
  let fd: number | undefined
  try {
    fd = openSync(path, 'r'); const opened = fstatSync(fd)
    if (!opened.isFile() || opened.dev !== entry.dev || opened.ino !== entry.ino || opened.size !== entry.size) throw new PlanningError('SOURCE_UNAUTHORIZED')
    const buffer = Buffer.alloc(opened.size + 1)
    let length = 0
    while (length < buffer.length) { const count = readSync(fd, buffer, length, buffer.length - length, null); if (!count) break; length += count }
    const after = fstatSync(fd), current = checkPath()
    if (length !== opened.size || [after, current].some(v => v.dev !== opened.dev || v.ino !== opened.ino || v.size !== opened.size || v.mtimeMs !== opened.mtimeMs || v.ctimeMs !== opened.ctimeMs)) throw new PlanningError('SOURCE_UNAUTHORIZED')
    const bytes = buffer.subarray(0, length)
    if (!isUtf8(bytes)) throw new PlanningError('CORRUPT_DATA')
    const value: unknown = JSON.parse(bytes.toString('utf8'))
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new PlanningError('CORRUPT_DATA')
    return value as Record<string, unknown>
  } finally { if (fd !== undefined) closeSync(fd) }
}
export function inspectPlanningIntegrity(root: string): PlanningIntegrity {
  let itemCount = 0, draftCount = 0, deliveryCount = 0
  try {
    const doc = createPlanningRepository().read(root); itemCount = doc.items.length
    const drafts = createPlanningDraftRepository().read(root); draftCount = drafts.drafts.length
    const deliveries = createPlanningDeliveryRepository().read(root); deliveryCount = deliveries.deliveries.length
    if (!['planning.json', 'drafts.json', 'deliveries.json'].some(name => stat(join(root, '.mimir/planning', name)))) return { state: 'unused', itemCount, draftCount, deliveryCount, unresolvedCount: 0 }
    const inputs = [...doc.items, ...drafts.drafts.map(d => d.input)]
    const hasHostReferences = inputs.some(i => i.libraryProjectId || i.literature?.paperId || i.experimentIds.length)
    const store = hasHostReferences ? readHostStore(root) : {}
    const read: PlanningHostReader = <T>(key: string) => store[key] as T | undefined
    let unresolvedCount = planningReferenceReport(read, inputs).count
    const items = new Map(doc.items.map(i => [i.id, i]))
    for (const draft of drafts.drafts) {
      if (draft.itemId && (!items.has(draft.itemId) || items.get(draft.itemId)!.kind !== draft.input.kind)) unresolvedCount++
      if (draft.input.projectId && items.get(draft.input.projectId)?.kind !== 'project') unresolvedCount++
      if (draft.input.directionId && items.get(draft.input.directionId)?.kind !== 'direction') unresolvedCount++
      if (!doc.collections.some(c => c.id === draft.input.collectionId) || !doc.types.some(t => t.id === draft.input.typeId && t.kind === draft.input.kind)) unresolvedCount++
    }
    for (const entry of deliveries.deliveries) if (items.get(entry.itemId)?.kind !== 'todo') unresolvedCount++
    return { state: unresolvedCount ? 'warning' : 'valid', itemCount, draftCount, deliveryCount, unresolvedCount }
  } catch (error) {
    const code = error instanceof PlanningError ? error.code : 'CORRUPT_DATA'
    return { state: code === 'UNSUPPORTED_VERSION' ? 'unsupported' : 'invalid', itemCount, draftCount, deliveryCount, unresolvedCount: 0, code }
  }
}
export function assertRestoredPlanningIntegrity(root: string) {
  const result = inspectPlanningIntegrity(root)
  if (result.state === 'invalid' || result.state === 'unsupported') throw new RestoreError('RECHECK_FAILED', `科研计划无法校验（${result.code}），未发布恢复空间；原备份保留`)
}
