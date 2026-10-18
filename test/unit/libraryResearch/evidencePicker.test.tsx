// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { EvidencePicker } from '../../../src/components/modules/library/research/EvidencePicker'
import * as apiModule from '../../../src/lib/libraryResearchApi'
import type { ResearchApi } from '../../../shared/libraryResearchContracts'
import { requestEvidenceLeave } from '../../../src/lib/evidenceEditGuard'
import { uiScope, uiState } from './uiFixtures'
afterEach(() => { cleanup(); vi.restoreAllMocks() })
it('选择跨页保留，未应用时阻止全局离开，应用传回完整集合与证据revision', async () => {
  const row = (id: string) => ({ cardId: id, version: 1, paperTitle: `文献${id}`, question: '问题', quote: '摘录', relation: 'unassessed', reviewState: 'draft', sourceStatus: 'unbound', problems: [] })
  const listEvidence = vi.fn().mockImplementation(async (r: { page: number }) => ({ ok: true, ...uiState, total: 51, page: r.page, pageSize: 50, items: r.page === 1 ? [row('card-a')] : [row('card-b')] }))
  vi.spyOn(apiModule, 'libraryResearchApi').mockReturnValue({ listEvidence } as unknown as ResearchApi)
  const apply = vi.fn()
  render(<EvidencePicker scope={uiScope} projectId="project-1" initialIds={[]} onApply={apply} onClose={() => {}} />)
  await screen.findByLabelText('选择证据 card-a'); fireEvent.click(screen.getByLabelText('选择证据 card-a'))
  expect(await requestEvidenceLeave('discard')).toBe(false)
  fireEvent.click(screen.getByRole('button', { name: '下一页' }))
  await screen.findByLabelText('选择证据 card-b'); fireEvent.click(screen.getByLabelText('选择证据 card-b'))
  fireEvent.click(screen.getByRole('button', { name: '应用选择' }))
  await waitFor(() => expect(apply).toHaveBeenCalledWith(['card-a', 'card-b'], 1))
})
