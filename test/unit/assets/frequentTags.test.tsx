// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { FrequentTags } from '../../../src/components/modules/assets/FrequentTags'
afterEach(() => { cleanup(); vi.restoreAllMocks(); localStorage.clear() })
const tags = [{id:1,name:'方法',color:null,revision:1}], scope = {workspaceId:'A',spaceEpoch:'e1'}
it('存储失败可见且不改筛选或伪造已保存常用', async () => {
  const change=vi.fn(async()=>{})
  vi.spyOn(Storage.prototype,'setItem').mockImplementation(()=>{throw Error('合成存储失败')})
  render(<FrequentTags scope={scope} tags={tags} query={{excludeTagIds:[1]}} disabled={false} onChange={change} />)
  fireEvent.change(await screen.findByLabelText('设为常用的标签'),{target:{value:'1'}})
  fireEvent.click(screen.getByRole('button',{name:'添加常用标签'}))
  await screen.findByText('合成存储失败')
  expect(change).not.toHaveBeenCalled();expect(screen.queryByRole('button',{name:'常用标签 方法',exact:true})).toBeNull()
})
it('显式设常用、排除时包含语义与原操作一致；重命名用新名称，失效保留到手动移除', async () => {
  const query = { tagIds: [] as number[], excludeTagIds: [1] }, change = vi.fn(async () => {})
  const view = render(<FrequentTags scope={scope} tags={tags} query={query} disabled={false} onChange={change} />)
  fireEvent.change(await screen.findByLabelText('设为常用的标签'), {target:{value:'1'}})
  fireEvent.click(screen.getByRole('button',{name:'添加常用标签'}))
  fireEvent.click(await screen.findByRole('button',{name:'常用标签 方法',exact:true}))
  await waitFor(()=>expect(change).toHaveBeenCalledWith({tagIds:[1]}))
  expect(query).toEqual({tagIds:[],excludeTagIds:[1]})
  view.rerender(<FrequentTags scope={scope} tags={[{...tags[0]!,name:'新方法'}]} query={query} disabled={false} onChange={change} />)
  await screen.findByRole('button',{name:'常用标签 新方法',exact:true})
  view.rerender(<FrequentTags scope={scope} tags={[]} query={query} disabled={false} onChange={change} />)
  expect((await screen.findByRole('button',{name:'常用标签 已失效标签 #1',exact:true}) as HTMLButtonElement).disabled).toBe(true)
  expect(localStorage.getItem('mimir:asset-frequent-tags:v1:A')).toContain('1')
  fireEvent.click(screen.getByRole('button',{name:'取消常用标签 已失效标签 #1'}))
  expect(localStorage.getItem('mimir:asset-frequent-tags:v1:A')).toContain('[]')
})
it('空间改变不显示旧偏好，旧异步失败不污染新空间提示', async () => {
  localStorage.setItem('mimir:asset-frequent-tags:v1:A',JSON.stringify({version:1,ids:[1]}))
  let reject!: (failure: Error)=>void
  const change = vi.fn(()=>new Promise<void>((_,no)=>{reject=no}))
  const view=render(<FrequentTags scope={scope} tags={tags} query={{}} disabled={false} onChange={change} />)
  fireEvent.click(await screen.findByRole('button',{name:'常用标签 方法',exact:true}))
  view.rerender(<FrequentTags scope={{workspaceId:'B',spaceEpoch:'e2'}} tags={tags} query={{}} disabled={false} onChange={change} />)
  await waitFor(()=>expect(screen.queryByRole('button',{name:'常用标签 方法',exact:true})).toBeNull())
  reject(Error('旧空间失败'))
  await Promise.resolve(); expect(screen.queryByText('旧空间失败')).toBeNull()
  expect(localStorage.getItem('mimir:asset-frequent-tags:v1:B')).toBeNull()
})
