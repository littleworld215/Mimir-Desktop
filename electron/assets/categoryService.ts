/**
 * 分类服务（I1-02）。
 *
 * 规则（整合计划 §3.2 / §4 I1-02）：
 * - `code` 不可改；新建可显式指定，缺省由名称派生（非 ASCII 名称回退随机后缀）。
 * - 移动：父不存在 → `BAD_CATEGORY`；移动到自身或其后代 → `CYCLE`。
 * - 内置分类（`builtin=1`）不可删除 → `BUILTIN_PROTECTED`。
 * - 有子分类 → `HAS_CHILDREN`；分类内有资产（**含归档资产**）→ `CATEGORY_IN_USE`。
 * - 更新带 `expectedRevision`；不匹配 → `REVISION_CONFLICT`；**无实际变化不推进 revision**。
 * - 每次调用都在 `ctx.write` 的**同一个同步事务**里完成读—校验—写，不跨 await。
 */
import type { ArchiveScope, AssetCategory, CategoryCreate, CategoryImpact, CategoryPatch } from '../../shared/assetsContracts'
import { AssetsStoreError, type AssetsContext } from './types'
import { assertAssetCode, assertAssetName } from './validation'
import {
  countAssetsInCategory,
  deleteCategoryRow,
  insertCategory,
  selectAllCategories,
  selectCategory,
  selectChildCodes,
  selectDescendantCodes,
  toCategoryDto,
  updateCategoryRow
} from './categoryRepository'

/** 由名称派生一个合法 code；非 ASCII 名称（slug 为空）回退随机后缀。 */
function deriveCode(name: string): string {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80)
  if (slug !== '' && /^[a-z0-9]+(-[a-z0-9]+)*$/.test(slug)) return slug
  return `cat-${Math.random().toString(36).slice(2, 8)}`
}

/** 在任何 SQL 执行前校验未知 IPC payload，不做隐式类型转换。 */
function validateInput(input: unknown, creating: boolean): CategoryCreate | CategoryPatch {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) {
    throw new AssetsStoreError('BAD_REQUEST', '分类参数必须是对象。')
  }
  const value = { ...input } as Record<string, unknown>
  const keys = ['name', 'icon', 'defaultStorageType', 'description', 'parentCode', 'sortOrder']
  if (creating) keys.push('code')
  if (Object.keys(value).some(key => !keys.includes(key))) throw new AssetsStoreError('BAD_REQUEST', '分类参数含未知字段。')
  try {
    if (creating || value.name !== undefined) assertAssetName(value.name)
    if (value.code !== undefined) assertAssetCode(value.code)
    if (value.parentCode !== undefined && value.parentCode !== null) value.parentCode = assertAssetCode(value.parentCode)
  } catch {
    throw new AssetsStoreError('BAD_REQUEST', '分类名称或标识非法。')
  }
  if (value.icon !== undefined && value.icon !== null && (typeof value.icon !== 'string' || value.icon.includes('\u0000'))) {
    throw new AssetsStoreError('BAD_REQUEST', '分类图标必须是字符串或 null。')
  }
  if (value.description !== undefined && (typeof value.description !== 'string' || value.description.includes('\u0000'))) {
    throw new AssetsStoreError('BAD_REQUEST', '分类描述必须是字符串。')
  }
  if (value.defaultStorageType !== undefined && value.defaultStorageType !== null &&
      !['inline_text', 'file', 'external_link'].includes(value.defaultStorageType as string)) {
    throw new AssetsStoreError('BAD_REQUEST', '分类默认存储类型非法。')
  }
  if (value.sortOrder !== undefined && (typeof value.sortOrder !== 'number' || !Number.isSafeInteger(value.sortOrder))) {
    throw new AssetsStoreError('BAD_REQUEST', '分类排序必须是安全整数。')
  }
  return value as unknown as CategoryCreate | CategoryPatch
}

function validateCodeRevision(code: unknown, revision?: unknown, requireRevision = false): void {
  try { assertAssetCode(code) } catch { throw new AssetsStoreError('BAD_REQUEST', '分类标识非法。') }
  if ((requireRevision || revision !== undefined) && (typeof revision !== 'number' || !Number.isSafeInteger(revision) || revision <= 0)) {
    throw new AssetsStoreError('BAD_REQUEST', '分类 revision 必须是正安全整数。')
  }
}

/** 列出全部分类（含未归档资产计数）。 */
export function listCategories(ctx: AssetsContext, archived: ArchiveScope = 'exclude'): AssetCategory[] {
  if (!['exclude', 'only', 'include'].includes(archived)) throw new AssetsStoreError('BAD_REQUEST', '归档筛选非法。')
  return ctx.write((session) =>
    selectAllCategories(session).map((row) =>
      toCategoryDto(row, countAssetsInCategory(session, row.code, archived))
    )
  )
}

