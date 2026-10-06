// @vitest-environment jsdom
import { afterEach, it, expect } from 'vitest'
import { act, cleanup, renderHook } from '@testing-library/react'
import { useAssetPreview } from '../../../src/components/modules/assets/useAssetPreview'
afterEach(cleanup)
it('清除或换目标后旧治理预览不可复活；卸载后返回null', async () => {
  const { result, unmount } = renderHook(() => useAssetPreview<{ tagId: number }>())
  let finish!: (value: { tagId: number }) => void
  let pending!: Promise<{ tagId: number } | null>
  act(() => { pending = result.current.read(() => new Promise(resolve => { finish = resolve })) })
  act(() => result.current.clear())
  await act(async () => { await result.current.read(async () => ({ tagId: 2 })) })
  await act(async () => { finish({ tagId: 1 }); expect(await pending).toBeNull() })
  expect(result.current.value).toEqual({ tagId: 2 })
  act(() => { pending = result.current.read(() => new Promise(resolve => { finish = resolve })) })
  unmount(); finish({ tagId: 3 }); expect(await pending).toBeNull()
})
