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
 * 自己的连接与文件 API 读写。通用渲染层文件通道与 Agent 的文件工具（write / edit / delete，
 * 以及读取原始库文件）一律拒绝，避免绕过 append-only 与版本语义、或直接损坏库文件。
 *
 * 设计约束：
 * - 本模块**只做纯路径判定**，科研空间根由调用方传入（不 import store，避免顶层副作用与
 *   vitest 的 `./store` 别名陷阱）。
 * - 只覆盖 `assets/` 子树，**不**把整个 `<spaceRoot>/.mimir` 当成禁区（那里还有 store 与其它域）。
 */

import { join, resolve, sep } from 'node:path'
import { ASSETS_SUBDIR } from './paths'

/** 给用户/模型的可读拒绝理由。 */
export const MANAGED_ASSET_REJECT_MESSAGE =
  '已拒绝：该路径属于资产库的托管数据（数据库 / 版本文件 / 暂存 / 备份），不允许直接读写。请通过资产库功能操作。'

/** 资产库托管子树根（绝对路径）。`spaceRootDir` 为空时返回空串。 */
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
 * @param spaceRootDir 当前科研空间根（调用方用 `spaceRoot()` 取得并传入）
 */
export function isManagedAssetPath(target: string, spaceRootDir: string): boolean {
  if (target === '' || spaceRootDir === '') return false
  const root = managedAssetRoot(spaceRootDir)
  if (root === '') return false
  const t = forCompare(resolve(target))
  const r = forCompare(root)
  const prefix = r.endsWith(sep) ? r : `${r}${sep}`
  return t === r || t.startsWith(prefix)
}
