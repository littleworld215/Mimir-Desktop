import { closeSync, fstatSync, lstatSync, openSync, readSync, realpathSync } from 'node:fs'
import { basename, dirname, isAbsolute, join, resolve, sep } from 'node:path'
import { isUtf8 } from 'node:buffer'
import { createEvidenceExportWriter } from '../library/evidence/export'
import { isControlPlanePath } from '../agent/controlPlane'
import { assertPlanningBytes, PlanningError } from './validation'
import type { PlanningContext } from './service'

export function readSelectedPlanningFile(path: string) {
  let fd: number | undefined
  try {
    if (!isAbsolute(path)) throw new PlanningError('SOURCE_UNAUTHORIZED')
    const before = lstatSync(path)
    if (!before.isFile() || before.isSymbolicLink()) throw new PlanningError('SOURCE_UNAUTHORIZED', '请选择普通JSON文件，不接受链接或目录')
    assertPlanningBytes(before.size)
    fd = openSync(path, 'r')
    const opened = fstatSync(fd)
    if (opened.dev !== before.dev || opened.ino !== before.ino || opened.size !== before.size || !opened.isFile()) throw new PlanningError('SOURCE_UNAUTHORIZED', '选择文件已变化')
    const buffer = Buffer.alloc(opened.size + 1)
    let length = 0
    while (length < buffer.length) { const count = readSync(fd, buffer, length, buffer.length - length, null); if (count === 0) break; length += count }
    const after = fstatSync(fd), entry = lstatSync(path)
    if (length !== opened.size || after.size !== opened.size || after.mtimeMs !== opened.mtimeMs || after.ctimeMs !== opened.ctimeMs || entry.isSymbolicLink() || entry.dev !== opened.dev || entry.ino !== opened.ino || entry.size !== after.size || entry.mtimeMs !== after.mtimeMs) throw new PlanningError('SOURCE_UNAUTHORIZED', '读取期间文件变化，未导入')
    const bytes = buffer.subarray(0, length)
    if (!isUtf8(bytes)) throw new PlanningError('BAD_REQUEST', 'JSON必须为有效UTF-8')
    return bytes
  } catch (error) {
    if (error instanceof PlanningError) throw error
    throw new PlanningError('SOURCE_UNAUTHORIZED', '选中文件不可读，原资料保留')
  } finally { if (fd !== undefined) closeSync(fd) }
}
export function writeSelectedPlanningExport(ctx: PlanningContext, path: string, bytes: Buffer) {
  ctx.assertCurrent(); assertPlanningBytes(bytes.length)
  if (!isAbsolute(path)) throw new PlanningError('SOURCE_UNAUTHORIZED')
  const parent = realpathSync.native(dirname(path)), target = join(parent, basename(path))
  const parts = resolve(target).toLocaleLowerCase().split(sep)
  if (parts.includes('.mimir') || isControlPlanePath(target)) throw new PlanningError('SOURCE_UNAUTHORIZED', '请保存到普通资料目录，不写入工作台内部元数据或配置目录')
  createEvidenceExportWriter()(target, bytes)
}
