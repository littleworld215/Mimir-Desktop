import { expect, it, vi } from 'vitest'
import { generateMeetingDeck } from '../../electron/meetings/service'
import * as deck from '../../electron/meetings/deck'
import { setStoreValue } from '../../electron/library/store'
it('新组会材料排除已回收文献，仍可生成合成演示', async () => {
  const paper = { arxivId: 'trash', title: '已回收原文', authors: [], summary: '', url: '', notes: '保留笔记', tags: [], projectIds: [], addedAt: '2024-01-01', removedAt: '2026-10-22T00:00:00Z' }
  setStoreValue('library:papers', { trash: paper })
  const spy = vi.spyOn(deck, 'buildDeckModel')
  try {
    await generateMeetingDeck({ title: '合成组会', paperIds: ['trash'], experimentIds: [], enhance: false })
    expect(spy.mock.calls[0]?.[0].papers).toEqual([])
  } finally { spy.mockRestore() }
})
