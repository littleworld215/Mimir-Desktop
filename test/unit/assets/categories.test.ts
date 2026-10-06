/**
 * 分类服务测试（I1-02）—— 真实临时 better-sqlite3，不碰真实 `~/.mimir`。
 *
 * 守护点：code 不可改；移动到自身/后代拒绝；父不存在拒绝；内置不可删；
 * 有子分类或有资产（**含归档资产**）不可删；revision 冲突；no-op 不推进 revision。
 */
import Database from 'better-sqlite3'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { AssetsStoreManager } from '../../../electron/assets/store'
import type { AssetsContext, DatabaseFactory } from '../../../electron/assets/types'
import {
  categoryImpact,
  createCategory,
  listCategories,
  removeCategory,
  updateCategory
} from '../../../electron/assets/categoryService'

const factory: DatabaseFactory = (path, options) => new Database(path, options)

let root = ''
let manager: AssetsStoreManager
let ctx: AssetsContext

beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), 'assets-cat-test-'))
  manager = new AssetsStoreManager({ active: () => ({ id: 'A', path: root }), epoch: () => 'A#1' }, factory)
  ctx = await manager.getForRequest(manager.context())
})

afterEach(async () => {
  await manager.close()
  rmSync(root, { recursive: true, force: true })
})

/** 断言调用抛出带指定业务 code 的错误（并返回该错误以便进一步断言）。 */
function expectCode(fn: () => unknown, code: string): { code: string; details?: unknown } {
  try {
    fn()
  } catch (error) {
    expect(error).toMatchObject({ code })
    return error as { code: string }
  }
  throw new Error(`应当抛出 ${code}，但没有抛错`)
}

/** 直接插入一条资产（用于验证「分类被占用」与归档口径）。 */
function insertAsset(code: string, category: string, archived: boolean): void {
  const now = new Date().toISOString()
  ctx.write((session) =>
    session.run(
      `INSERT INTO asset (code, name, category, storage_type, created_at, updated_at, archived_at)
       VALUES (?, ?, ?, 'inline_text', ?, ?, ?)`,
      code,
      code,
      category,
      now,
      now,
      archived ? now : null
    )
  )
}

describe('listCategories', () => {
  it('返回预置 15 个分类且均标记为内置', () => {
    const all = listCategories(ctx)
    expect(all).toHaveLength(15)
    expect(all.every((c) => c.builtin)).toBe(true)
    expect(all.map((c) => c.code)).toContain('inbox')
  })
})

describe('createCategory', () => {
  it('显式 code 创建成功，revision 为 1、builtin 为 false', () => {
    const created = createCategory(ctx, { name: '我的分类', code: 'my-cat' })
    expect(created).toMatchObject({ code: 'my-cat', name: '我的分类', builtin: false, revision: 1 })
    expect(listCategories(ctx)).toHaveLength(16)
  })

  it('缺省 code 由名称派生；非 ASCII 名称回退 cat- 前缀', () => {
    expect(createCategory(ctx, { name: 'Code Snippets' }).code).toBe('code-snippets')
    expect(createCategory(ctx, { name: '纯中文名' }).code).toMatch(/^cat-[a-z0-9]{6}$/)
  })

  it('重复 code → DUPLICATE_CODE', () => {
    createCategory(ctx, { name: 'X', code: 'dup' })
    expectCode(() => createCategory(ctx, { name: 'Y', code: 'dup' }), 'DUPLICATE_CODE')
  })

  it('父分类不存在 → BAD_CATEGORY，且零写入', () => {
    expectCode(() => createCategory(ctx, { name: 'Z', code: 'z1', parentCode: 'nope' }), 'BAD_CATEGORY')
    expect(listCategories(ctx)).toHaveLength(15)
  })
})

