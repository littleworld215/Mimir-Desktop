/**
 * 路径包含判定的**唯一实现**（I0-03）。
 *
 * 背景：`electron/ipc/index.ts` 原先的 `isWithin` 用 `resolve()` + `startsWith(root + '/')`
 * 手拼前缀判断。这在 Windows（反斜杠、盘符大小写）与软链 / junction 场景下都不成立：
 * - `/a/b` 与 `/a/bc` 会被误判为包含关系（同前缀兄弟目录）；
 * - 目录内一个指向库外的 junction 会骗过纯字符串前缀；
 * - 跨盘符 / UNC 的 `startsWith` 语义与 `path.relative` 不一致。
 *
 * 因此这里用 **`path.relative`** 语义 + **`realpath`** 磁盘实体比对。
 *
 * ⚠️ **失败必须 fail-closed**（QA 复验发现的原缺陷）：早期实现把所有 `realpathSync` 异常
 * 都当成「文件尚不存在」并退回字面路径，于是
 * - 指向库外的**失效链接**（broken symlink / junction）→ 字面路径看似在根内 → 误放行；
 * - `EACCES` / `EPERM` / `ELOOP` 等权限或循环错误 → 同样退回字面路径 → 误放行。
 * 现在用 `lstatSync` 先判定「是否真的存在」：只有 **ENOENT / ENOTDIR（确实不存在）** 才向上
 * 寻找最近已存在祖先；其余异常（含「存在但 realpath 失败」的失效链接）一律**抛错**，
 * 由调用方按拒绝处理。
 */
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { lstatSync, realpathSync } from 'node:fs'

/** 错误是否表示「路径确实不存在」（可安全向上寻找祖先）。 */
function isTrulyMissing(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException | undefined)?.code
  return code === 'ENOENT' || code === 'ENOTDIR'
}

/** 规范化失败（失效链接 / 权限 / 循环）时抛出的错误。调用方应据此**拒绝**。 */
export class PathCanonicalizationError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'PathCanonicalizationError'
  }
}

/**
 * 取路径的**真实**位置：
 * - 存在 → `realpathSync`；
 * - 确实不存在（ENOENT/ENOTDIR）→ 回退到「最近已存在祖先的 realpath + 剩余段」；
 * - **存在但 realpath 失败**（失效链接 / 权限 / 循环）→ **抛错**（fail-closed）。
 */
export function realpathOrNearest(target: string): string {
  const abs = resolve(target)
  const tail: string[] = []
  let current = abs

  for (;;) {
    let exists = false
    try {
      lstatSync(current)
      exists = true
    } catch (error) {
      if (!isTrulyMissing(error)) {
        // 权限 / 循环等：无法确认实体位置，拒绝
        throw new PathCanonicalizationError(
          `无法确认路径实体位置（${(error as NodeJS.ErrnoException).code ?? 'unknown'}）：${current}`
        )
      }
    }

    if (exists) {
      try {
        return join(realpathSync(current), ...tail)
      } catch (error) {
        // lstat 说存在、realpath 却失败：典型是**失效链接**（目标不存在）或链接循环。
        // 这属于「无法确认实体位置」，必须拒绝而不是退回字面路径。
        throw new PathCanonicalizationError(
          `路径存在但无法解析实体位置（${(error as NodeJS.ErrnoException).code ?? 'unknown'}）：${current}`
        )
      }
    }

    const parent = dirname(current)
    if (parent === current) {
      // 连文件系统根都不存在（例如不存在的盘符 `Z:\` / UNC 根）：无法确认实体位置，
      // 必须 fail-closed 抛错，**不得**退回字面路径去声称包含关系（QA 复验发现的边界）。
      throw new PathCanonicalizationError(`路径所在的根不存在，无法确认实体位置：${abs}`)
    }
    tail.unshift(basename(current))
    current = parent
  }
}

/**
 * `target` 是否等于 `root` 或位于 `root` 之下（含相等）。
 *
 * 两侧都先经 {@link realpathOrNearest} 归一，再用 `path.relative` 判定：
 * - 结果为 `''` → 相等；
 * - 结果以 `..` 开头或是绝对路径 → 在外部（同前缀兄弟目录、跨盘符、UNC 越界都会被这里拦下）。
 *
 * @throws {PathCanonicalizationError} 任一侧无法确认实体位置（失效链接 / 权限 / 循环）——
 *   调用方必须按**拒绝**处理，不得当作「不在根内」之外的放行理由。
 */
export function isPathWithin(target: string, root: string): boolean {
  if (root === '' || target === '') return false
  const t = realpathOrNearest(target)
  const r = realpathOrNearest(root)
  if (t === r) return true
  const rel = relative(r, t)
  return rel !== '' && !rel.startsWith(`..${sep}`) && rel !== '..' && !isAbsolute(rel)
}
