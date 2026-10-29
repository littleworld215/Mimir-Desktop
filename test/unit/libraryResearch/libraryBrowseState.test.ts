import { expect, it } from 'vitest'
import * as implementation from '../../../src/lib/libraryBrowseState'

const api = implementation as unknown as Record<string, (...args: any[]) => any>
function method(name: string) {
  expect(api[name], `navigation preference method ${name}`).toBeTypeOf('function')
  return api[name]!
}
function memory() {
  const values = new Map<string, string>()
  return { values, getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => { values.set(key, value) }, removeItem: (key: string) => { values.delete(key) } }
}
function snapshot() {
  return { version: 1, projectId: 'project', view: 'matrix', keyword: '公平性\n😀', scrollTop: 43,
    returnPaperId: 'paper', matrix: { filter: { archive: 'include', source: 'problem', keyword: '条件', reviewState: 'draft' }, page: 2, scrollTop: 30 },
    research: { kind: 'packs', keyword: '综述', archive: 'exclude', page: 1, scrollTop: 4, selected: { kind: 'pack', id: 'pack-1' } },
    readers: [{ paperId: 'paper', mode: 'enhanced', page: 3, scale: 1.25, touchedAt: 100 }] }
}

it('真实JSON往返白名单浏览状态，分别清除空间，不存scope或正文', () => {
  const storage = memory(), state = snapshot()
  expect(method('writeLibraryBrowseState')(storage, 'A', state)).toEqual({ ok: true })
  expect(method('readLibraryBrowseState')(storage, 'A').state).toEqual(state)
  expect(method('readLibraryBrowseState')(storage, 'B').state).toBeUndefined()
  expect([...storage.values.values()].join()).not.toContain('spaceEpoch')
  method('writeLibraryBrowseState')(storage, 'B', { ...state, keyword: 'B' })
  expect(method('clearLibraryBrowseState')(storage, 'A')).toEqual({ ok: true })
  expect(method('readLibraryBrowseState')(storage, 'B').state.keyword).toBe('B')
})

it('正文/任意路径/旧scope及嵌套未知属性拒绝，保留原偏好和输入', () => {
  for (const extra of [{ quote: '正文' }, { scope: { spaceEpoch: 'old' } }, { filePath: 'C:/secret' }, { matrix: { ...snapshot().matrix, content: '正文' } }, { readers: [{ ...snapshot().readers[0], notes: '正文' }] }]) {
    const storage = memory(), initial = snapshot()
    method('writeLibraryBrowseState')(storage, 'A', initial)
    const original = [...storage.values.values()][0], input = { ...initial, ...extra }, before = JSON.stringify(input)
    expect(method('writeLibraryBrowseState')(storage, 'A', input).ok).toBe(false)
    expect([...storage.values.values()][0]).toBe(original)
    expect(JSON.stringify(input)).toBe(before)
  }
})

it('64KiB以UTF8字节限制，不静默截断筛选；精确边界可保存', () => {
  const storage = memory(), base = snapshot(), encoder = new TextEncoder()
  const empty = { ...base, keyword: '' }, overhead = encoder.encode(JSON.stringify(empty)).length
  const exact = { ...empty, keyword: 'a'.repeat(64 * 1024 - overhead) }
  expect(method('writeLibraryBrowseState')(storage, 'A', exact).ok).toBe(true)
  expect(encoder.encode([...storage.values.values()][0]!).length).toBe(64 * 1024)
  expect(method('writeLibraryBrowseState')(storage, 'A', { ...exact, keyword: exact.keyword + '😀' }).ok).toBe(false)
  expect(method('readLibraryBrowseState')(storage, 'A').state.keyword).toBe(exact.keyword)
})

it('最近20篇按时间淘汰、同paper去重，不改变调用者对象', () => {
  const storage = memory(), state = { ...snapshot(), readers: Array.from({ length: 21 }, (_, n) => ({ paperId: `p${n}`, mode: 'native', requestedNativePage: 2, scale: 1, touchedAt: n })) }
  const before = JSON.stringify(state)
  expect(method('writeLibraryBrowseState')(storage, 'A', state).ok).toBe(true)
  const readers = method('readLibraryBrowseState')(storage, 'A').state.readers
  expect(readers).toHaveLength(20)
  expect(readers.some((r: any) => r.paperId === 'p0')).toBe(false)
  expect(JSON.stringify(state)).toBe(before)
  expect(method('writeLibraryBrowseState')(storage, 'A', { ...state, readers: [{ ...state.readers[0], touchedAt: 30 }, ...state.readers] }).ok).toBe(true)
  expect(method('readLibraryBrowseState')(storage, 'A').state.readers.filter((r: any) => r.paperId === 'p0')).toHaveLength(1)
})

it('损坏/较新/非法枚举/数字不恢复，不重置原存储；危险workspace键拒绝', () => {
  const storage = memory()
  method('writeLibraryBrowseState')(storage, 'A', snapshot())
  const key = [...storage.values.keys()][0]!
  for (const value of ['{', JSON.stringify({ ...snapshot(), version: 2 }), JSON.stringify({ ...snapshot(), scrollTop: -1 }), JSON.stringify({ ...snapshot(), view: 'unknown' }), JSON.stringify({ ...snapshot(), readers: [{ ...snapshot().readers[0], scale: 0 }] }), JSON.stringify({ ...snapshot(), matrix: { ...snapshot().matrix, page: 0 } })]) {
    storage.values.set(key, value)
    const reply = method('readLibraryBrowseState')(storage, 'A')
    expect(reply.state).toBeUndefined()
    expect(reply.warning).toBeTruthy()
    expect(storage.values.get(key)).toBe(value)
  }
  expect(method('writeLibraryBrowseState')(storage, '', snapshot()).ok).toBe(false)
  expect(method('writeLibraryBrowseState')(storage, 'A\0B', snapshot()).ok).toBe(false)
})

it('存储get/set/remove失败只返回偏好错误，不吞业务输入', () => {
  const denied = { getItem() { throw Error('denied') }, setItem() { throw Error('quota') }, removeItem() { throw Error('denied') } }
  expect(method('readLibraryBrowseState')(denied, 'A').warning).toBeTruthy()
  expect(method('writeLibraryBrowseState')(denied, 'A', snapshot()).ok).toBe(false)
  expect(method('clearLibraryBrowseState')(denied, 'A').ok).toBe(false)
})
