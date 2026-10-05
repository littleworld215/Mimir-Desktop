/**
 * 资产库**托管目录**的写保护判定（I0-03）。
 *
 * 资产库把数据放在当前科研空间的 `<spaceRoot>/.mimir/assets/` 下：
 * ```
 * assets.db (+ -wal / -shm)   版本文件的 SQLite 库
 * files/<assetId>/<blob>      不可变的版本 blob
 * staging/                    文件入库暂存
 * backups/                    迁移前快照
 * ```
 *
 * 这些是**应用托管数据**，不是用户随手编辑的资料：只允许资产服务（`electron/assets/*`）通过
 * 自己的连接与文件 API 读写。通用渲染层文件通道与 Agent 的文件工具一律拒绝。
 *
 * ⚠️ **必须按磁盘实体比较**（QA 复验发现的原缺陷）：早期实现只用 `resolve` + 字面前缀，
 * 于是 `space/alias`（junction 指向 `space/.mimir/assets`）能绕过托管判定
 * —— `isManagedAssetPath(alias/assets.db, space)` 返回 false，而 `isPathWithin` 因走 realpath
 * 返回 true，两者口径不一致导致护栏被别名绕过。现在两侧都经 `realpathOrNearest` 实体化；
 * **规范化失败时按托管处理（拒绝）**，保持 fail-closed。
 *
 * 设计约束：本模块只做路径判定，科研空间根由调用方传入（不 import store，避免顶层副作用
 * 与 vitest 的 `./store` 别名陷阱）；只覆盖 `assets/` 子树，**不**把整个 `.mimir` 当禁区。
 */

import { join, resolve, sep } from 'node:path'
import { ASSETS_SUBDIR } from './paths'
import { realpathOrNearest } from '../ipc/pathGuards'

/** 给用户/模型的可读拒绝理由。 */
export const MANAGED_ASSET_REJECT_MESSAGE =
  '已拒绝：该路径属于资产库的托管数据（数据库 / 版本文件 / 暂存 / 备份），不允许直接读写。请通过资产库功能操作。'

/** 资产库托管子树根（字面绝对路径）。`spaceRootDir` 为空时返回空串。 */
export function managedAssetRoot(spaceRootDir: string): string {
  if (spaceRootDir === '') return ''
  return resolve(join(spaceRootDir, ASSETS_SUBDIR))
}

/** Windows 下路径大小写不敏感，比对前统一小写。 */
function forCompare(p: string): string {
  return process.platform === 'win32' ? p.toLowerCase() : p
}

/**
 * `target` 是否落在资产库托管子树内（含子树根自身）。
 *
 * 两侧都做**磁盘实体化**，因此 `alias -> .mimir/assets` 这类链接别名会被正确判为托管。
 * 无法确认实体位置（失效链接 / 权限 / 循环）时返回 `true`（fail-closed：按托管拒绝）。
 *
 * @param spaceRootDir 当前科研空间根（调用方用 `spaceRoot()` 取得并传入）
 */
export function isManagedAssetPath(target: string, spaceRootDir: string): boolean {
  if (target === '' || spaceRootDir === '') return false
  const root = managedAssetRoot(spaceRootDir)
  if (root === '') return false

  let t: string
  let r: string
  try {
    t = realpathOrNearest(resolve(target))
    r = realpathOrNearest(root)
  } catch {
    // 无法确认实体位置：不能证明它不在托管子树内 → 按托管处理（拒绝）
    return true
  }

  const tc = forCompare(t)
  const rc = forCompare(r)
  const prefix = rc.endsWith(sep) ? rc : `${rc}${sep}`
  return tc === rc || tc.startsWith(prefix)
}
