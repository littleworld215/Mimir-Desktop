import { afterEach, expect, it } from 'vitest'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { createEvidenceRuntime } from '../../../electron/library/evidence/runtime'
import { WorkspaceOperationGate } from '../../../electron/workspaceBackup/operationGate'
import { installWorkspaceIpcGate } from '../../../electron/workspaceBackup/ipcGate'
import { createEvidenceSourceService } from '../../../electron/library/evidence/source'
import { createEvidence, type EvidenceContext } from '../../../electron/library/evidence/service'
import { paperPdfFileName } from '../../../electron/library/arxiv'
import { fields, fixture } from './fixtures'
const fixtures: ReturnType<typeof fixture>[] = []
afterEach(() => fixtures.splice(0).forEach(f => f.clean()))
it('维护停止在外层闸门拒绝时，证据桥仍返回稳定失败；其它域原契约保留', async () => {
  const f = fixture(); fixtures.push(f)
  const gate = new WorkspaceOperationGate(), handlers = new Map<string, (...args: unknown[]) => any>()
  const ipc = { handle: (channel: string, fn: (...args: unknown[]) => any) => { handlers.set(channel, fn) } }
  installWorkspaceIpcGate(ipc, gate, () => f.ctx.scope)
  ipc.handle('libraryEvidence:list', () => { throw Error('不应执行') })
  ipc.handle('library:listPapers', () => ({}))
  gate.stopAccepting()
  expect(await handlers.get('libraryEvidence:list')!()).toMatchObject({ ok: false, code: 'MAINTENANCE_BLOCKED' })
  await expect(handlers.get('library:listPapers')!()).rejects.toThrow()
})
it('停止传播取消，但忽略取消的实际读取结束前pending不归零；失败不授予维护交接', async () => {
  const f = fixture(); fixtures.push(f)
  const gate = new WorkspaceOperationGate()
  const runtime = createEvidenceRuntime({ gate, capture: () => f.ctx.scope, catalog: f.ctx.catalog })
  let release!: () => void, entered!: () => void, canceled = false, stopped = false
  const held = new Promise<void>(resolve => { release = resolve })
  const started = new Promise<void>(resolve => { entered = resolve })
  const pending = runtime.run(async ctx => {
    ctx.signal.addEventListener('abort', () => { canceled = true })
    entered(); await held
    ctx.assertCurrent()
  })
  const outcome = pending.then(() => undefined, error => error)
  await started
  const stop = runtime.stop().then(() => { stopped = true; return undefined }, error => error)
  try {
    expect(canceled).toBe(true)
    expect(gate.pendingCount).toBeGreaterThan(0)
    expect(stopped).toBe(false)
    await expect(runtime.run(async () => {})).rejects.toThrow()
  } finally { release(); await Promise.allSettled([pending, stop]) }
  expect(String(await outcome)).toMatch(/CANCELED/)
  expect(await stop).toBeInstanceOf(Error)
  expect(gate.pendingCount).toBe(0)
  expect(stopped).toBe(false)
})
it('接受时固定root，异步后旧scope不能保存；父租约内嵌套不逃逸', async () => {
  const f = fixture(); fixtures.push(f)
  const gate = new WorkspaceOperationGate()
  let selected = { ...f.ctx.scope }
  const runtime = createEvidenceRuntime({ gate, capture: () => selected, catalog: f.ctx.catalog })
  await expect(gate.run(f.ctx.scope, () => runtime.run(async ctx => {
    expect(ctx.scope).toEqual(f.ctx.scope)
    selected = { ...selected, epoch: 'new', root: 'other' }
    await Promise.resolve(); ctx.assertCurrent()
  }))).rejects.toThrow(/SPACE_CHANGED/)
  expect(gate.pendingCount).toBe(0)
})
it('真实PDF摘要暂停时停止，不提前释放实际文件任务且不发布绑定', async () => {
  const f = fixture(); fixtures.push(f)
  const gate = new WorkspaceOperationGate(), path = join(f.root, 'papers', paperPdfFileName(fields().paperId))
  mkdirSync(join(f.root, 'papers')); writeFileSync(path, Buffer.concat([Buffer.from('%PDF-1.4\n'), Buffer.alloc(128 * 1024, 65)]))
  const ctx: EvidenceContext = { ...f.ctx, catalog: { ...f.ctx.catalog, papers: () => [{ ...f.ctx.catalog.papers()[0]!, pdfPath: path }] } }
  const created = createEvidence(ctx, fields(), 0), before = readFileSync(join(f.root, '.mimir/library/evidence.json'))
  let release!: () => void, entered!: () => void
  const held = new Promise<void>(resolve => { release = resolve }), started = new Promise<void>(resolve => { entered = resolve })
  const source = createEvidenceSourceService({ afterChunk: async () => { entered(); await held } })
  const runtime = createEvidenceRuntime({ gate, capture: () => f.ctx.scope, catalog: ctx.catalog, source })
  const pending = runtime.run(current => source.confirmEvidenceSource(current, created.card.id, 1))
  const outcome = pending.then(() => undefined, error => error)
  await started
  const stopping = runtime.stop().then(() => undefined, error => error)
  try { expect(gate.pendingCount).toBe(1) }
  finally { release(); await Promise.allSettled([pending, stopping]) }
  expect(String(await outcome)).toMatch(/CANCELED/)
  expect(await stopping).toBeInstanceOf(Error)
  expect(readFileSync(join(f.root, '.mimir/library/evidence.json'))).toEqual(before)
  expect(gate.pendingCount).toBe(0)
})
