import {it,expect,vi} from 'vitest'
import oracle from '../../fixtures/assets/i4-source-oracle.json'
import {DEFAULT_TASK_PACK_TEMPLATE,normalizeTaskPackTemplate,buildTaskPack,copyTaskPack,selectOriginalContent,type TaskPackAsset} from '../../../src/lib/assets/bundleTemplate'

const asset=(id:number,patch:Partial<TaskPackAsset>={}):TaskPackAsset=>({id,name:`资产${id}`,kind:null,storageType:'inline_text',currentContent:' 原文\r\n\n',externalUrl:null,currentFileName:null,description:'',sourceTask:'任务',notes:'备注',sourceJson:'{}',tags:[{name:'标签'}],...patch})
it('默认组合正文与来源逐字一致，五分节及三形态保留',()=>{
  const assets=[asset(1,{kind:'rule'}),asset(2,{kind:'thought'}),asset(3,{kind:'file',storageType:'file',currentFileName:'数据.csv',description:'附件'}),asset(4,{kind:'prompt',storageType:'external_link',externalUrl:'https://example.org'}),asset(5)]
  expect(buildTaskPack(assets).text).toBe(oracle.bundle)
  expect(buildTaskPack(assets).assetIds).toEqual([2,1,4,3,5])
})
it('配置节序/标题与开关，资产在节内按选择顺序，去重取首项',()=>{
  const template=normalizeTaskPackTemplate({includeHeader:false,includeSource:false,includeNotes:false,includeTags:true,sections:[{key:'ordinary',title:' 我的材料 '},{key:'rule',title:'规范'}]})
  const result=buildTaskPack([asset(3),asset(1,{kind:'rule'}),asset(2),asset(3,{name:'重复'})],{template})
  expect(result.assetIds).toEqual([3,2,1]);expect(result.text).toContain('##  我的材料 ');expect(result.text).not.toContain('任务包（');expect(result.text).not.toContain('来源任务');expect(result.text).not.toContain('备注：');expect(result.text).toContain('标签：标签');expect(result.text).not.toContain('重复')
})
it('偏好不完整/重复/非法节安全补齐，不丢资产、不污染默认模板',()=>{
  const template=normalizeTaskPackTemplate({sections:[{key:'rule',title:''},{key:'rule',title:'重复'},null,{key:'unknown'}]})
  expect(template.sections.map(s=>s.key)).toEqual(['rule','thought','prompt','file','ordinary'])
  template.sections[0].title='changed';expect(DEFAULT_TASK_PACK_TEMPLATE.sections[1].title).toBe('规则与约束')
  expect(normalizeTaskPackTemplate(null)).toEqual(DEFAULT_TASK_PACK_TEMPLATE)
})
it('仅原文排除严格布尔AI资产，并使用显式解析原文；无法确定原文不冒充',()=>{
  const assets=[asset(1,{sourceJson:'{"aiGenerated":true}'}),asset(2,{originalContent:'旧原文'}),asset(3,{sourceJson:'{"aiGenerated":"true"}',originalContent:''})]
  const result=buildTaskPack(assets,{ai:'original-only'})
  expect(result.assetIds).toEqual([2,3]);expect(result.excludedIds).toEqual([1]);expect(result.text).toContain('旧原文');expect(result.text).not.toContain(' 原文')
  expect(()=>buildTaskPack([asset(4)],{ai:'original-only'})).toThrow('原文')
})
it('最多500个资产，稀疏/非法ID拒绝；精确UTF8预算包含标题，超限拒绝而非截断',()=>{
  expect(buildTaskPack(Array.from({length:500},(_,i)=>asset(i+1))).assetIds).toHaveLength(500)
  expect(()=>buildTaskPack(Array.from({length:501},(_,i)=>asset(i+1)))).toThrow('500')
  for(const assets of [Array(1),[asset(0)]])expect(()=>buildTaskPack(assets)).toThrow()
  const input=[asset(1,{currentContent:'中😀\r\n'})],text=buildTaskPack(input).text,bytes=new TextEncoder().encode(text).length
  expect(buildTaskPack(input,{maxBytes:bytes}).text).toBe(text)
  expect(()=>buildTaskPack(input,{maxBytes:bytes-1})).toThrow('预算')
  expect(()=>buildTaskPack(input,{maxBytes:NaN})).toThrow()
})
it('复制成功后仅记录完整实际资产ID；失败不记录，记录失败不撤销复制',async()=>{
  const pack=buildTaskPack([asset(1),asset(1),asset(2,{kind:'rule'})]),copy=vi.fn().mockRejectedValueOnce(Error('clipboard')),record=vi.fn()
  await expect(copyTaskPack(pack,copy,record)).rejects.toThrow('clipboard');expect(record).not.toHaveBeenCalled()
  copy.mockResolvedValue(undefined);record.mockRejectedValueOnce(Error('usage'))
  expect(await copyTaskPack(pack,copy,record)).toContain('usage')
  expect(copy).toHaveBeenLastCalledWith(pack.text);expect(record).toHaveBeenCalledWith([2,1])
})
it('原文版本选最高非AI版本；严格布尔、空原文与无原文回退沿用导出规则',()=>{
  expect(selectOriginalContent('current',[{version:3,content:'AI',sourceJson:'{"aiGenerated":true}'},{version:1,content:'old',sourceJson:'{}'},{version:2,content:'',sourceJson:'{"aiGenerated":"true"}'}])).toBe('')
  expect(selectOriginalContent('current',[{version:1,content:'AI',sourceJson:'{"aiGenerated":true}'}])).toBe('current')
  expect(selectOriginalContent('current',[])).toBe('current')
})
it('异步复制期间预览改变不能篡改此次成功事件；空任务包不复制不记录',async()=>{
  const pack=buildTaskPack([asset(1)]),record=vi.fn(),copy=vi.fn()
  await expect(copyTaskPack(buildTaskPack([]),copy,record)).rejects.toThrow('没有');expect(copy).not.toHaveBeenCalled()
  let done!:()=>void
  copy.mockImplementation(()=>new Promise<void>(resolve=>{done=resolve}))
  const result=copyTaskPack(pack,copy,record);pack.assetIds.push(2);pack.text='changed';done();await result
  expect(record).toHaveBeenCalledWith([1]);expect(copy).not.toHaveBeenCalledWith('changed')
})
