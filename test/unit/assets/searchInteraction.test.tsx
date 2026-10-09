// @vitest-environment jsdom
import { useState } from 'react'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { AssetFilters } from '../../../src/components/modules/assets/AssetFilters'
import { QuickUse } from '../../../src/components/modules/assets/QuickUse'
import { readSearchQuery } from '../../../electron/assets/searchQuery'
import type { AssetDetail, AssetListQuery, WorkspaceRequest } from '../../../shared/assetsContracts'

const scope = { workspaceId: 'synthetic', spaceEpoch: 'synthetic#1' }
const original: AssetDetail = { id: 1, code: 'old', name: '旧结果', category: 'inbox', categoryPath: ['收集箱'], description: '', storageType: 'inline_text', externalUrl: null, sourceJson: '{}', sourceTask: '', notes: '', kind: null, templateConfig: { version: 1, variables: {} }, currentVersionId: 1, currentVersion: 1, currentContent: '旧正文', isFavorite: 1, lastUsedAt: null, archivedAt: null, revision: 1, createdAt: 'now', updatedAt: 'now', versionCount: 1, tags: [], fileAvailable: false, currentFileName: null }
const current = { ...original, id: 2, code: 'new', name: '新结果', currentContent: '新正文' }
const page = (items: AssetDetail[]) => ({ ok: true, page: { items, total: items.length, page: 1, pageSize: 20 } })
let fetchPage: (request: AssetListQuery) => Promise<ReturnType<typeof page>>
beforeEach(() => {
  localStorage.clear()
  fetchPage = async request => { readSearchQuery(request); return page(request.q ? [current] : [original]) }
  Object.defineProperty(window, 'electronAPI', { configurable: true, value: { assets: {
    list: ({ workspaceId: _id, spaceEpoch: _epoch, ...request }: AssetListQuery & WorkspaceRequest) => fetchPage(request),
    get: async ({ assetId }: { assetId: number }) => ({ ok: true, asset: assetId === 1 ? original : current })
  } } })
})
afterEach(cleanup)
function Filters() {
  const [query, setQuery] = useState<AssetListQuery>({})
  const [failure, setFailure] = useState('')
  return <><AssetFilters query={query} tags={[]} disabled={false} onChange={async patch => {
    try { readSearchQuery({ ...query, ...patch }); setQuery(q => ({ ...q, ...patch })); setFailure('') }
    catch { setFailure('后端拒绝了检索输入') }
  }} /><output aria-label="提交的检索">{query.q ?? ''}</output>{failure && <p>{failure}</p>}</>
}
async function quick() {
  render(<QuickUse scope={scope} write={fn => fn(scope)} onChanged={() => {}} onClose={() => {}} />)
  await screen.findByRole('button', { name: /旧结果 ·/ })
  return screen.getByLabelText('快速检索')
}
it('主搜索阻止201字符提交并保留输入，缩短至200字符后可提交', async () => {
  render(<Filters />)
  const input = screen.getByLabelText('检索资产')
  fireEvent.change(input, { target: { value: 'a'.repeat(201) } })
  fireEvent.keyDown(input, { key: 'Enter' })
  expect(screen.getByRole('alert').textContent).toContain('200')
  expect((input as HTMLInputElement).value).toBe('a'.repeat(201))
  expect(screen.getByLabelText('提交的检索').textContent).toBe('')
  expect(screen.queryByText('后端拒绝了检索输入')).toBeNull()
  fireEvent.change(input, { target: { value: 'a'.repeat(200) } })
  fireEvent.keyDown(input, { key: 'Enter' })
  await waitFor(() => expect(screen.getByLabelText('提交的检索').textContent).toBe('a'.repeat(200)))
  expect(screen.queryByRole('alert')).toBeNull()
})
it('主搜索按Unicode码点接受200个emoji而非截断到100个', async () => {
  render(<Filters />)
  const input = screen.getByLabelText('检索资产') as HTMLInputElement
  expect(input.hasAttribute('maxlength')).toBe(false)
  fireEvent.change(input, { target: { value: '😀'.repeat(200) } })
  fireEvent.keyDown(input, { key: 'Enter' })
  await waitFor(() => expect(screen.getByLabelText('提交的检索').textContent).toBe('😀'.repeat(200)))
})
it('新关键词后立即Enter等待新结果，绝不打开旧列表详情', async () => {
  const input = await quick()
  let finish!: (value: ReturnType<typeof page>) => void
  fetchPage = request => request.q === '新' ? new Promise(resolve => { finish = resolve }) : Promise.resolve(page([original]))
  fireEvent.change(input, { target: { value: '新' } })
  fireEvent.keyDown(input, { key: 'Enter' })
  await waitFor(() => expect(finish).toBeTypeOf('function'))
  expect(screen.queryByLabelText('快速取用详情')).toBeNull()
  await act(async () => finish(page([current])))
  await screen.findByRole('heading', { name: '新结果' })
  expect(screen.getByText('新正文')).toBeTruthy()
  expect(screen.queryByText('旧正文')).toBeNull()
})
it('新检索失败后按Enter不能打开残留旧结果', async () => {
  const input = await quick()
  fetchPage = async () => { throw new Error('合成查询失败') }
  fireEvent.change(input, { target: { value: '新' } })
  fireEvent.keyDown(input, { key: 'Enter' })
  await screen.findByText('合成查询失败')
  fireEvent.keyDown(input, { key: 'Enter' })
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)) })
  expect(screen.queryByLabelText('快速取用详情')).toBeNull()
})
it('等待自动打开期间继续输入，旧结果返回不得自动进入详情', async () => {
  const input = await quick()
  let finish!: (value: ReturnType<typeof page>) => void
  fetchPage = request => request.q === '新' ? new Promise(resolve => { finish = resolve }) : Promise.resolve(page([current]))
  fireEvent.change(input, { target: { value: '新' } })
  fireEvent.keyDown(input, { key: 'Enter' })
  await waitFor(() => expect(finish).toBeTypeOf('function'))
  fireEvent.change(input, { target: { value: '另一个' } })
  await act(async () => finish(page([current])))
  expect(screen.queryByLabelText('快速取用详情')).toBeNull()
  fireEvent.keyDown(input, { key: 'Enter' })
  await screen.findByRole('heading', { name: '新结果' })
})
it('快速检索超限提示且不打开旧资产，200个emoji仍可检索', async () => {
  const input = await quick() as HTMLInputElement
  fireEvent.change(input, { target: { value: 'a'.repeat(201) } })
  fireEvent.keyDown(input, { key: 'Enter' })
  expect(screen.getByRole('alert').textContent).toContain('200')
  expect(screen.queryByLabelText('快速取用详情')).toBeNull()
  expect(input.hasAttribute('maxlength')).toBe(false)
  fireEvent.change(input, { target: { value: '😀'.repeat(200) } })
  fireEvent.keyDown(input, { key: 'Enter' })
  await screen.findByRole('heading', { name: '新结果' })
})