describe('updateCategory', () => {
  it('改名成功且 revision 递增；code 不变', () => {
    const created = createCategory(ctx, { name: '原名', code: 'ren' })
    const updated = updateCategory(ctx, 'ren', created.revision, { name: '新名' })
    expect(updated.name).toBe('新名')
    expect(updated.code).toBe('ren')
    expect(updated.revision).toBe(created.revision + 1)
  })

  it('no-op（同值 patch）不推进 revision', () => {
    const created = createCategory(ctx, { name: '同值', code: 'noop' })
    const updated = updateCategory(ctx, 'noop', created.revision, { name: '同值' })
    expect(updated.revision).toBe(created.revision)
  })

  it('revision 不匹配 → REVISION_CONFLICT 并带 currentRevision', () => {
    const created = createCategory(ctx, { name: '冲突', code: 'conf' })
    const error = expectCode(() => updateCategory(ctx, 'conf', created.revision + 5, { name: 'X' }), 'REVISION_CONFLICT')
    expect(error).toMatchObject({ details: { currentRevision: created.revision } })
  })

  it('移动到自身 → CYCLE', () => {
    createCategory(ctx, { name: '自身', code: 'self' })
    expectCode(() => updateCategory(ctx, 'self', 1, { parentCode: 'self' }), 'CYCLE')
  })

  it('移动到自己的后代 → CYCLE', () => {
    createCategory(ctx, { name: '根', code: 'root1' })
    createCategory(ctx, { name: '子', code: 'child1', parentCode: 'root1' })
    createCategory(ctx, { name: '孙', code: 'grand1', parentCode: 'child1' })
    expectCode(() => updateCategory(ctx, 'root1', 1, { parentCode: 'grand1' }), 'CYCLE')
  })

  it('父分类不存在 → BAD_CATEGORY 且零修改', () => {
    const created = createCategory(ctx, { name: '不动', code: 'stay' })
    expectCode(() => updateCategory(ctx, 'stay', created.revision, { parentCode: 'ghost' }), 'BAD_CATEGORY')
    const after = listCategories(ctx).find((c) => c.code === 'stay')
    expect(after).toMatchObject({ revision: created.revision, parentCode: null })
  })

  it('不存在的分类 → NOT_FOUND', () => {
    expectCode(() => updateCategory(ctx, 'ghost', 1, { name: 'X' }), 'NOT_FOUND')
  })
})

describe('categoryImpact / removeCategory', () => {
  it('影响面：资产数含归档、子分类数、是否内置', () => {
    createCategory(ctx, { name: '父', code: 'p1' })
    createCategory(ctx, { name: '子', code: 'c1', parentCode: 'p1' })
    insertAsset('a-live', 'p1', false)
    insertAsset('a-arch', 'p1', true)
    expect(categoryImpact(ctx, 'p1')).toEqual({ code: 'p1', assetCount: 2, childCount: 1, builtin: false })
  })

  it('内置分类不可删 → BUILTIN_PROTECTED', () => {
    const inbox = listCategories(ctx).find((c) => c.code === 'inbox')
    expectCode(() => removeCategory(ctx, 'inbox', inbox?.revision ?? 1), 'BUILTIN_PROTECTED')
  })

  it('有子分类 → HAS_CHILDREN', () => {
    createCategory(ctx, { name: '父', code: 'p2' })
    createCategory(ctx, { name: '子', code: 'c2', parentCode: 'p2' })
    expectCode(() => removeCategory(ctx, 'p2', 1), 'HAS_CHILDREN')
  })

  it('有归档资产也算占用 → CATEGORY_IN_USE（默认列表隐藏不代表可删）', () => {
    createCategory(ctx, { name: '归档占用', code: 'p3' })
    insertAsset('only-arch', 'p3', true)
    expectCode(() => removeCategory(ctx, 'p3', 1), 'CATEGORY_IN_USE')
  })

  it('空分类可删除，且删除后不再出现在列表里', () => {
    const created = createCategory(ctx, { name: '待删', code: 'gone' })
    expect(removeCategory(ctx, 'gone', created.revision)).toBe('gone')
    expect(listCategories(ctx).map((c) => c.code)).not.toContain('gone')
    expect(listCategories(ctx)).toHaveLength(15)
  })

  it('删除时 revision 过期 → REVISION_CONFLICT', () => {
    const created = createCategory(ctx, { name: '过期', code: 'stale' })
    expectCode(() => removeCategory(ctx, 'stale', created.revision + 1), 'REVISION_CONFLICT')
  })
})

