/** G-04：只在恢复暂存根关联已知快照桶和空间模板；冲突不合并。 */
import { createHash } from 'node:crypto'
import { lstatSync, readdirSync, renameSync } from 'node:fs'
import { join } from 'node:path'
import { RestoreError } from './restoreContracts'
import { collectPathReferences } from './structuredPaths'
import { isAbsolutePathLike, matchRootPrefix } from './remapRules'
import type { RemapAuditReport, AssociationSummary } from './remapAudit'

const preferencePrefix = 'assets-task-pack:'
const bucketKey = (project: string) => createHash('sha1').update(project).digest('hex').slice(0, 16)
function conflict(): never { throw new RestoreError('RECHECK_FAILED', '恢复关联存在冲突，已保留资料，未合并或覆盖。') }

/** 在读取空间JSON之前校验控制父目录，不能先读取junction目标再补写入检查。 */
export function assertAssociationRoot(root: string): void {
  try {
    const stat = lstatSync(root)
    if (!stat.isDirectory() || stat.isSymbolicLink()) conflict()
    let control
    try { control = lstatSync(join(root, '.mimir')) } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return
      throw error
    }
    if (!control.isDirectory() || control.isSymbolicLink()) conflict()
  } catch (error) {
    if (error instanceof RestoreError) throw error
    throw new RestoreError('RECHECK_FAILED', '恢复暂存目录不可用，已停止关联。')
  }
}

function relink(input: {
  stagingRoot: string
  original: Record<string, unknown>
  restored: Record<string, unknown>
  report: RemapAuditReport
  newSpaceId?: string
  sourceSpaceId?: string
  oldRoot: string
}): AssociationSummary {
  assertAssociationRoot(input.stagingRoot)
  const summary = { snapshotsRelinked: 0, unknownSnapshotBuckets: 0, templatesRelinked: 0, unresolvedTemplates: 0, externalSnapshotBuckets: 0 }
  const keys = Object.keys(input.original).filter(key => key.startsWith(preferencePrefix) && key.length > preferencePrefix.length)
  const selected = input.sourceSpaceId !== undefined ? `${preferencePrefix}${input.sourceSpaceId}` : keys.length === 1 ? keys[0] : undefined
  if (input.sourceSpaceId === undefined && keys.length > 1) conflict()
  let template: { key: string; value: unknown } | undefined
  if (selected !== undefined && Object.hasOwn(input.original, selected)) {
    if (!input.newSpaceId) conflict()
    const target = `${preferencePrefix}${input.newSpaceId}`
    const value = input.original[selected]
    if (Object.hasOwn(input.restored, target) && JSON.stringify(input.restored[target]) !== JSON.stringify(value)) conflict()
    if (target !== selected && !Object.hasOwn(input.restored, target)) template = { key: target, value }
  }
  summary.unresolvedTemplates = keys.filter(key => key !== selected).length

  const projectPaths = collectPathReferences(input.original).filter(ref => ref.kind === 'project')
    .map(ref => Reflect.get(ref.container, ref.field) as string).filter(isAbsolutePathLike)
  const known = new Set(projectPaths.map(bucketKey))
  const external = new Set(projectPaths.filter(path => isAbsolutePathLike(input.oldRoot) && !matchRootPrefix(path, input.oldRoot).matched).map(bucketKey))
  const mappings = new Map<string, string>()
  for (const row of input.report.rewritten) {
    if (row.storeKey !== 'library:projects' && row.storeKey !== 'paper.recentProjects') continue
    const from = bucketKey(row.oldValue), to = bucketKey(row.newValue)
    if (mappings.has(from) && mappings.get(from) !== to) conflict()
    mappings.set(from, to)
  }
  const snapshots = join(input.stagingRoot, '.mimir/paper-snapshots')
  let entries: string[] = []
  try {
    const stat = lstatSync(snapshots)
    if (!stat.isDirectory() || stat.isSymbolicLink()) conflict()
    entries = readdirSync(snapshots)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
  const filesystemKey = (name: string) => process.platform === 'win32' ? name.toLowerCase() : name
  const existing = new Set(entries.map(filesystemKey)), targets = new Set<string>(), moves: Array<{ from: string; to: string }> = []
  for (const entry of entries) {
    const stat = lstatSync(join(snapshots, entry))
    if (stat.isSymbolicLink()) conflict()
    const from = filesystemKey(entry)
    if (!known.has(from)) summary.unknownSnapshotBuckets++
    if (external.has(from)) summary.externalSnapshotBuckets++
    const to = mappings.get(from)
    if (to === undefined || to === from) continue
    if (!stat.isDirectory() || existing.has(filesystemKey(to)) || targets.has(filesystemKey(to))) conflict()
    targets.add(filesystemKey(to))
    moves.push({ from: entry, to })
  }
  // 上面的模板/全部桶冲突预检结束后，才开始修改本任务暂存副本。
  for (const move of moves) {
    renameSync(join(snapshots, move.from), join(snapshots, move.to))
    summary.snapshotsRelinked++
  }
  if (template !== undefined) {
    input.restored[template.key] = template.value
    summary.templatesRelinked++
  }
  return summary
}

export function relinkRestoredAssociations(input: Parameters<typeof relink>[0]): AssociationSummary {
  try { return relink(input) }
  catch (error) {
    if (error instanceof RestoreError) throw error
    throw new RestoreError('RECHECK_FAILED', '恢复关联失败，已保留本次暂存资料，未合并或覆盖。')
  }
}