it('等待Enter结果期间切换范围再返回，不沿用上次自动打开意图', async () => {
  const input = await quick()
  let finish!: (value: ReturnType<typeof page>) => void
  fetchPage = request => request.view === 'favorites' && request.q === '新'
    ? new Promise(resolve => { finish = resolve }) : Promise.resolve(page([current]))
  fireEvent.change(input, { target: { value: '新' } })
  fireEvent.keyDown(input, { key: 'Enter' })
  await waitFor(() => expect(finish).toBeTypeOf('function'))
  fireEvent.click(screen.getByRole('button', { name: '全部', exact: true }))
  await waitFor(() => expect(screen.getByRole('button', { name: /新结果 ·/ }).hasAttribute('disabled')).toBe(false))
  const earlier = finish
  fireEvent.click(screen.getByRole('button', { name: '收藏', exact: true }))
  await waitFor(() => expect(finish).not.toBe(earlier))
  await act(async () => finish(page([current])))
  expect(screen.queryByLabelText('快速取用详情')).toBeNull()
})

it('详情请求未返回时开始输入法，不显示先前请求的资产正文', async () => {
  const input = await quick()
  let finish!: (value: { ok: true; asset: AssetDetail }) => void
  window.electronAPI!.assets.get = () => new Promise(resolve => { finish = resolve })
  fireEvent.keyDown(input, { key: 'Enter' })
  await waitFor(() => expect(finish).toBeTypeOf('function'))
  fireEvent.compositionStart(input)
  await act(async () => finish({ ok: true, asset: original }))
  expect(screen.queryByLabelText('快速取用详情')).toBeNull()
  fireEvent.compositionEnd(input)
  expect(screen.queryByText('旧正文')).toBeNull()
})

it('切回曾成功的范围但本次请求失败，Enter仍不能打开残留结果', async () => {
  const input = await quick()
  fetchPage = async () => { throw new Error('合成范围查询失败') }
  fireEvent.click(screen.getByRole('button', { name: '全部', exact: true }))
  await screen.findByText('合成范围查询失败')
  fireEvent.click(screen.getByRole('button', { name: '收藏', exact: true }))
  await screen.findByText('合成范围查询失败')
  fireEvent.keyDown(input, { key: 'Enter' })
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)) })
  expect(screen.queryByLabelText('快速取用详情')).toBeNull()
  expect(screen.getByRole('button', { name: /旧结果 ·/ }).hasAttribute('disabled')).toBe(true)
})
