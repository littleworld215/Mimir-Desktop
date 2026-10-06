import { test, expect } from '@playwright/test'
import { launchApp } from '../fixtures/launch'
import { gotoModule } from '../helpers/nav'

test('real Electron IPC: current full/short search, scopes, filters, safe excerpts and old list contract', async () => {
  const launched = await launchApp()
  try {
    await gotoModule(launched.page, 'assets')
    const results = await launched.page.evaluate(async () => {
      const api = window.electronAPI!.assets
      const scoped = await api.context()
      if (!scoped.ok) throw new Error(scoped.message)
      const scope = scoped.context
      const made = await api.create({ ...scope, input: { name: '隔离科研资产', category: 'inbox', storageType: 'inline_text', content: '😀'.repeat(200) + '<script>scientific</script>', sourceTask: 'source-token', tagNames: ['organization-token'] } })
      if (!made.ok) throw new Error(made.message)
      const asset = made.asset
      const long = await api.list({ ...scope, q: 'scientific', searchIn: 'body', ids: [asset.id] })
      const short = await api.list({ ...scope, q: '科研' })
      const organization = await api.list({ ...scope, q: 'organization-token', searchIn: 'organization' })
      const excluded = await api.list({ ...scope, q: 'scientific', excludeTagIds: asset.tags.map(t => t.id) })
      const invalid = await api.list({ ...scope, updatedAfter: '2026-02-29' })
      const updated = await api.update({ ...scope, assetId: asset.id, expectedRevision: asset.revision, expectedCurrentVersionId: asset.currentVersionId, patch: { content: '新正文' } })
      const historical = await api.list({ ...scope, q: 'scientific' })
      const legacy = await api.list(scope)
      return { id: asset.id, long, short, organization, excluded, invalid, updated, historical, legacy }
    })
    for (const result of [results.long, results.short, results.organization]) {
      expect(result).toMatchObject({ ok: true, page: { total: 1, items: [{ id: results.id }] } })
    }
    if (!results.long.ok) throw new Error(results.long.message)
    const excerpt = results.long.page.items[0].excerpt!
    expect(excerpt.text).toContain('<script>scientific</script>')
    expect([...excerpt.text].length).toBeLessThanOrEqual(180)
    expect(excerpt.matches.map(m => excerpt.text.slice(m.start, m.end))).toEqual(['scientific'])
    expect(results.excluded).toMatchObject({ ok: true, page: { total: 0 } })
    expect(results.invalid).toMatchObject({ ok: false, code: 'BAD_REQUEST' })
    expect(results.updated.ok).toBe(true)
    expect(results.historical).toMatchObject({ ok: true, page: { total: 0 } })
    expect(results.legacy).toMatchObject({ ok: true, page: { total: 1 } })
  } finally { await launched.cleanup() }
})
