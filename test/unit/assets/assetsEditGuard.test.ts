import { it, expect } from 'vitest'
import { registerAssetsEditor, setAssetsLeaveChooser, requestAssetsLeave, hasAssetsWork } from '../../../src/lib/assetsEditGuard'
it('原生关闭选择保存时失败仍阻止关闭，无需再次弹页面选择', async () => {
  let dirty = true
  const unregister = registerAssetsEditor({ isDirty: () => dirty, isBusy: () => false, save: async () => false, discard: () => { dirty = false } })
  expect(await requestAssetsLeave('save')).toBe(false)
  expect(dirty).toBe(true)
  expect(await requestAssetsLeave('cancel')).toBe(false)
  expect(await requestAssetsLeave('discard')).toBe(true)
  expect(dirty).toBe(false)
  unregister()
})

it('保存失败或取消不离开；显式丢弃才释放草稿', async () => {
  let dirty = true, shouldSave = false
  const unregister = registerAssetsEditor({ isDirty: () => dirty, isBusy: () => false, save: async () => shouldSave, discard: () => { dirty = false } })
  const unset = setAssetsLeaveChooser(async () => 'save')
  expect(await requestAssetsLeave()).toBe(false)
  expect(hasAssetsWork()).toBe(true)
  shouldSave = true
  expect(await requestAssetsLeave()).toBe(true)
  unset()
  const discard = setAssetsLeaveChooser(async () => 'discard')
  expect(await requestAssetsLeave()).toBe(true)
  expect(dirty).toBe(false)
  discard(); unregister()
  expect(hasAssetsWork()).toBe(false)
})
it('在途写入与重复离开请求阻止导航，注销不清另一个编辑器', async () => {
  let busy = true
  const first = registerAssetsEditor({ isDirty: () => true, isBusy: () => busy, save: async () => true, discard: () => {} })
  const second = registerAssetsEditor({ isDirty: () => false, isBusy: () => false, save: async () => true, discard: () => {} })
  expect(await requestAssetsLeave()).toBe(false)
  busy = false
  let answer!: (value: 'cancel') => void
  const unset = setAssetsLeaveChooser(() => new Promise(resolve => { answer = resolve }))
  const pending = requestAssetsLeave()
  expect(await requestAssetsLeave()).toBe(false)
  answer('cancel'); expect(await pending).toBe(false)
  first(); expect(hasAssetsWork()).toBe(false)
  second(); unset()
})
