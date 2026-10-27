import { RestoreError } from './restoreContracts'
import { isAbsolutePathLike, normalizeRootForMatch } from './remapRules'
import { lstatSync } from 'node:fs'
import { dirname, isAbsolute, resolve } from 'node:path'
import { assertRestoreDirectory } from './restoreFingerprint'

interface TargetSafetyInput {
  targetRoot: string
  registry: Record<string, unknown>
  sourceRoot?: string
  controlRoot?: string
  code?: 'INVALID_TARGET' | 'REGISTRY_INVALID'
}

/** 核对根关系和最近存在祖先的普通目录身份；不创建目录或改写历史登记。 */
export function assertRestoreTargetSafe(input: TargetSafetyInput): void {
  const invalid = () => new RestoreError(input.code ?? 'INVALID_TARGET', '恢复目标与源空间、已登记空间或本机控制目录重叠，或目录登记无法安全核对。请另选互不嵌套的新目录。')
  const valid = (value: unknown): value is string => typeof value === 'string'
    && isAbsolutePathLike(value) && !/^(?:\\\\|\/\/)/.test(value) && !/[\x00-\x1f]/.test(value)
  if (!valid(input.targetRoot)) throw invalid()
  const list = input.registry['workspaces:list'] === undefined ? [] : input.registry['workspaces:list']
  if (!Array.isArray(list)) throw invalid()
  const roots: string[] = []
  for (const item of list) {
    if (!item || typeof item !== 'object' || Array.isArray(item) || !valid(item.path)) throw invalid()
    roots.push(item.path)
  }
  // 旧包没有可信绝对源根时保持“不猜填”；当前登记与控制目录仍必须核对。
  if (valid(input.sourceRoot)) roots.push(input.sourceRoot)
  if (input.controlRoot !== undefined) {
    if (!valid(input.controlRoot)) throw invalid()
    roots.push(input.controlRoot)
  }
  const boundary = (value: string) => {
    // 本机绝对路径与writerSession使用同一resolve语义；非本机路径只比较词法边界。
    if (!isAbsolute(value)) return normalizeRootForMatch(value)
    const absolute = resolve(value)
    let cursor = absolute
    for (;;) {
      try {
        lstatSync(cursor)
        // 保守拒绝junction、父级别名和无法确认的实体根，不迁移/重写旧登记。
        assertRestoreDirectory(cursor)
        return normalizeRootForMatch(absolute)
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw invalid()
        const parent = dirname(cursor)
        // 已卸载的旧源盘只保留词法边界，不能要求来源空间仍存在才能恢复。
        if (parent === cursor) return normalizeRootForMatch(absolute)
        cursor = parent
      }
    }
  }
  const target = boundary(input.targetRoot)
  const contains = (root: string, child: string) => root === child || child.startsWith(root.endsWith('/') ? root : root + '/')
  for (const root of roots.map(boundary)) {
    if (contains(root, target) || contains(target, root)) throw invalid()
  }
}
