/**
 * 分类仓储（I1-01 / I1-02）。
 *
 * 职责边界：**只做** DB 行 ↔ DTO 映射与参数化 SQL，不含业务规则（规则在 `categoryService.ts`）。
 * 不 import IPC / React / Electron；SQL 全部参数化；连接与时钟由调用方（服务）注入。
 */
import type { ArchiveScope, AssetCategory, StorageType } from '../../shared/assetsContracts'
import { AssetsStoreError, type AssetsWriteSession } from './types'

/** `asset_category` 的数据库行（snake_case，与 DDL 一一对应）。 */
export interface CategoryRow {
  code: string
  name: string
  icon: string | null
  default_storage_type: string | null
  description: string
  builtin: number
  parent_code: string | null
  sort_order: number
  revision: number
  created_at: string
}

/** 行 → DTO（camelCase）。`assetCount` 仅列表场景给出。 */
export function toCategoryDto(row: CategoryRow, assetCount?: number): AssetCategory {
  return {
    code: row.code,
    name: row.name,
    icon: row.icon,
    defaultStorageType: (row.default_storage_type ?? null) as StorageType | null,
    description: row.description,
    builtin: row.builtin === 1,
    parentCode: row.parent_code,
    sortOrder: row.sort_order,
    revision: row.revision,
    createdAt: row.created_at,
    ...(assetCount === undefined ? {} : { assetCount })
  }
}

const COLUMNS =
  'code, name, icon, default_storage_type, description, builtin, parent_code, sort_order, revision, created_at'

export function selectAllCategories(session: AssetsWriteSession): CategoryRow[] {
  return session.all<CategoryRow>(
    `SELECT ${COLUMNS} FROM asset_category ORDER BY sort_order ASC, code ASC`
  )
}

export function selectCategory(session: AssetsWriteSession, code: string): CategoryRow | undefined {
  return session.get<CategoryRow>(`SELECT ${COLUMNS} FROM asset_category WHERE code = ?`, code)
}

/** 直接子分类的 code 列表。 */
export function selectChildCodes(session: AssetsWriteSession, code: string): string[] {
  return session
    .all<{ code: string }>('SELECT code FROM asset_category WHERE parent_code = ?', code)
    .map((row) => row.code)
}

/** 全部后代 code（递归，不含自身）——用于「不能移动到自己的子树」判定。 */
export function selectDescendantCodes(session: AssetsWriteSession, code: string): string[] {
  // 单次读出结构后迭代遍历：异常循环显式报错，不让 UNION ALL 无限递归。
  const rows = selectAllCategories(session)
  const children = new Map<string, string[]>()
  for (const row of rows) {
    if (row.parent_code === null) continue
    const siblings = children.get(row.parent_code) ?? []
    siblings.push(row.code)
    children.set(row.parent_code, siblings)
  }
  const visited = new Set<string>([code])
  const pending = [...(children.get(code) ?? [])]
  const result: string[] = []
  while (pending.length > 0) {
    const current = pending.pop() as string
    if (visited.has(current)) throw new AssetsStoreError('CYCLE', '分类结构存在异常循环，请修复分类结构。')
    visited.add(current)
    result.push(current)
    pending.push(...(children.get(current) ?? []))
  }
  return result
}

/** 分类（不含子树）下的资产数；`archived` 决定是否计入归档资产（默认计入，见 §5.2 影响面口径）。 */
export function countAssetsInCategory(
  session: AssetsWriteSession,
  code: string,
  archived: ArchiveScope = 'include'
): number {
  const where = archived === 'exclude' ? 'AND archived_at IS NULL' : archived === 'only' ? 'AND archived_at IS NOT NULL' : ''
  return (
    session.get<{ c: number }>(`SELECT COUNT(*) AS c FROM asset WHERE category = ? ${where}`, code)?.c ?? 0
  )
}

export function insertCategory(
  session: AssetsWriteSession,
  input: {
    code: string
    name: string
    icon: string | null
    defaultStorageType: StorageType | null
    description: string
    parentCode: string | null
    sortOrder: number
    createdAt: string
  }
): void {
  session.run(
    `INSERT INTO asset_category (code, name, icon, default_storage_type, description, builtin, parent_code, sort_order, revision, created_at)
     VALUES (?, ?, ?, ?, ?, 0, ?, ?, 1, ?)`,
    input.code,
    input.name,
    input.icon,
    input.defaultStorageType,
    input.description,
    input.parentCode,
    input.sortOrder,
    input.createdAt
  )
}

/** 按 patch 更新分类；`code` 不可改（不进 patch）。revision 自增由这里统一处理。 */
export function updateCategoryRow(
  session: AssetsWriteSession,
  code: string,
  patch: {
    name?: string
    icon?: string | null
    defaultStorageType?: StorageType | null
    description?: string
    parentCode?: string | null
    sortOrder?: number
  }
): void {
  const sets: string[] = []
  const params: unknown[] = []
  if (patch.name !== undefined) {
    sets.push('name = ?')
    params.push(patch.name)
  }
  if (patch.icon !== undefined) {
    sets.push('icon = ?')
    params.push(patch.icon)
  }
  if (patch.defaultStorageType !== undefined) {
    sets.push('default_storage_type = ?')
    params.push(patch.defaultStorageType)
  }
  if (patch.description !== undefined) {
    sets.push('description = ?')
    params.push(patch.description)
  }
  if (patch.parentCode !== undefined) {
    sets.push('parent_code = ?')
    params.push(patch.parentCode)
  }
  if (patch.sortOrder !== undefined) {
    sets.push('sort_order = ?')
    params.push(patch.sortOrder)
  }
  if (sets.length === 0) return
  sets.push('revision = revision + 1')
  params.push(code)
  session.run(`UPDATE asset_category SET ${sets.join(', ')} WHERE code = ?`, ...params)
}

export function deleteCategoryRow(session: AssetsWriteSession, code: string): void {
  session.run('DELETE FROM asset_category WHERE code = ?', code)
}
