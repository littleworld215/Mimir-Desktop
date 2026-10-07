// @vitest-environment jsdom
import {afterEach,it,expect,vi} from 'vitest'
import {cleanup,render,screen,fireEvent,waitFor} from '@testing-library/react'
import {TemplateFill} from '../../../src/components/modules/assets/TemplateFill'
import {SafeMarkdown} from '../../../src/components/modules/assets/SafeMarkdown'
import {TemplateTools} from '../../../src/components/modules/assets/TemplateTools'
import {TaskPackDialog} from '../../../src/components/modules/assets/TaskPackDialog'
import {assetsApi} from '../../../src/components/modules/assets/assetsApi'
afterEach(()=>{cleanup();vi.restoreAllMocks()})
it('较短围栏在四反引号代码内不结束代码，不把代码内表格变成阅读表格',()=>{
  render(<SafeMarkdown content={'````md\n```\n| A | B |\n| --- | --- |\n| x | y |\n````'}/>)
  expect(screen.queryByRole('table')).toBeNull();expect(document.querySelector('pre')?.textContent).toContain('| A | B |')
})
it('任务包只读选择，原文未解析时不能复制；失败保留选择，成功记实际ID',async()=>{
  const scope={workspaceId:'test',spaceEpoch:'test#1'},asset={id:7,code:'a',name:'任务文本',kind:null,storageType:'inline_text',currentContent:'当前 AI 文本',revision:2,currentVersionId:2,sourceJson:'{}',tags:[],notes:'',sourceTask:''}
  const get=vi.spyOn(assetsApi,'get').mockResolvedValue({asset} as never),usage=vi.spyOn(assetsApi,'recordUsage').mockResolvedValue({} as never)
  let resolveOriginal!:(v:unknown)=>void
  const exported=vi.spyOn(assetsApi,'exportAssets').mockImplementation(()=>new Promise(resolve=>{resolveOriginal=resolve}) as never)
  Object.defineProperty(window,'electronAPI',{configurable:true,value:{getStoreValue:vi.fn().mockResolvedValue(undefined),setStoreValue:vi.fn().mockResolvedValue(undefined)}})
  const copy=vi.fn().mockRejectedValueOnce(Error('denied')).mockResolvedValue(undefined)
  Object.defineProperty(navigator,'clipboard',{configurable:true,value:{writeText:copy}})
  render(<TaskPackDialog scope={scope} ids={[7]} write={fn=>fn(scope)} onChanged={()=>{}} onClose={()=>{}}/>)
  await screen.findByText('任务文本');fireEvent.click(screen.getByLabelText('仅原文（排除 AI 资产，取非 AI 版本）'))
  expect((screen.getByRole('button',{name:'复制任务包'}) as HTMLButtonElement).disabled).toBe(true)
  await waitFor(()=>expect(exported).toHaveBeenCalledOnce())
  resolveOriginal({result:{content:JSON.stringify({assets:[{code:'a',storageType:'inline_text',content:'原始\n\n'}]})}})
  await waitFor(()=>expect((screen.getByRole('button',{name:'复制任务包'}) as HTMLButtonElement).disabled).toBe(false))
  fireEvent.click(screen.getByRole('button',{name:'复制任务包'}));await screen.findByText(/复制失败：denied/);expect(usage).not.toHaveBeenCalled()
  fireEvent.click(screen.getByRole('button',{name:'复制任务包'}));await waitFor(()=>expect(usage).toHaveBeenCalledWith({...scope,assetIds:[7]}));expect(copy.mock.calls[1][0]).toContain('原始\n\n');expect(copy.mock.calls[1][0]).not.toContain('当前 AI 文本');expect(get).toHaveBeenCalledOnce()
  get.mockRestore();usage.mockRestore();exported.mockRestore()
})
it('移出选择后迟到的旧原文响应不能解锁复制或污染剩余资产',async()=>{
  const scope={workspaceId:'test',spaceEpoch:'test#1'},pending:Array<(value:unknown)=>void>=[]
  vi.spyOn(assetsApi,'get').mockImplementation(async({assetId})=>({asset:{id:assetId,code:`a${assetId}`,name:`文本${assetId}`,kind:null,storageType:'inline_text',currentContent:'当前',revision:1,currentVersionId:1,sourceJson:'{}',tags:[],notes:'',sourceTask:''}}) as never)
  vi.spyOn(assetsApi,'exportAssets').mockImplementation(()=>new Promise(resolve=>pending.push(resolve)) as never)
  vi.spyOn(assetsApi,'recordUsage').mockResolvedValue({} as never)
  Object.defineProperty(window,'electronAPI',{configurable:true,value:{getStoreValue:vi.fn().mockResolvedValue(undefined)}})
  const copy=vi.fn().mockResolvedValue(undefined);Object.defineProperty(navigator,'clipboard',{configurable:true,value:{writeText:copy}})
  render(<TaskPackDialog scope={scope} ids={[1,2]} write={fn=>fn(scope)} onChanged={()=>{}} onClose={()=>{}}/>)
  await screen.findByText('文本2');fireEvent.click(screen.getByLabelText('仅原文（排除 AI 资产，取非 AI 版本）'));await waitFor(()=>expect(pending.length).toBe(1))
  fireEvent.click(screen.getAllByRole('button',{name:'移出任务包'})[0]);await waitFor(()=>expect(pending.length).toBe(2))
  pending[0]({result:{content:JSON.stringify({assets:[{code:'a1',storageType:'inline_text',content:'旧1'},{code:'a2',storageType:'inline_text',content:'旧2'}]})}})
  await new Promise(r=>setTimeout(r,0));expect((screen.getByRole('button',{name:'复制任务包'}) as HTMLButtonElement).disabled).toBe(true)
  pending[1]({result:{content:JSON.stringify({assets:[{code:'a2',storageType:'inline_text',content:'新2'}]})}})
  await waitFor(()=>expect((screen.getByRole('button',{name:'复制任务包'}) as HTMLButtonElement).disabled).toBe(false))
  fireEvent.click(screen.getByRole('button',{name:'复制任务包'}));await waitFor(()=>expect(copy).toHaveBeenCalledOnce());expect(copy.mock.calls[0][0]).toContain('新2');expect(copy.mock.calls[0][0]).not.toContain('旧')
})
it('普通原文多行可填，IME不提交；复制失败保留输入且不記使用，CtrlEnter成功后才记录',async()=>{
  const copy=vi.fn().mockRejectedValueOnce(Error('denied')).mockResolvedValue(undefined),record=vi.fn().mockResolvedValue(undefined)
  Object.defineProperty(navigator,'clipboard',{configurable:true,value:{writeText:copy}})
  render(<TemplateFill template={'{{语言:中}}\n{{原文}}'} config={{version:1,variables:{语言:{type:'single',options:['中','英']}}}} onRecord={record} onClose={()=>{}}/>)
  fireEvent.change(screen.getByLabelText('原文'),{target:{value:' 原文\n\n'}})
  const input=screen.getByLabelText('原文');fireEvent.compositionStart(input);fireEvent.keyDown(input,{key:'Enter',ctrlKey:true,keyCode:229});expect(copy).not.toHaveBeenCalled();fireEvent.compositionEnd(input)
  fireEvent.click(screen.getByRole('button',{name:'复制',exact:true}));await screen.findByText('denied');expect(record).not.toHaveBeenCalled();expect((input as HTMLTextAreaElement).value).toBe(' 原文\n\n')
  fireEvent.keyDown(input,{key:'Enter',ctrlKey:true});await waitFor(()=>expect(record).toHaveBeenCalledTimes(1));expect(copy).toHaveBeenLastCalledWith('中\n 原文\n\n')
})
it('阅读预览支持标题/代码/表格，不执行HTML，不产生图片或链接网络入口',()=>{
  render(<SafeMarkdown content={'# 标题\n\n```js\n<script>bad()</script>\n```\n\n| 列 | 值 |\n| --- | --- |\n| A | B |\n\n<img src="https://example.org/x">\n\n![远程](https://example.org/x) [外链](javascript:bad())'}/>)
  expect(screen.getByRole('heading',{name:'标题'})).toBeTruthy();expect(screen.getByRole('table')).toBeTruthy();expect(screen.getByText('B')).toBeTruthy();expect(document.querySelector('img,script,iframe,a[href]')).toBeNull()
})
it('编写引导插入变量不保存资产，已识别变量与格式警告可见',()=>{
  const content=vi.fn(),config=vi.fn()
  render(<TemplateTools content={'{{x:A}} {{:bad}}'} configRaw={'{"version":1,"variables":{}}'} onContent={content} onConfig={config}/>)
  fireEvent.change(screen.getByLabelText('变量名称'),{target:{value:'原文'}});fireEvent.click(screen.getByRole('button',{name:'插入变量'}));expect(content).toHaveBeenCalledWith('{{x:A}} {{:bad}}{{原文}}')
  expect(screen.getByText(/1 个格式警告/)).toBeTruthy();expect(screen.getByLabelText('x 输入类型')).toBeTruthy()
})
