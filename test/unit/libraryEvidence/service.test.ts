import { afterEach, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { archiveEvidence, createEvidence, updateEvidence } from '../../../electron/library/evidence/service'
import { fields, fixture } from './fixtures'
const fixtures: ReturnType<typeof fixture>[] = []
const setup = () => { const f = fixture(); fixtures.push(f); return f }
afterEach(() => fixtures.splice(0).forEach(f => f.clean()))

it('快照由主进程目录生成；修订只增，no-op不产生历史', () => {
  const { ctx } = setup()
  const created = createEvidence(ctx, fields(), 0)
  expect(created.card.versions[0]).toMatchObject({ quote: fields().quote, paperSnapshot: { title: '文献' }, reviewState: 'draft' })
  const same = updateEvidence(ctx, created.card.id, fields(), 1)
  expect(same.document.revision).toBe(1)
  const changed = updateEvidence(ctx, created.card.id, { ...fields(), claim: '修订' }, 1)
  expect(changed.card.versions).toHaveLength(2)
  expect(changed.card.versions[0]).toEqual(created.card.versions[0])
  expect(changed.card.versions[1]!.quote).toBe(fields().quote)
  expect(archiveEvidence(ctx, created.card.id, true, 2).card.versions).toHaveLength(3)
})
it('断链不丢证据，仍可修订和归档，但不能新建无效引用', () => {
  const { ctx } = setup(); const created = createEvidence(ctx, fields(), 0)
  ctx.catalog.papers = () => []; ctx.catalog.projects = () => []
  expect(updateEvidence(ctx, created.card.id, { ...fields(), comment: '保留个人判断' }, 1).card.versions).toHaveLength(2)
  expect(archiveEvidence(ctx, created.card.id, true, 2).card.versions.at(-1)?.archived).toBe(true)
  expect(() => createEvidence(ctx, fields(), 3)).toThrow(/NOT_FOUND/)
})
it('旧空间、取消及旧revision不动盘', () => {
  const { ctx, root } = setup(); const created = createEvidence(ctx, fields(), 0)
  const before = readFileSync(join(root, '.mimir/library/evidence.json'))
  expect(() => updateEvidence(ctx, created.card.id, { ...fields(), comment: 'late' }, 0)).toThrow(/CONFLICT/)
  expect(() => archiveEvidence({ ...ctx, signal: AbortSignal.abort() }, created.card.id, true, 1)).toThrow()
  expect(() => updateEvidence({ ...ctx, assertCurrent: () => { throw Error('SPACE_CHANGED') } }, created.card.id, fields(), 1)).toThrow(/SPACE_CHANGED/)
  expect(readFileSync(join(root, '.mimir/library/evidence.json'))).toEqual(before)
})