describe('未知参数与子树保护', () => {
  it('所有非法类型拒绝且零写入', () => {
    const invalid: unknown[] = [null, true, [], { name: true }, { name: 'x', code: {} },
      { name: 'x', parentCode: false }, { name: 'x', icon: {} }, { name: 'x', description: false },
      { name: 'x', sortOrder: '1' }, { name: 'x', sortOrder: Infinity },
      { name: 'x', defaultStorageType: true }, { name: 'x', revision: 1 }]
    for (const input of invalid) expectCode(() => createCategory(ctx, input), 'BAD_REQUEST')
    expect(listCategories(ctx)).toHaveLength(15)
  })
  it('非法patch与revision拒绝且行保持一致', () => {
    const category = createCategory(ctx, { code: 'check', name: 'Check' })
    for (const patch of [{ name: {} }, { parentCode: true }, { sortOrder: false }, { icon: 1 },
      { description: [] }, { defaultStorageType: {} }, { code: 'changed' }]) {
      expectCode(() => updateCategory(ctx, 'check', 1, patch), 'BAD_REQUEST')
    }
    expectCode(() => updateCategory(ctx, 'check', true as unknown as number, {}), 'BAD_REQUEST')
    expect(listCategories(ctx).find(c => c.code === 'check')).toEqual(category)
  })
  it('影响面包含完整子树与归档资产', () => {
    createCategory(ctx, { code: 'tree', name: 'Tree' })
    createCategory(ctx, { code: 'branch', name: 'Branch', parentCode: 'tree' })
    createCategory(ctx, { code: 'leaf', name: 'Leaf', parentCode: 'branch' })
    insertAsset('root-asset', 'tree', false)
    insertAsset('leaf-archived', 'leaf', true)
    expect(categoryImpact(ctx, 'tree')).toEqual({ code: 'tree', assetCount: 2, childCount: 2, builtin: false })
  })
  it('异常循环显式拒绝且不挂起', () => {
    createCategory(ctx, { code: 'cycle-a', name: 'A' })
    createCategory(ctx, { code: 'cycle-b', name: 'B', parentCode: 'cycle-a' })
    ctx.write(s => s.run("UPDATE asset_category SET parent_code='cycle-b' WHERE code='cycle-a'"))
    expectCode(() => categoryImpact(ctx, 'cycle-a'), 'CYCLE')
  })
  it('父存在检查与插入只执行一个事务', () => {
    let writes = 0
    const wrapped: AssetsContext = { ...ctx, write: operation => { writes += 1; return ctx.write(operation) } }
    createCategory(wrapped, { code: 'atomic', name: 'Atomic', parentCode: 'inbox' })
    expect(writes).toBe(1)
  })
})

describe('code沿用trim语义', () => {
  it('带空白父code创建与移动成功，规范目标更新/影响/删除一致', () => {
    const a=createCategory(ctx,{code:'trim-a',name:'A',parentCode:' inbox '})
    expect(a.parentCode).toBe('inbox')
    const b=createCategory(ctx,{code:'trim-b',name:'B'})
    const moved=updateCategory(ctx,' trim-a ',a.revision,{parentCode:' trim-b '})
    expect(moved.parentCode).toBe('trim-b')
    expect(categoryImpact(ctx,' trim-b ')).toEqual(categoryImpact(ctx,'trim-b'))
    const noop=updateCategory(ctx,' trim-a ',moved.revision,{parentCode:' trim-b '})
    expect(noop.revision).toBe(moved.revision)
    expect(removeCategory(ctx,' trim-a ',noop.revision)).toBe('trim-a')
    expect(removeCategory(ctx,' trim-b ',b.revision)).toBe('trim-b')
  })
  it('规范化目标冲突与循环检查零修改', () => {
    const a=createCategory(ctx,{code:'trim-root',name:'Root'})
    createCategory(ctx,{code:'trim-child',name:'Child',parentCode:' trim-root '})
    const before=listCategories(ctx)
    expectCode(()=>updateCategory(ctx,' trim-root ',a.revision+1,{name:'Changed'}),'REVISION_CONFLICT')
    expectCode(()=>updateCategory(ctx,' trim-root ',a.revision,{parentCode:' trim-child '}),'CYCLE')
    expect(listCategories(ctx)).toEqual(before)
  })
})

describe('派生 code 的稳定性', () => {
  it('同一名称派生同一 code，第二次创建报 DUPLICATE_CODE', () => {
    expect(createCategory(ctx, { name: 'Stable Name' }).code).toBe('stable-name')
    expectCode(() => createCategory(ctx, { name: 'Stable Name' }), 'DUPLICATE_CODE')
  })
})
