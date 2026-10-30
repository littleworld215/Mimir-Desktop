import { expect, it, vi } from 'vitest'
import * as implementation from '../../../src/lib/assetTagPreferences'
const api = implementation as unknown as { readFrequentAssetTags(storage: Pick<Storage,'getItem'>, workspace: string): { ids: number[]; warning?: string }; writeFrequentAssetTags(storage: Pick<Storage,'setItem'>, workspace: string, ids: number[]): { ok: boolean } }
it('同ID不同空间独立，去重且不修改传入数组', () => {
  expect(api.writeFrequentAssetTags).toBeTypeOf('function')
  const rows = new Map<string,string>(), storage = { getItem: (key: string) => rows.get(key) ?? null, setItem: (key: string, value: string) => rows.set(key, value) }, ids = [1,1,2]
  expect(api.writeFrequentAssetTags(storage, 'A', ids).ok).toBe(true)
  expect(ids).toEqual([1,1,2]); expect(api.readFrequentAssetTags(storage, 'A').ids).toEqual([1,2]); expect(api.readFrequentAssetTags(storage, 'B').ids).toEqual([])
  expect([...rows.keys()]).toEqual(['mimir:asset-frequent-tags:v1:A'])
})
it('损坏/较新/过大/非法ID读取失败不覆盖原存储，超过20拒绝写入', () => {
  expect(api.readFrequentAssetTags).toBeTypeOf('function')
  for (const raw of ['{', JSON.stringify({version:2,ids:[1]}), 'x'.repeat(16385), JSON.stringify({version:1,ids:[-1]}), JSON.stringify({version:1,ids:[],extra:true})]) {
    const setItem = vi.fn(), storage = { getItem: () => raw, setItem }
    expect(api.readFrequentAssetTags(storage, 'A')).toMatchObject({ ids: [], warning: expect.any(String) }); expect(setItem).not.toHaveBeenCalled()
  }
  const storage = { setItem: vi.fn() }
  expect(api.writeFrequentAssetTags(storage,'A',Array.from({length:20},(_,i)=>i+1)).ok).toBe(true)
  storage.setItem.mockClear()
  expect(api.writeFrequentAssetTags(storage,'A',Array.from({length:21},(_,i)=>i+1)).ok).toBe(false); expect(storage.setItem).not.toHaveBeenCalled()
  expect(api.writeFrequentAssetTags({setItem(){throw Error('blocked')}},'A',[1]).ok).toBe(false)
})
