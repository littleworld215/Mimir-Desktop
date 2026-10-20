// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { PlanningManager } from '../../../src/components/modules/planning/PlanningManager'
import { emptyPlanningDocument } from '../../../shared/researchPlanningDefaults'

afterEach(cleanup)
it('删除分组须选目标并先预览，取消不执行真实迁移', async () => {
  const defaults = emptyPlanningDocument(), execute = vi.fn().mockResolvedValue({ affectedCount: 7 })
  render(<PlanningManager collections={[...defaults.collections, { id: 'topic', name: '课题', order: 1, deleted: false }]} types={defaults.types} busy={false} execute={execute} onClose={vi.fn()} />)
  fireEvent.click(screen.getByRole('button', { name: '删除课题' }))
  expect(screen.getByRole('button', { name: '确认迁移并删除' })).toHaveProperty('disabled', true)
  fireEvent.change(screen.getByLabelText('迁移目标'), { target: { value: 'default' } })
  fireEvent.click(screen.getByRole('button', { name: '预览删除影响' }))
  expect(await screen.findByRole('status')).toHaveProperty('textContent', '将迁移 7 条记录，正文与状态保留；尚未执行。')
  expect(execute).toHaveBeenCalledWith({ kind: 'collection', id: 'topic', name: '课题', deleted: true, moveTo: 'default' }, true)
  fireEvent.click(screen.getByRole('button', { name: '取消删除' }))
  expect(execute).toHaveBeenCalledTimes(1)
})
