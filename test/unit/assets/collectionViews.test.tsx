// @vitest-environment jsdom
import {afterEach,beforeEach,it,expect,vi} from 'vitest'
import {cleanup,render,screen,fireEvent,waitFor} from '@testing-library/react'
import {QuickUse} from '../../../src/components/modules/assets/QuickUse'
import {SavedFilters} from '../../../src/components/modules/assets/SavedFilters'
import {Assets} from '../../../src/components/modules/assets/Assets'
const scope={workspaceId:'A',spaceEpoch:'A#1'},write=<T,>(fn:(s:typeof scope)=>Promise<T>)=>fn(scope)
const detail={id:1,code:'a',name:'多行原文',category:'inbox',categoryPath:['收集箱'],storageType:'inline_text',description:'',tags:[],revision:1,currentVersionId:1,currentVersion:1,currentContent:' x\r\n\n',versionCount:1,archivedAt:null,isFavorite:1,lastUsedAt:null,notes:'',sourceTask:'',sourceJson:'{}',templateConfig:{version:1,variables:{}},updatedAt:'now',createdAt:'now',externalUrl:null,fileAvailable:false,currentFileName:null}
let api:Record<string,ReturnType<typeof vi.fn>>,clipboard:ReturnType<typeof vi.fn>
beforeEach(()=>{window.history.replaceState({},'','/');localStorage.clear();clipboard=vi.fn().mockResolvedValue(undefined);Object.defineProperty(navigator,'clipboard',{configurable:true,value:{writeText:clipboard}});api={context:vi.fn().mockResolvedValue({ok:true,context:scope}),list:vi.fn().mockResolvedValue({ok:true,page:{items:[detail],total:1,page:1,pageSize:20}}),get:vi.fn().mockResolvedValue({ok:true,asset:detail}),recordUsage:vi.fn().mockResolvedValue({ok:true,recordedAt:'now'}),listTags:vi.fn().mockResolvedValue({ok:true,tags:[]}),listCategories:vi.fn().mockResolvedValue({ok:true,categories:[]}),listSavedFilters:vi.fn().mockResolvedValue({ok:true,filters:[]})};Object.defineProperty(window,'electronAPI',{configurable:true,value:{assets:api}})})
afterEach(()=>{cleanup();window.history.replaceState({},'','/')})
const quick=(onClose=vi.fn())=>render(<QuickUse scope={scope} write={write} onChanged={()=>{}} onClose={onClose}/> )
it('快速取用进入填值再关闭，两级窗口保留原触发焦点链',async()=>{
  const trigger=document.createElement('button');document.body.append(trigger);trigger.focus()
  const view=quick(()=>view.unmount());fireEvent.click(await screen.findByRole('button',{name:/多行原文 ·/}));await screen.findByLabelText('快速取用详情')
  const fill=screen.getByRole('button',{name:'填值复制',exact:true});fill.focus();fireEvent.click(fill)
  await screen.findByLabelText('填值预览');fireEvent.click(screen.getByRole('button',{name:'关闭',exact:true}))
  await waitFor(()=>expect(document.activeElement).toBe(fill))
  fireEvent.click(screen.getByRole('button',{name:'关闭',exact:true}));await waitFor(()=>expect(document.activeElement).toBe(trigger));trigger.remove()
})
it('快速取用只读摘要，剪贴板失败不记使用且保留详情；成功复制逐字与资产ID一致',async()=>{
  quick();await screen.findByRole('button',{name:/多行原文 ·/});expect(api.get).not.toHaveBeenCalled()
  fireEvent.click(screen.getByRole('button',{name:/多行原文 ·/}));await screen.findByLabelText('快速取用详情');await new Promise(r=>setTimeout(r,350));expect(screen.getByLabelText('快速取用详情')).toBeTruthy()
  clipboard.mockRejectedValueOnce(new Error('clipboard denied'));fireEvent.click(screen.getByRole('button',{name:'复制',exact:true}))
  await screen.findByText('clipboard denied');expect(api.recordUsage).not.toHaveBeenCalled();expect(screen.getByLabelText('快速取用详情')).toBeTruthy()
  fireEvent.click(screen.getByRole('button',{name:'复制',exact:true}));await screen.findByText('取用成功。')
  expect(clipboard).toHaveBeenLastCalledWith(' x\r\n\n');expect(api.recordUsage).toHaveBeenCalledWith({...scope,assetIds:[1]})
})
it('记录失败不撤销成功复制，也不关闭窗口；IME不提交，Ctrl+Enter复制，Esc先回结果',async()=>{
  const close=vi.fn();quick(close);await screen.findByRole('button',{name:/多行原文 ·/})
  const input=screen.getByLabelText('快速检索');fireEvent.compositionStart(input);fireEvent.keyDown(input,{key:'Enter',keyCode:229});expect(api.get).not.toHaveBeenCalled();fireEvent.compositionEnd(input)
  fireEvent.keyDown(input,{key:'Enter'});await screen.findByLabelText('快速取用详情')
  api.recordUsage.mockResolvedValue({ok:false,code:'SPACE_CHANGED',message:'record failed'})
  fireEvent.click(screen.getByRole('button',{name:'复制并关闭'}));await screen.findByText(/取用成功；最近使用记录未保存/);expect(close).not.toHaveBeenCalled()
  fireEvent.keyDown(input,{key:'Enter',ctrlKey:true});await waitFor(()=>expect(api.recordUsage).toHaveBeenCalledTimes(2))
  const copy=screen.getByRole('button',{name:'复制',exact:true});copy.focus();fireEvent.keyDown(copy,{key:'Escape'});await screen.findByLabelText('快速取用结果');expect(close).not.toHaveBeenCalled();expect(document.activeElement).toBe(input)
})
it('新查询使旧详情失效，卸载后的迟到响应不得出现',async()=>{
  let finish!:(r:unknown)=>void;api.get.mockImplementation(()=>new Promise(r=>{finish=r}));const view=quick()
  fireEvent.click(await screen.findByRole('button',{name:/多行原文 ·/}));fireEvent.click(screen.getByRole('button',{name:'全部',exact:true}));await waitFor(()=>expect(api.list).toHaveBeenCalledWith(expect.objectContaining({view:'all'})))
  finish({ok:true,asset:{...detail,name:'迟到详情'}});await new Promise(r=>setTimeout(r,0));expect(screen.queryByText('迟到详情')).toBeNull()
  view.unmount()
})
it('置顶是本机空间偏好且不会改收藏或编辑；成功复制并关闭恢复原焦点',async()=>{
  const trigger=document.createElement('button');document.body.append(trigger);trigger.focus()
  const view=quick(()=>view.unmount());fireEvent.click(await screen.findByRole('button',{name:/多行原文 ·/}));await screen.findByLabelText('快速取用详情')
  fireEvent.click(screen.getByRole('button',{name:'置顶',exact:true}));expect(JSON.parse(localStorage.getItem('mimir:asset-pins:A')!)).toEqual([1])
  fireEvent.click(screen.getByRole('button',{name:'复制并关闭'}));await waitFor(()=>expect(screen.queryByRole('dialog')).toBeNull());await waitFor(()=>expect(document.activeElement).toBe(trigger));trigger.remove()
})
it('失效条件不可应用；revision冲突保留筛选名称与选择，不误替换条件',async()=>{
  const f={id:1,name:'旧筛选',query:{excludeTagIds:[99],view:'favorites'},revision:1,createdAt:'now',updatedAt:'now'}
  api.listSavedFilters.mockResolvedValue({ok:true,filters:[f]});api.updateSavedFilter=vi.fn().mockResolvedValue({ok:false,code:'REVISION_CONFLICT',message:'筛选已修改'})
  render(<SavedFilters scope={scope} query={{view:'recent'}} tags={[]} categories={[]} write={write} onApply={vi.fn()} onClose={()=>{}}/>)
  await screen.findByText(/失效条件：标签 #99/);expect((screen.getByRole('button',{name:'应用 旧筛选'}) as HTMLButtonElement).disabled).toBe(true)
  fireEvent.click(screen.getByRole('button',{name:'旧筛选',exact:true}));fireEvent.change(screen.getByLabelText('筛选名称'),{target:{value:'未保存名称'}});fireEvent.click(screen.getByRole('button',{name:'保存名称'}))
  await screen.findByText('筛选已修改');expect((screen.getByLabelText('筛选名称') as HTMLInputElement).value).toBe('未保存名称')
  expect(api.updateSavedFilter).toHaveBeenCalledWith({...scope,filterId:1,expectedRevision:1,name:'未保存名称',query:f.query})
})
it('文件保存取消或失败不记使用；外链只复制URL',async()=>{
  api.get.mockResolvedValue({ok:true,asset:{...detail,storageType:'file',fileAvailable:true,currentFileName:'x.txt'}})
  const save=vi.fn().mockResolvedValue({canceled:true}),saveFile=vi.fn().mockResolvedValue({ok:false,code:'WRITE_FAILED',message:'file failed'})
  Object.defineProperty(window,'electronAPI',{configurable:true,value:{assets:{...api,saveFile},showSaveDialog:save}})
  quick();fireEvent.click(await screen.findByRole('button',{name:/多行原文 ·/}));await screen.findByLabelText('快速取用详情');fireEvent.click(screen.getByRole('button',{name:'下载',exact:true}));await waitFor(()=>expect(save).toHaveBeenCalledTimes(1));expect(api.recordUsage).not.toHaveBeenCalled()
  save.mockResolvedValue({canceled:false,filePath:'synthetic'});fireEvent.click(screen.getByRole('button',{name:'下载',exact:true}));await screen.findByText('file failed');expect(api.recordUsage).not.toHaveBeenCalled()
  fireEvent.click(screen.getByRole('button',{name:'返回结果'}));api.get.mockResolvedValue({ok:true,asset:{...detail,storageType:'external_link',externalUrl:'https://example.org/a'}});fireEvent.click(screen.getByRole('button',{name:/多行原文 ·/}));await screen.findByLabelText('快速取用详情');fireEvent.click(screen.getByRole('button',{name:'复制',exact:true}));await screen.findByText('取用成功。');expect(clipboard).toHaveBeenLastCalledWith('https://example.org/a')
})
it('主资产视图收藏及全文范围继续可用；取用范围写入URL',async()=>{
  api.references=vi.fn().mockResolvedValue({ok:true,references:{assetId:1,revision:1,references:[],referencedBy:[]}});api.setFavorite=vi.fn().mockResolvedValue({ok:true,favorite:false})
  render(<Assets/>);fireEvent.click(await screen.findByRole('button',{name:/多行原文/}));fireEvent.click(await screen.findByRole('button',{name:'取消收藏'}));await waitFor(()=>expect(api.setFavorite).toHaveBeenCalledWith({...scope,assetId:1,favorite:false}))
  fireEvent.change(screen.getByLabelText('取用范围'),{target:{value:'recent'}});await waitFor(()=>expect(api.list).toHaveBeenCalledWith(expect.objectContaining({view:'recent'})));expect(JSON.parse(new URL(window.location.href).searchParams.get('assetQuery')!).view).toBe('recent')
})
