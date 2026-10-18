// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { ReferenceRefreshDialog } from '../../../src/components/modules/library/research/ReferenceRefreshDialog'
import * as apiModule from '../../../src/lib/libraryResearchApi'
import type { ResearchApi, ResearchResolvedItem } from '../../../shared/libraryResearchContracts'
import { version } from '../libraryEvidence/fixtures'
import { uiFixtures, uiScope, uiState } from './uiFixtures'
afterEach(() => { cleanup(); vi.restoreAllMocks() })
it('先明确选择再完整预览，确认仅更新已选引用', async () => {
  const { packReply } = uiFixtures(), item = packReply.pack.versions[0]!.items[0]!, quote = '完整旧版' + '😀'.repeat(400)
  const resolved = { item, evidence: { ...version(), quote } } as ResearchResolvedItem
  const previewRefresh = vi.fn().mockResolvedValue({ ok: true, ...uiState, packId: packReply.pack.id, packVersion: 1, previewToken: 'a'.repeat(64), changes: [{ itemId: item.id, eligible: true, before: resolved, after: { ...resolved, evidence: { ...version(), quote: '完整新版' } } }] })
  const applyRefresh = vi.fn().mockResolvedValue({ ok: true, ...packReply })
  vi.spyOn(apiModule, 'libraryResearchApi').mockReturnValue({ previewRefresh, applyRefresh } as unknown as ResearchApi)
  render(<ReferenceRefreshDialog scope={uiScope} packId={packReply.pack.id} revision={3} evidenceRevision={1} items={[resolved]} onApplied={() => {}} onClose={() => {}} />)
  expect(previewRefresh).not.toHaveBeenCalled()
  fireEvent.click(screen.getByLabelText(`选择更新 ${item.id}`))
  fireEvent.click(screen.getByRole('button', { name: '预览所选差异' }))
  await screen.findByText(quote)
  expect(applyRefresh).not.toHaveBeenCalled()
  fireEvent.click(screen.getByRole('button', { name: '确认更新所选引用' }))
  await waitFor(() => expect(applyRefresh).toHaveBeenCalledOnce())
  expect(applyRefresh.mock.calls[0]![0]).toMatchObject({ itemIds: [item.id], previewToken: 'a'.repeat(64) })
})
