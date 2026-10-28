// @vitest-environment jsdom
import { afterEach,it,expect,vi } from 'vitest'
import { render,screen,fireEvent,cleanup } from '@testing-library/react'
import { CategoryTree } from '../../../src/components/modules/assets/CategoryTree'
import { AssetFilters } from '../../../src/components/modules/assets/AssetFilters'
import { AssetList } from '../../../src/components/modules/assets/AssetList'
import type { AssetCategory,AssetPage } from '../../../shared/assetsContracts'
afterEach(cleanup)
const categories=[{code:'p',name:'父分类',parentCode:null,sortOrder:0,assetCount:2},{code:'c',name:'子分类',parentCode:'p',sortOrder:0,assetCount:3} ] as AssetCategory[]
it('折叠不改变查询，改选子分类时自动展开祖先',()=>{
 const select=vi.fn();const props={categories,disabled:false,onSelect:select,onEdit:vi.fn()}
 const {rerender}=render(<CategoryTree {...props}/>)
 fireEvent.click(screen.getByRole('button',{name:'折叠分类 父分类'}))
 expect(screen.queryByText('子分类')).toBeNull();expect(select).not.toHaveBeenCalled()
 rerender(<CategoryTree {...props} current="c"/>)
 expect(screen.getByText('子分类')).toBeTruthy()
 expect(screen.getByText(/数字为直属资产/)).toBeTruthy()
})
it('禁用时不能折叠，计数不冒充子树总数',()=>{
 render(<CategoryTree categories={categories} current="p" disabled onSelect={vi.fn()} onEdit={vi.fn()}/>)
 expect(screen.getByRole('button',{name:'折叠分类 父分类'})).toHaveProperty('disabled',true)
 expect(screen.getByText('2')).toBeTruthy()
})
const tags=[{id:1,name:'方法',color:null,revision:1},{id:2,name:'证据',color:null,revision:1}]
it('标签搜索仅过滤候选，不发资产检索、不隐藏已选标签',()=>{
 const change=vi.fn().mockResolvedValue(undefined)
 render(<AssetFilters query={{tagIds:[1]}} tags={tags} disabled={false} onChange={change}/>)
 fireEvent.change(screen.getByLabelText('搜索筛选标签'),{target:{value:'证据'}})
 expect(screen.getByLabelText('包含标签 方法')).toBeTruthy()
 expect(screen.getByLabelText('包含标签 证据')).toBeTruthy()
 expect(change).not.toHaveBeenCalled()
})
it('筛选摘要可见且单项移除只改变该字段',()=>{
 const change=vi.fn().mockResolvedValue(undefined)
 render(<AssetFilters query={{tagIds:[1],storageType:'file',q:'科研'}} tags={tags} disabled={false} onChange={change}/>)
 fireEvent.click(screen.getByRole('button',{name:'移除筛选 包含标签：方法'}))
 expect(change).toHaveBeenCalledWith({tagIds:[]})
 expect(screen.getByRole('button',{name:'移除筛选 形态：文件'})).toBeTruthy()
})
it('未匹配标签有明确空态且保持全部筛选能力',()=>{
 render(<AssetFilters query={{}} tags={tags} disabled={false} onChange={vi.fn().mockResolvedValue(undefined)}/>)
 fireEvent.change(screen.getByLabelText('搜索筛选标签'),{target:{value:'不存在'}})
 expect(screen.getByText('没有匹配的标签。')).toBeTruthy()
})
it('摘要保留字段、排序和标签关系，可独立恢复默认',()=>{
 const change=vi.fn().mockResolvedValue(undefined)
 render(<AssetFilters query={{searchIn:'body',sort:'recent',tagMode:'or',tagIds:[1]}} tags={tags} disabled={false} onChange={change}/>)
 expect(screen.getByRole('button',{name:'移除筛选 字段：当前正文'})).toBeTruthy()
 expect(screen.getByRole('button',{name:'移除筛选 排序：最近使用'})).toBeTruthy()
 fireEvent.click(screen.getByRole('button',{name:'移除筛选 标签关系：任一'}))
 expect(change).toHaveBeenCalledWith({tagMode:'and'})
})
it('卡片显示收藏和时间，不改变原选择动作',()=>{
 const select=vi.fn()
 const page={items:[{id:1,name:'科研资料',categoryPath:['父分类'],description:'说明',storageType:'inline_text',currentVersion:1,tags:[],isFavorite:1,updatedAt:'2026-10-28T12:00:00Z'}],total:1,page:1,pageSize:50} as AssetPage
 render(<AssetList page={page} disabled={false} onSelect={select} onPage={vi.fn()} onCreate={vi.fn()}/>)
 expect(screen.getByLabelText('已收藏')).toBeTruthy();expect(screen.getByText(/更新：/)).toBeTruthy()
 fireEvent.click(screen.getByRole('button',{name:/科研资料/}));expect(select).toHaveBeenCalledWith(1)
})
