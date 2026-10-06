import { test, expect } from '@playwright/test'
import { launchApp } from '../fixtures/launch'
import { gotoModule } from '../helpers/nav'

test('real Electron references IPC: conditions, bidirectional graph, archive, cascade and scope', async () => {
  const launched = await launchApp()
  try {
    await gotoModule(launched.page, 'assets')
    const results = await launched.page.evaluate(async () => {
      const api = window.electronAPI!.assets
      const context = await api.context()
      if (!context.ok) throw new Error(context.message)
      const scope = context.context
      const created = await Promise.all(['A', 'B', 'C'].map(name => api.create({ ...scope, input: { name, category: 'inbox', storageType: 'inline_text', content: `  ${name}\n\n` } })))
      const [a, b, c] = created.map(result => { if (!result.ok) throw new Error(result.message); return result.asset })
      const first = await api.addReference({ ...scope, sourceAssetId: a.id, targetAssetId: b.id, expectedRevision: 1 })
      const duplicate = await api.addReference({ ...scope, sourceAssetId: a.id, targetAssetId: b.id, expectedRevision: 2 })
      const stale = await api.removeReference({ ...scope, sourceAssetId: a.id, targetAssetId: b.id, expectedRevision: 1 })
      await api.addReference({ ...scope, sourceAssetId: b.id, targetAssetId: c.id, expectedRevision: 1 })
      await api.addReference({ ...scope, sourceAssetId: c.id, targetAssetId: a.id, expectedRevision: 1 })
      const forward = await api.references({ ...scope, assetId: a.id })
      const graph = await api.referenceGraph({ ...scope, assetId: a.id, depth: 3 })
      const self = await api.addReference({ ...scope, sourceAssetId: a.id, targetAssetId: a.id, expectedRevision: 2 })
      const wrongScope = await api.referenceGraph({ ...scope, workspaceId: 'foreign', assetId: a.id })
      const archived = await api.archive({ ...scope, assetId: a.id, expectedRevision: 2 })
      const archivedWrite = await api.removeReference({ ...scope, sourceAssetId: a.id, targetAssetId: b.id, expectedRevision: 3 })
      const unchangedHistory = await api.listVersions({ ...scope, assetId: a.id })
      const removed = await api.delete({ ...scope, assetId: b.id, expectedRevision: 2, confirm: true })
      const after = await api.references({ ...scope, assetId: a.id })
      const cAfter = await api.get({ ...scope, assetId: c.id })
      return { ids: [a.id, b.id, c.id], first, duplicate, stale, forward, graph, self, wrongScope, archived, archivedWrite, unchangedHistory, removed, after, cAfter }
    })
    expect(results.first).toEqual({ ok: true, changed: true, revision: 2 })
    expect(results.duplicate).toEqual({ ok: true, changed: false, revision: 2 })
    expect(results.stale).toMatchObject({ ok: false, code: 'REVISION_CONFLICT', details: { currentRevision: 2 } })
    expect(results.forward).toMatchObject({ ok: true, references: { references: [{ id: results.ids[1] }], referencedBy: [{ id: results.ids[2] }] } })
    expect(results.graph).toMatchObject({ ok: true, graph: { nodes: [{ id: results.ids[0] }, { id: results.ids[1] }, { id: results.ids[2] }], edges: expect.any(Array), truncated: false } })
    if (!results.graph.ok) throw new Error(results.graph.message)
    expect(results.graph.graph.edges).toHaveLength(3)
    expect(results.self).toMatchObject({ ok: false, code: 'BAD_REQUEST' })
    expect(results.wrongScope).toMatchObject({ ok: false, code: 'SPACE_CHANGED' })
    expect(results.archived.ok).toBe(true)
    expect(results.archivedWrite).toMatchObject({ ok: false, code: 'ASSET_ARCHIVED' })
    expect(results.unchangedHistory).toMatchObject({ ok: true, page: { total: 1 } })
    expect(results.removed.ok).toBe(true)
    expect(results.after).toMatchObject({ ok: true, references: { references: [], referencedBy: [{ id: results.ids[2] }] } })
    expect(results.cAfter).toMatchObject({ ok: true, asset: { revision: 2, currentContent: '  C\n\n' } })
  } finally { await launched.cleanup() }
})
