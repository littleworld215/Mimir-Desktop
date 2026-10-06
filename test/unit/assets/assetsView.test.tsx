// @vitest-environment jsdom
import { afterEach, beforeEach, it, expect, vi } from 'vitest'
import { cleanup, render, screen, fireEvent, waitFor } from '@testing-library/react'
import type { AssetDetail } from '../../../shared/assetsContracts'
import { Assets } from '../../../src/components/modules/assets/Assets'
import { AssetEditor } from '../../../src/components/modules/assets/AssetEditor'
import { VersionCompare } from '../../../src/components/modules/assets/VersionCompare'
import { TagManager } from '../../../src/components/modules/assets/TagManager'
import { CategoryTree } from '../../../src/components/modules/assets/CategoryTree'
const detail: AssetDetail = { id: 1, code: 'text', name: 'Original', category: 'inbox', categoryPath: ['收集箱'], description: '', storageType: 'inline_text', externalUrl: null, sourceJson: '{}', sourceTask: '', notes: '', kind: null, templateConfig: { version: 1, variables: {} }, currentVersionId: 2, currentVersion: 1, currentContent: 'original\n', isFavorite: 0, lastUsedAt: null, archivedAt: null, revision: 1, createdAt: 'now', updatedAt: 'now', versionCount: 1, tags: [], fileAvailable: false, currentFileName: null }
const categories = [{ code: 'inbox', name: '收集箱', icon: null, defaultStorageType: null, description: '', builtin: true, parentCode: null, sortOrder: 0, revision: 1, createdAt: 'now', assetCount: 1 }]
let api: Record<string, ReturnType<typeof vi.fn>>
beforeEach(() => { api = { context: vi.fn().mockResolvedValue({ ok: true, context: { workspaceId: 'A', spaceEpoch: 'A#1' } }), list: vi.fn().mockResolvedValue({ ok: true, page: { items: [detail], total: 1, page: 1, pageSize: 30 } }), listCategories: vi.fn().mockResolvedValue({ ok: true, categories }), listTags: vi.fn().mockResolvedValue({ ok: true, tags: [] }), get: vi.fn().mockResolvedValue({ ok: true, asset: detail }), references: vi.fn().mockResolvedValue({ ok: true, references: { assetId: 1, revision: 1, references: [], referencedBy: [] } }), update: vi.fn().mockResolvedValue({ ok: false, code: 'REVISION_CONFLICT', message: '资产已改变' }) }; Object.defineProperty(window, 'electronAPI', { configurable: true, value: { assets: api } }) })
afterEach(cleanup)
it('分类按数值排序，负数和不同深度不会打乱父子树', () => {
  const categories = [
    { code: 'a', name: 'A', sortOrder: -11, parentCode: null },
    { code: 'b', name: 'B', sortOrder: -12, parentCode: null },
    { code: 'c', name: 'C', sortOrder: 500, parentCode: 'b' }
  ].map(c => ({ ...c, icon: null, description: '', defaultStorageType: null, builtin: false, revision: 1, createdAt: 'now' }))
  render(<CategoryTree categories={categories} disabled={false} onSelect={() => {}} onEdit={() => {}} />)
  expect(screen.getAllByRole('button').filter(button => button.hasAttribute('aria-pressed')).map(button => button.textContent)).toEqual(['B 0', 'C 0', 'A 0'])
})
it('切换标签后迟到的治理预览不显示，也不能用于删除新标签', async () => {
  let finish!: (value: unknown) => void
  api.tagImpact = vi.fn(() => new Promise(resolve => { finish = resolve }))
  const tags = [1, 2].map(id => ({ id, name: `标签${id}`, color: null, revision: 1, createdAt: 'now' }))
  render(<TagManager tags={tags} scope={{ workspaceId: 'A', spaceEpoch: 'A#1' }} write={operation => operation({ workspaceId: 'A', spaceEpoch: 'A#1' })} onChanged={() => {}} onClose={() => {}} />)
  fireEvent.click(screen.getByRole('button', { name: '标签1', exact: true }))
  await screen.findByLabelText('标签新名称')
  fireEvent.click(screen.getByRole('button', { name: '读取治理影响' }))
  fireEvent.click(screen.getByRole('button', { name: '标签2', exact: true }))
  await waitFor(() => expect((screen.getByLabelText('标签新名称') as HTMLInputElement).value).toBe('标签2'))
  finish({ ok: true, impact: { tagId: 1, assetCount: 123 } })
  await waitFor(() => expect(api.tagImpact).toHaveBeenCalledTimes(1))
  await new Promise(resolve => setTimeout(resolve, 0))
  expect(screen.queryByText(/影响 123/)).toBeNull()
  expect(screen.queryByRole('button', { name: '删除标签' })).toBeNull()
})
it('真实列表→详情→编辑失败保留正文和名称，原文可清空', async () => {
  render(<Assets />)
  fireEvent.click(await screen.findByRole('button', { name: /Original/ }))
  fireEvent.click(await screen.findByRole('button', { name: '编辑资产' }))
  fireEvent.change(await screen.findByLabelText('名称'), { target: { value: 'Draft' } })
  fireEvent.change(screen.getByLabelText('正文'), { target: { value: '' } })
  fireEvent.click(screen.getByRole('button', { name: '保存', exact: true }))
  await screen.findByRole('alert')
  expect((screen.getByLabelText('名称') as HTMLInputElement).value).toBe('Draft')
  expect((screen.getByLabelText('正文') as HTMLTextAreaElement).value).toBe('')
  expect(api.update).toHaveBeenCalledWith(expect.objectContaining({ assetId: 1, expectedRevision: 1, expectedCurrentVersionId: 2, patch: expect.objectContaining({ content: '', name: 'Draft' }) }))
})
it('长文本originals展示完整两侧，不把空lines当无差异；HTML只是文本', () => {
  const before = '<script>bad()</script>\r\n', after = ' x \n'
  render(<VersionCompare diff={{ kind: 'text', fromVersion: 1, toVersion: 2, mode: 'originals', lines: [], beforeText: before, afterText: after }} />)
  expect((screen.getByLabelText('旧版完整原文') as HTMLTextAreaElement).value).toBe(before.replace(/\r\n/g, '\n'))
  expect((screen.getByLabelText('新版完整原文') as HTMLTextAreaElement).value).toBe(after)
  expect(document.querySelector('script')).toBeNull()
})
it('保存中的重复点击只写一次，失败输入仍可修订', async () => {
  let reject!: (reason: Error) => void
  const save = vi.fn(() => new Promise<void>((_, r) => { reject = r }))
  render(<AssetEditor asset={detail} categories={categories} onSave={save} onClose={() => {}} />)
  fireEvent.change(screen.getByLabelText('名称'), { target: { value: 'Draft' } })
  const button = screen.getByRole('button', { name: '保存', exact: true })
  fireEvent.click(button); fireEvent.click(button)
  expect(save).toHaveBeenCalledTimes(1)
  reject(new Error('failed'))
  await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('failed'))
  expect((screen.getByLabelText('名称') as HTMLInputElement).disabled).toBe(false)
})
