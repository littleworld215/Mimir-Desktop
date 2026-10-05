/**
 * 路径包含判定的**唯一实现**（I0-03）。
 *
 * 背景：`electron/ipc/index.ts` 原先的 `isWithin` 用 `resolve()` + `startsWith(root + '/')`
 * 手拼前缀判断。这在 Windows（反斜杠、盘符大小写）与软链 / junction 场景下都不成立：
 * - `/a/b` 与 `/a/bc` 会被误判为包含关系（同前缀兄弟目录）；
 * - `files/` 内一个指向库外的 junction 会骗过纯字符串前缀；
 * - 跨盘符 / UNC 的 `startsWith` 语义与 `path.relative` 不一致。
 *
 * 因此这里用 **`path.relative`** 语义 + **`realpath`** 磁盘实体比对，供渲染层三条路径通道
 * （`assertRendererPath` / `assertRendererFilePath` / `assertProjectDirs`）共用。
 * 本模块只做纯路径运算（不读业务状态），保持可单测。
 */
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { realpathSync } from 'node:fs'

/**
 * 取路径的**真实**位置：存在则 `realpathSync`；不存在则回退到「最近已存在祖先的 realpath
 * + 剩余路径段」。这样对「尚待创建的目标」也能拿到不会被软链骗过的规范化结果。
 */
export function realpathOrNearest(target: string): string {
  const abs = resolve(target)
  try {
    return realpathSync(abs)
  } catch {
    /* 目标尚不存在，继续向上找最近已存在的祖先 */
  }
  const tail: string[] = []
  let current = abs
  for (;;) {
    const parent = dirname(current)
    if (parent === current) return abs // 已到根仍不存在，退回原始绝对路径
    tail.unshift(basename(current))
    current = parent
    try {
      return join(realpathSync(current), ...tail)
    } catch {
      /* 继续向上 */
    }
  }
}

/**
 * `target` 是否等于 `root` 或位于 `root` 之下（含相等）。
 *
 * 两侧都先经 {@link realpathOrNearest} 归一，再用 `path.relative` 判定：
 * - 结果为 `''` → 相等；
 * - 结果以 `..` 开头或是绝对路径 → 在外部（同前缀兄弟目录、跨盘符、UNC 越界都会被这里拦下）。
 */
export function isPathWithin(target: string, root: string): boolean {
  if (root === '' || target === '') return false
  const t = realpathOrNearest(target)
  const r = realpathOrNearest(root)
  if (t === r) return true
  const rel = relative(r, t)
  return rel !== '' && !rel.startsWith(`..${sep}`) && rel !== '..' && !isAbsolute(rel)
}
