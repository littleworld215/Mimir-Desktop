import { afterEach, expect, it } from 'vitest'
import { mkdtempSync, existsSync, mkdirSync, readFileSync, writeFileSync, readdirSync, rmSync, symlinkSync, renameSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { createEditingRepository } from '../../../electron/libraryEditing/repository'

const roots: string[] = []
const setup = () => { const root = mkdtempSync(join(tmpdir(), 'mimir-editing-')); roots.push(root); return root }
const path = (root: string) => join(root, '.mimir/library-editing/drafts.json')
const row = () => ({ id: randomUUID(), paperId: 'synthetic', kind: 'notes' as const, base: { notes: 'before' }, input: 'new\n\n 空白 ', revision: 1, updatedAt: '2026-10-23T00:00:00.000Z' })
const next = () => ({ schemaVersion: 1 as const, revision: 1, drafts: [row()] })
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })

it('a missing read does not create the control directory, committed data survives a new repository', () => {
  const root = setup(), repo = createEditingRepository(), value = next()
  expect(repo.read(root)).toEqual({ schemaVersion: 1, revision: 0, drafts: [] })
  expect(existsSync(join(root, '.mimir'))).toBe(false)
  repo.commit(root, 0, value, () => {})
  expect(createEditingRepository().read(root)).toEqual(value)
})
it.each(['write', 'sync', 'close', 'rename'] as const)('%s failure preserves the old bytes and removes only its temporary file', hook => {
  const root = setup(), repo = createEditingRepository(), value = next()
  repo.commit(root, 0, value, () => {})
  const before = readFileSync(path(root))
  expect(() => createEditingRepository({ [hook]: () => { throw Error('synthetic disk failure') } }).commit(root, 1, { ...value, revision: 2 }, () => {})).toThrow(/WRITE_FAILED/)
  expect(readFileSync(path(root))).toEqual(before)
  expect(readdirSync(join(root, '.mimir/library-editing'))).toEqual(['drafts.json'])
})
it('stale revision and a canceled publication do not alter stored data', () => {
  const root = setup(), repo = createEditingRepository(), value = next()
  repo.commit(root, 0, value, () => {})
  const before = readFileSync(path(root))
  expect(() => repo.commit(root, 0, value, () => {})).toThrow(/CONFLICT/)
  expect(() => repo.commit(root, 1, { ...value, revision: 2 }, () => { throw Error('scope ended') })).toThrow()
  expect(readFileSync(path(root))).toEqual(before)
})
it('changed source during beforePublish is not overwritten', () => {
  const root = setup(), repo = createEditingRepository(), value = next()
  repo.commit(root, 0, value, () => {})
  const changed = JSON.stringify({ ...value, revision: 9 })
  expect(() => repo.commit(root, 1, { ...value, revision: 2 }, () => writeFileSync(path(root), changed))).toThrow(/CONFLICT/)
  expect(readFileSync(path(root), 'utf8')).toBe(changed)
})
it('corrupt JSON, invalid UTF8, newer schema and directory replacement are preserved and rejected', () => {
  const root = setup(), repo = createEditingRepository()
  mkdirSync(join(root, '.mimir/library-editing'), { recursive: true })
  for (const bytes of [Buffer.from('{'), Buffer.from([0xff]), Buffer.from('{"schemaVersion":2,"revision":0,"drafts":[]}')]) {
    writeFileSync(path(root), bytes)
    expect(() => repo.read(root)).toThrow()
    expect(() => repo.commit(root, 0, next(), () => {})).toThrow()
    expect(readFileSync(path(root))).toEqual(bytes)
  }
  rmSync(path(root)); mkdirSync(path(root))
  expect(() => repo.read(root)).toThrow()
})
it('a junction out of the control tree does not get followed or written', () => {
  const root = setup(), outside = setup()
  mkdirSync(join(root, '.mimir'))
  symlinkSync(outside, join(root, '.mimir/library-editing'), process.platform === 'win32' ? 'junction' : 'dir')
  const repo = createEditingRepository()
  expect(() => repo.read(root)).toThrow()
  expect(() => repo.commit(root, 0, next(), () => {})).toThrow()
  expect(readdirSync(outside)).toEqual([])
})
it('a replaced file during read is detected instead of returning an old snapshot', () => {
  const root = setup(), repo = createEditingRepository(), value = next()
  repo.commit(root, 0, value, () => {})
  const replacement = path(root) + '.replacement'
  writeFileSync(replacement, JSON.stringify(value))
  const changing = createEditingRepository({ afterRead: () => renameSync(replacement, path(root)) })
  expect(() => changing.read(root)).toThrow()
  expect(repo.read(root)).toEqual(value)
})
