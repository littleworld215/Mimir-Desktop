import Database from 'better-sqlite3'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeEach, afterEach, it, expect } from 'vitest'
import { AssetsStoreManager } from '../../../electron/assets/store'
import type { AssetsContext } from '../../../electron/assets/types'
import { createAsset, getAsset } from '../../../electron/assets/assetService'
import { addReference, removeReference, getReferences, getReferenceGraph } from '../../../electron/assets/referenceService'
import { archiveAsset, deleteAsset } from '../../../electron/assets/archiveService'

let root: string
let manager: AssetsStoreManager
let ctx: AssetsContext
beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), 'assets-ref-'))
  manager = new AssetsStoreManager({ active: () => ({ id: 'A', path: root }), epoch: () => 'A#1' }, (p, o) => new Database(p, o))
  ctx = await manager.getForRequest(manager.context())
})
afterEach(async () => { await manager.close(); rmSync(root, { recursive: true, force: true }) })
function create(name = 'Asset') { return createAsset(ctx, { name, category: 'inbox', storageType: 'inline_text', content: '  immutable\n\n' }) }
function request(sourceAssetId: number, targetAssetId: number, expectedRevision = getAsset(ctx, sourceAssetId).revision) {
  return { sourceAssetId, targetAssetId, expectedRevision }
}
it('有向参见/被参见及反向关系去重，只更新源revision与时间，不改历史', () => {
  const a = create('A'), b = create('B')
  const versions = ctx.write(s => s.all('SELECT * FROM asset_version ORDER BY id'))
  expect(addReference(ctx, request(a.id, b.id))).toEqual({ changed: true, revision: 2 })
  const after = getAsset(ctx, a.id)
  expect(after.currentContent).toBe(a.currentContent)
  expect(after.currentVersionId).toBe(a.currentVersionId)
  expect(getAsset(ctx, b.id)).toEqual(b)
  expect(addReference(ctx, request(a.id, b.id))).toEqual({ changed: false, revision: 2 })
  expect(getAsset(ctx, a.id)).toEqual(after)
  expect(getReferences(ctx, { assetId: a.id })).toMatchObject({ assetId: a.id, revision: 2, references: [{ id: b.id }], referencedBy: [] })
  expect(getReferences(ctx, { assetId: b.id }).referencedBy.map(r => r.id)).toEqual([a.id])
  expect(addReference(ctx, request(b.id, a.id))).toEqual({ changed: true, revision: 2 })
  expect(removeReference(ctx, request(a.id, b.id))).toEqual({ changed: true, revision: 3 })
  expect(removeReference(ctx, request(a.id, b.id))).toEqual({ changed: false, revision: 3 })
  expect(ctx.write(s => s.all('SELECT * FROM asset_version ORDER BY id'))).toEqual(versions)
})
it('缺资产/自参见/非法参数/未知字段拒绝且不写关系或revision', () => {
  const a = create(), b = create()
  for (const payload of [request(a.id, a.id), request(a.id, 999), { ...request(a.id, b.id), expectedRevision: 0 }, { ...request(a.id, b.id), targetAssetId: '2' }, { ...request(a.id, b.id), unexpected: true }, null, [], { sourceAssetId: a.id, targetAssetId: b.id }]) {
    expect(() => addReference(ctx, payload)).toThrow()
    expect(() => removeReference(ctx, payload)).toThrow()
  }
  expect(getAsset(ctx, a.id)).toEqual(a)
  expect(getReferences(ctx, { assetId: a.id }).references).toEqual([])
  expect(() => getReferences(ctx, { assetId: 999 })).toThrowError(expect.objectContaining({ code: 'NOT_FOUND' }))
})
it('旧revision先拒绝，重复关系也不能绕过条件', () => {
  const a = create(), b = create()
  addReference(ctx, request(a.id, b.id, 1))
  for (const operation of [addReference, removeReference]) expect(() => operation(ctx, request(a.id, b.id, 1))).toThrowError(expect.objectContaining({ code: 'REVISION_CONFLICT', details: { currentRevision: 2 } }))
  expect(getReferences(ctx, { assetId: a.id }).references.map(r => r.id)).toEqual([b.id])
})
it('归档源拒写，归档目标可关联并可读，不隐式恢复', () => {
  const a = create(), b = create()
  archiveAsset(ctx, b.id, 1)
  addReference(ctx, request(a.id, b.id))
  expect(getReferences(ctx, { assetId: a.id }).references[0].archivedAt).not.toBeNull()
  const archived = archiveAsset(ctx, a.id, 2).asset
  for (const operation of [addReference, removeReference]) expect(() => operation(ctx, request(a.id, b.id, archived.revision))).toThrowError(expect.objectContaining({ code: 'ASSET_ARCHIVED' }))
  expect(getReferenceGraph(ctx, { assetId: b.id, depth: 1 }).nodes.every(n => n.archivedAt !== null)).toBe(true)
})
it('新增/移除后更新源资产失败时，关系和revision一起回滚', () => {
  const a = create(), b = create()
  ctx.write(s => s.run("CREATE TRIGGER fail_reference_revision BEFORE UPDATE OF revision ON asset BEGIN SELECT RAISE(ABORT,'forced'); END"))
  expect(() => addReference(ctx, request(a.id, b.id))).toThrow()
  expect(getReferences(ctx, { assetId: a.id }).references).toEqual([])
  expect(getAsset(ctx, a.id)).toEqual(a)
  ctx.write(s => { s.run('DROP TRIGGER fail_reference_revision'); s.run('INSERT INTO asset_reference VALUES(?,?,?)', a.id, b.id, '2026-01-01'); s.run("CREATE TRIGGER fail_reference_revision BEFORE UPDATE OF revision ON asset BEGIN SELECT RAISE(ABORT,'forced'); END") })
  expect(() => removeReference(ctx, request(a.id, b.id))).toThrow()
  expect(getReferences(ctx, { assetId: a.id }).references).toHaveLength(1)
  expect(getAsset(ctx, a.id)).toEqual(a)
})
it('删除资产双侧级联，其他资产和历史保留', () => {
  const a = create(), b = create(), c = create()
  addReference(ctx, request(a.id, b.id)); addReference(ctx, request(b.id, c.id))
  const preserved = getAsset(ctx, c.id)
  deleteAsset(ctx, b.id, 2, true)
  expect(getReferences(ctx, { assetId: a.id }).references).toEqual([])
  expect(getReferences(ctx, { assetId: c.id }).referencedBy).toEqual([])
  expect(getAsset(ctx, c.id)).toEqual(preserved)
})
it('链/环/正反向按深度稳定遍历，无悬空边或重复节点', () => {
  const [a, b, c, d] = ['A', 'B', 'C', 'D'].map(create)
  addReference(ctx, request(a.id, b.id)); addReference(ctx, request(b.id, c.id)); addReference(ctx, request(c.id, d.id)); addReference(ctx, request(c.id, a.id))
  const graph = getReferenceGraph(ctx, { assetId: a.id, depth: 1 })
  expect(graph).toMatchObject({ rootId: a.id, depth: 1, truncated: false })
  expect(graph.nodes.map(n => n.id)).toEqual([a.id, b.id, c.id])
  expect(graph.edges).toEqual([{ sourceAssetId: a.id, targetAssetId: b.id }, { sourceAssetId: c.id, targetAssetId: a.id }])
  const full = getReferenceGraph(ctx, { assetId: a.id, depth: 2 })
  expect(full.nodes.map(n => n.id)).toEqual([a.id, b.id, c.id, d.id])
  expect(full.edges).toHaveLength(4)
  expect(getReferenceGraph(ctx, { assetId: a.id })).toEqual(full)
  expect(new Set(full.nodes.map(n => n.id)).size).toBe(full.nodes.length)
})
function seed(count: number) {
  ctx.write(s => {
    for (let id = 1; id <= count; id++) s.run("INSERT INTO asset(id,code,name,category,storage_type,created_at,updated_at) VALUES(?,?,?,'inbox','inline_text','2026-01-01','2026-01-01')", id, `node-${id}`, `Node ${id}`)
  })
}
it('200节点边界：恰好上限不误报，超过上限确定性截断', () => {
  seed(201)
  ctx.write(s => { for (let id = 2; id <= 200; id++) s.run('INSERT INTO asset_reference VALUES(1,?,?)', id, 'now') })
  expect(getReferenceGraph(ctx, { assetId: 1, depth: 3 })).toMatchObject({ truncated: false, nodes: expect.any(Array) })
  ctx.write(s => s.run('INSERT INTO asset_reference VALUES(1,201,?)', 'now'))
  const graph = getReferenceGraph(ctx, { assetId: 1, depth: 3 })
  expect(graph.nodes).toHaveLength(200)
  expect(graph.truncated).toBe(true)
  expect(graph.nodes.map(n => n.id)).toEqual(Array.from({ length: 200 }, (_, i) => i + 1))
  expect(graph.edges.every(e => graph.nodes.some(n => n.id === e.sourceAssetId) && graph.nodes.some(n => n.id === e.targetAssetId))).toBe(true)
  expect(getReferenceGraph(ctx, { assetId: 1, depth: 3 })).toEqual(graph)
})
it('1000边边界：恰好上限不误报，超过预算稳定截断且不超预算', () => {
  seed(35)
  ctx.write(s => {
    let edges = 0
    for (let source = 1; source <= 35; source++) for (let target = 1; target <= 35; target++) {
      if (source !== target && edges++ < 1000) s.run('INSERT INTO asset_reference VALUES(?,?,?)', source, target, 'now')
    }
  })
  const exact = getReferenceGraph(ctx, { assetId: 1, depth: 3 })
  expect(exact.edges).toHaveLength(1000)
  expect(exact.truncated).toBe(false)
  ctx.write(s => s.run('INSERT INTO asset_reference VALUES(35,34,?)', 'now'))
  const graph = getReferenceGraph(ctx, { assetId: 1, depth: 3 })
  expect(graph.edges).toHaveLength(1000)
  expect(graph.truncated).toBe(true)
  expect(getReferenceGraph(ctx, { assetId: 1, depth: 3 })).toEqual(graph)
})
it('非法深度与未知读参数拒绝，空关系图仍含根', () => {
  const a = create()
  expect(getReferenceGraph(ctx, { assetId: a.id })).toMatchObject({ rootId: a.id, depth: 2, nodes: [{ id: a.id }], edges: [], truncated: false })
  for (const depth of [0, 4, '2', null, NaN]) expect(() => getReferenceGraph(ctx, { assetId: a.id, depth })).toThrow()
  expect(() => getReferences(ctx, { assetId: a.id, databasePath: '/x' })).toThrow()
  expect(() => getReferenceGraph(ctx, { assetId: a.id, unexpected: true })).toThrow()
})
it('旧epoch上下文不可读写关系', async () => {
  const a = create(), b = create()
  await manager.beforeSpaceSwitch()
  for (const operation of [addReference, removeReference]) expect(() => operation(ctx, request(a.id, b.id, 1))).toThrowError(expect.objectContaining({ code: 'SPACE_CHANGED' }))
  expect(() => getReferences(ctx, { assetId: a.id })).toThrowError(expect.objectContaining({ code: 'SPACE_CHANGED' }))
  expect(() => getReferenceGraph(ctx, { assetId: a.id })).toThrowError(expect.objectContaining({ code: 'SPACE_CHANGED' }))
})
it('另一空间资产不能作为本空间的目标，另一库保持不变', async () => {
  const a = create()
  const other = new AssetsStoreManager({ active: () => ({ id: 'B', path: join(root, 'B') }), epoch: () => 'B#1' }, (p, o) => new Database(p, o))
  try {
    const b = await other.getForRequest(other.context())
    b.write(s => s.run("INSERT INTO asset(id,code,name,category,storage_type,created_at,updated_at) VALUES(999,'other','Other','inbox','inline_text','now','now')"))
    expect(() => addReference(ctx, request(a.id, 999))).toThrowError(expect.objectContaining({ code: 'NOT_FOUND' }))
    await expect(manager.getForRequest(b.scope)).rejects.toMatchObject({ code: 'SPACE_CHANGED' })
    expect(getReferences(b, { assetId: 999 })).toEqual({ assetId: 999, revision: 1, references: [], referencedBy: [] })
    expect(getReferenceGraph(ctx, { assetId: a.id }).nodes.map(n => n.id)).toEqual([a.id])
  } finally { await other.close() }
})
