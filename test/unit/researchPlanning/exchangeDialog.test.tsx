// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { PlanningExchange } from '../../../src/components/modules/planning/PlanningExchange'

afterEach(cleanup)
it('导入必须先选择、映射和预览；改变策略取消旧确认，失败保留选择', async () => {
  const scope = { workspaceId: 's', spaceEpoch: 'e' }, applyImport = vi.fn().mockResolvedValue({ ok: false, message: '计划已变化，请重新预览', code: 'CONFLICT' })
  const previewImport = vi.fn().mockResolvedValue({ ok: true, scope, revision: 0, previewToken: 'preview', counts: { added: 1, updated: 0, skipped: 1, copied: 0 }, totalAfter: 2, duplicates: [{ id: 'record', before: { title: '原始条目', kind: 'generic', deleted: false, archived: false }, incoming: { title: '导入条目', kind: 'generic', deleted: false, archived: false }, bodyChanged: true }] })
  window.electronAPI = { researchPlanning: {
    selectImport: vi.fn().mockResolvedValue({ ok: true, canceled: false, selection: { importId: 'import', fileName: 'synthetic.json', format: 'Research-Workbench JSON v2', itemCount: 2, bytes: 100, sha256: 'sha', collections: [{ id: 'external', name: '外部分组', count: 2 }], warnings: ['外部设置不会生效'] } }),
    previewImport, applyImport, importDifference: vi.fn().mockResolvedValue({ ok: true, before: { title: '原始条目', content: '\n旧原文\n' }, incoming: { title: '导入条目', content: '\n新原文\n' } })
  } } as unknown as typeof window.electronAPI
  render(<PlanningExchange scope={scope} revision={0} collections={[{ id: 'default', name: '当前分组', order: 0, deleted: false }]} onClose={vi.fn()} onApplied={vi.fn()} />)
  fireEvent.click(screen.getByRole('button', { name: '选择JSON并读取预览信息' }))
  expect(await screen.findByText('synthetic.json')).toBeTruthy()
  expect(screen.queryByRole('button', { name: '确认按预览导入' })).toBeNull()
  fireEvent.change(screen.getByLabelText('映射分组外部分组'), { target: { value: 'default' } })
  fireEvent.click(screen.getByRole('button', { name: '预览导入差异' }))
  await screen.findByRole('button', { name: '确认按预览导入' })
  expect(previewImport.mock.calls[0]![0]).toMatchObject({ scope, expectedRevision: 0, options: { strategy: 'skip', collections: { external: 'default' } } })
  fireEvent.click(screen.getByRole('button', { name: '查看完整差异导入条目' }))
  const before = await screen.findByLabelText('当前记录完整字段')
  expect(JSON.parse((before as HTMLTextAreaElement).value).content).toBe('\n旧原文\n')
  expect(JSON.parse((screen.getByLabelText('导入记录完整字段') as HTMLTextAreaElement).value).content).toBe('\n新原文\n')
  fireEvent.change(screen.getByLabelText('重复项策略'), { target: { value: 'copy' } })
  expect(screen.queryByRole('button', { name: '确认按预览导入' })).toBeNull()
  fireEvent.click(screen.getByRole('button', { name: '预览导入差异' }))
  fireEvent.click(await screen.findByRole('button', { name: '确认按预览导入' }))
  await waitFor(() => expect(applyImport).toHaveBeenCalledOnce())
  expect(await screen.findByRole('alert')).toHaveProperty('textContent', '计划已变化，请重新预览')
  expect(screen.getByText('synthetic.json')).toBeTruthy()
})
