// @vitest-environment jsdom
import { act, fireEvent, render, screen, cleanup } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { ImportDialog } from '../../../src/components/modules/assets/ImportDialog'
import { ExportDialog } from '../../../src/components/modules/assets/ExportDialog'
import { BatchImportDialog } from '../../../src/components/modules/assets/BatchImportDialog'
const mocks=vi.hoisted(()=>({adaptPromptImport:vi.fn(),previewImport:vi.fn(),importJson:vi.fn(),saveExchange:vi.fn(),readExchangeFile:vi.fn(),scanFolder:vi.fn(),nextFolderFile:vi.fn(),cancelFolder:vi.fn()}))
vi.mock('../../../src/components/modules/assets/assetsApi',()=>({assetsApi:mocks}))
const scope={workspaceId:'A',spaceEpoch:'A#1'}
const preview={previewToken:'a'.repeat(64),canCommit:true,created:1,updated:0,skipped:0,filesMissing:0,errors:[],duplicates:[],categoriesMissing:[],referencesMissing:[],rows:[]}
const write=async<T,>(fn:(s:typeof scope)=>Promise<T>)=>fn(scope)
beforeEach(()=>{vi.clearAllMocks();mocks.previewImport.mockResolvedValue({preview});mocks.importJson.mockRejectedValue(new Error('PREVIEW_STALE'))})
afterEach(cleanup)
it('改变策略会使预览失效，提交失败保留JSON和错误，重复提交只执行一次',async()=>{
  render(<ImportDialog scope={scope} write={write} onChanged={vi.fn()} onClose={vi.fn()} />)
  fireEvent.change(screen.getByLabelText('JSON内容'),{target:{value:'[{"name":"原文"}]'}})
  fireEvent.click(screen.getByRole('button',{name:'预览差异'}))
  await screen.findByText(/新增 1/)
  fireEvent.change(screen.getByLabelText('冲突策略'),{target:{value:'copy'}})
  expect((screen.getByRole('button',{name:'确认导入'}) as HTMLButtonElement).disabled).toBe(true)
  fireEvent.click(screen.getByRole('button',{name:'预览差异'}));await screen.findByText(/新增 1/)
  fireEvent.click(screen.getByRole('button',{name:'确认导入'}))
  await screen.findByRole('alert');expect(screen.getByLabelText('JSON内容')).toHaveProperty('value','[{"name":"原文"}]')
  expect(mocks.importJson).toHaveBeenCalledTimes(1)
})
it('清空或卸载后迟到预览不能复活',async()=>{
  let resolve!:(v:unknown)=>void;mocks.previewImport.mockReturnValue(new Promise(r=>{resolve=r}))
  const view=render(<ImportDialog scope={scope} write={write} onChanged={vi.fn()} onClose={vi.fn()} />)
  fireEvent.change(screen.getByLabelText('JSON内容'),{target:{value:'[]'}});fireEvent.click(screen.getByRole('button',{name:'预览差异'}))
  fireEvent.change(screen.getByLabelText('JSON内容'),{target:{value:''}})
  await act(async()=>{resolve({preview})});expect(screen.queryByText(/新增 1/)).toBeNull();view.unmount()
})
it('选择导出传完整筛选不传分页',async()=>{
  Object.defineProperty(window,'electronAPI',{configurable:true,value:{showSaveDialog:vi.fn().mockResolvedValue({canceled:false,filePath:'/chosen'})}})
  mocks.saveExchange.mockResolvedValue({saved:true,count:2})
  render(<ExportDialog query={{q:'科研',page:2,pageSize:30}} ids={[1,2]} write={write} onClose={vi.fn()} />)
  fireEvent.click(screen.getByRole('button',{name:'保存导出'}));await screen.findByText(/已导出 2/)
  expect(mocks.saveExchange.mock.calls[0][0]).toMatchObject({ids:[1,2],query:{q:'科研'},destinationPath:'/chosen'})
  expect(mocks.saveExchange.mock.calls[0][0].query.page).toBeUndefined()
})
it('外部格式仅显式转换；确认提交预览对应的转换JSON，改变转换选项使预览失效',async()=>{
  mocks.adaptPromptImport.mockResolvedValue({adaptation:{raw:'{"assets":[]}',changes:[{name:'外部模板',before:'{{语言=[中文|English]}}',after:'{{语言}}',warnings:[]}],warnings:['不会自动导入内置素材']}})
  mocks.importJson.mockResolvedValue({result:{created:1,updated:0,skipped:0}})
  render(<ImportDialog scope={scope} write={write} onChanged={vi.fn()} onClose={vi.fn()} />)
  fireEvent.change(screen.getByLabelText('JSON内容'),{target:{value:'{"format":"promptdock"}'}})
  fireEvent.change(screen.getByLabelText('来源格式'),{target:{value:'prompt'}})
  fireEvent.click(screen.getByRole('button',{name:'预览差异'}));await screen.findByLabelText('格式转换差异')
  expect(mocks.adaptPromptImport.mock.calls[0][0].convertVariables).toBe(false)
  fireEvent.click(screen.getByLabelText('显式转换变量语法（默认保留原文）'))
  expect((screen.getByRole('button',{name:'确认导入'}) as HTMLButtonElement).disabled).toBe(true)
  fireEvent.click(screen.getByRole('button',{name:'预览差异'}));await screen.findByLabelText('格式转换差异')
  fireEvent.click(screen.getByRole('button',{name:'确认导入'}));await act(async()=>{})
  expect(mocks.importJson.mock.calls[0][0].raw).toBe('{"assets":[]}')
})
it('取消原生保存不调用落盘',async()=>{
  Object.defineProperty(window,'electronAPI',{configurable:true,value:{showSaveDialog:vi.fn().mockResolvedValue({canceled:true})}})
  render(<ExportDialog query={{}} ids={[]} write={write} onClose={vi.fn()} />)
  fireEvent.click(screen.getByRole('button',{name:'保存导出'}));await act(async()=>{})
  expect(mocks.saveExchange).not.toHaveBeenCalled()
})
it('拖入新JSON开始读取即撤销旧预览，读取中不能提交旧内容',async()=>{
  render(<ImportDialog scope={scope} write={write} onChanged={vi.fn()} onClose={vi.fn()} />)
  fireEvent.change(screen.getByLabelText('JSON内容'),{target:{value:'[]'}});fireEvent.click(screen.getByRole('button',{name:'预览差异'}));await screen.findByText(/新增 1/)
  let resolve!:(s:string)=>void
  const confirm=screen.getByRole('button',{name:'确认导入'})
  fireEvent.drop(screen.getByText(/选择或拖入JSON/).parentElement!,{dataTransfer:{files:[{size:2,text:()=>new Promise<string>(r=>{resolve=r})}]}})
  fireEvent.click(confirm);expect(mocks.importJson).not.toHaveBeenCalled()
  await act(async()=>{resolve('[{"name":"新输入"}]')});expect(screen.getByLabelText('JSON内容')).toHaveProperty('value','[{"name":"新输入"}]')
})
it('文件夹暂停等当前文件结束，继续仅处理剩余，不重复已成功项',async()=>{
  const entries=[{index:1,name:'a.txt',state:'pending'},{index:2,name:'b.txt',state:'pending'}]
  const initial={queueId:'queue',total:2,completed:0,entries}
  Object.defineProperty(window,'electronAPI',{configurable:true,value:{showOpenDialog:vi.fn().mockResolvedValue({canceled:false,filePaths:['/selected-folder']})}})
  mocks.scanFolder.mockResolvedValue({queue:initial})
  let resolve!:(v:unknown)=>void
  mocks.nextFolderFile.mockReturnValueOnce(new Promise(r=>{resolve=r})).mockResolvedValueOnce({queue:{...initial,completed:2,entries:entries.map(e=>({...e,state:'done'}))}})
  render(<BatchImportDialog scope={scope} categories={[]} write={write} onChanged={vi.fn()} onClose={vi.fn()}/>)
  fireEvent.click(screen.getByRole('button',{name:'选择文件夹并扫描'}));await screen.findByText(/0 \/ 2/)
  fireEvent.click(screen.getByRole('button',{name:'开始／继续'}));fireEvent.click(screen.getByRole('button',{name:'暂停'}))
  await act(async()=>{resolve({queue:{...initial,completed:1,entries:[{...entries[0],state:'done'},entries[1]]}})})
  expect(mocks.nextFolderFile).toHaveBeenCalledTimes(1)
  fireEvent.click(screen.getByRole('button',{name:'开始／继续'}));await screen.findByText(/2 \/ 2/)
  expect(mocks.nextFolderFile).toHaveBeenCalledTimes(2)
})
it('完成队列卸载时释放；扫描晚响应只清理队列，不写回卸载页面',async()=>{
  Object.defineProperty(window,'electronAPI',{configurable:true,value:{showOpenDialog:vi.fn().mockResolvedValue({canceled:false,filePaths:['/folder']})}})
  let resolve!:(v:unknown)=>void;mocks.scanFolder.mockReturnValue(new Promise(r=>{resolve=r}));mocks.cancelFolder.mockResolvedValue({canceled:true})
  const changed=vi.fn(),view=render(<BatchImportDialog scope={scope} categories={[]} write={write} onChanged={changed} onClose={vi.fn()}/>)
  fireEvent.click(screen.getByRole('button',{name:'选择文件夹并扫描'}));await act(async()=>{});view.unmount()
  await act(async()=>{resolve({queue:{queueId:'late',total:0,completed:0,entries:[]}})})
  expect(mocks.cancelFolder).toHaveBeenCalledWith({...scope,queueId:'late'});expect(changed).not.toHaveBeenCalled()
})