export function createCategory(ctx: AssetsContext, payload: unknown): AssetCategory {
  const input = validateInput(payload, true) as CategoryCreate
  const name = assertAssetName(input.name)
  const code = input.code === undefined ? deriveCode(name) : assertAssetCode(input.code)
  const parentCode = input.parentCode ?? null
  if (parentCode !== null) assertAssetCode(parentCode)

  return ctx.write((session) => {
    if (parentCode !== null && selectCategory(session, parentCode) === undefined) {
      throw new AssetsStoreError('BAD_CATEGORY', `父分类不存在：${parentCode}`)
    }
    if (selectCategory(session, code) !== undefined) {
      throw new AssetsStoreError('DUPLICATE_CODE', `分类 code 已存在：${code}`)
    }
    insertCategory(session, {
      code,
      name,
      icon: input.icon ?? null,
      defaultStorageType: input.defaultStorageType ?? null,
      description: input.description ?? '',
      parentCode,
      sortOrder: input.sortOrder ?? 0,
      createdAt: new Date().toISOString()
    })
    const row = selectCategory(session, code)
    if (row === undefined) throw new AssetsStoreError('WRITE_FAILED', '分类创建后未能读回。')
    return toCategoryDto(row, 0)
  })
}

export function updateCategory(
  ctx: AssetsContext,
  code: string,
  expectedRevision: number,
  payload: unknown
): AssetCategory {
  validateCodeRevision(code, expectedRevision, true)
  code = assertAssetCode(code)
  const patch = validateInput(payload, false) as CategoryPatch
  return ctx.write((session) => {
    const current = selectCategory(session, code)
    if (current === undefined) throw new AssetsStoreError('NOT_FOUND', `分类不存在：${code}`)
    if (current.revision !== expectedRevision) {
      throw new AssetsStoreError('REVISION_CONFLICT', '该分类已被修改，请刷新后重试。', {
        currentRevision: current.revision
      })
    }

    if (patch.parentCode !== undefined && patch.parentCode !== null) {
      const parentCode = patch.parentCode
      if (parentCode === code) {
        throw new AssetsStoreError('CYCLE', '不能把分类移动到它自己下面。')
      }
      if (selectCategory(session, parentCode) === undefined) {
        throw new AssetsStoreError('BAD_CATEGORY', `父分类不存在：${parentCode}`)
      }
      if (selectDescendantCodes(session, code).includes(parentCode)) {
        throw new AssetsStoreError('CYCLE', '不能把分类移动到它自己的子分类下面。')
      }
    }

    const nextName = patch.name === undefined ? undefined : assertAssetName(patch.name)
    // 无实际变化 → 不写、不推进 revision（no-op 不应制造冲突）。
    const changed =
      (nextName !== undefined && nextName !== current.name) ||
      (patch.icon !== undefined && (patch.icon ?? null) !== current.icon) ||
      (patch.defaultStorageType !== undefined &&
        (patch.defaultStorageType ?? null) !== current.default_storage_type) ||
      (patch.description !== undefined && patch.description !== current.description) ||
      (patch.parentCode !== undefined && (patch.parentCode ?? null) !== current.parent_code) ||
      (patch.sortOrder !== undefined && patch.sortOrder !== current.sort_order)

    if (changed) {
      updateCategoryRow(session, code, { ...patch, ...(nextName === undefined ? {} : { name: nextName }) })
    }
    const row = selectCategory(session, code)
    if (row === undefined) throw new AssetsStoreError('WRITE_FAILED', '分类更新后未能读回。')
    return toCategoryDto(row, countAssetsInCategory(session, code, 'include'))
  })
}

/** 影响面：资产数（**含归档**）、子分类数、是否内置。 */
export function categoryImpact(ctx: AssetsContext, code: string): CategoryImpact {
  validateCodeRevision(code)
  code = assertAssetCode(code)
  return ctx.write((session) => {
    const row = selectCategory(session, code)
    if (row === undefined) throw new AssetsStoreError('NOT_FOUND', `分类不存在：${code}`)
    const descendants = selectDescendantCodes(session, code)
    return {
      code,
      assetCount: [code, ...descendants].reduce((sum, child) => sum + countAssetsInCategory(session, child, 'include'), 0),
      childCount: descendants.length,
      builtin: row.builtin === 1
    }
  })
}

/** 删除分类（受内置 / 子分类 / 资产占用三重保护）。 */
export function removeCategory(ctx: AssetsContext, code: string, expectedRevision: number): string {
  validateCodeRevision(code, expectedRevision, true)
  code = assertAssetCode(code)
  return ctx.write((session) => {
    const row = selectCategory(session, code)
    if (row === undefined) throw new AssetsStoreError('NOT_FOUND', `分类不存在：${code}`)
    if (row.revision !== expectedRevision) {
      throw new AssetsStoreError('REVISION_CONFLICT', '该分类已被修改，请刷新后重试。', {
        currentRevision: row.revision
      })
    }
    if (row.builtin === 1) {
      throw new AssetsStoreError('BUILTIN_PROTECTED', '内置分类不可删除。')
    }
    if (selectChildCodes(session, code).length > 0) {
      throw new AssetsStoreError('HAS_CHILDREN', '该分类下还有子分类，请先处理子分类。')
    }
    // 影响面口径含归档资产：默认列表隐藏归档，不代表分类可以安全删除。
    const inUse = countAssetsInCategory(session, code, 'include')
    if (inUse > 0) {
      throw new AssetsStoreError('CATEGORY_IN_USE', `该分类下还有 ${inUse} 个资产（含归档），不能删除。`)
    }
    deleteCategoryRow(session, code)
    return code
  })
}
