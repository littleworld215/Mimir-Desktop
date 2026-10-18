import { afterEach, expect, it } from 'vitest'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { readResearchSnapshot } from '../../../electron/library/research/evidenceAccess'
import { researchFixture } from './fixtures'
const fixtures: ReturnType<typeof researchFixture>[] = []
const setup = () => { const f = researchFixture(0); fixtures.push(f); return f }
afterEach(() => fixtures.splice(0).forEach(f => f.clean()))
it('未使用、损坏和较新证据状态严格区分，研究损坏不吞掉', () => {
  const f = setup()
  expect(readResearchSnapshot(f.ctx).state).toMatchObject({ evidenceRevision: 0, evidenceState: 'absent' })
  const dir = join(f.root, '.mimir/library'); mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'evidence.json'), '{bad')
  expect(readResearchSnapshot(f.ctx).state).toMatchObject({ evidenceRevision: null, evidenceState: 'unreadable' })
  writeFileSync(join(dir, 'evidence.json'), JSON.stringify({ schemaVersion: 2 }))
  expect(readResearchSnapshot(f.ctx).state.evidenceState).toBe('unsupported')
  writeFileSync(join(dir, 'research.json'), '{bad')
  expect(() => readResearchSnapshot(f.ctx)).toThrow(/CORRUPT_DATA/)
})
