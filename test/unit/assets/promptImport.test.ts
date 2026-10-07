import { it, expect } from 'vitest'
import { adaptPromptImport } from '../../../electron/assets/promptImport'
const prompt={id:'外部标识'.repeat(30),title:'模板',body:'  {{语言=[中|英]}} {{要求+=[准确|简洁]~\\n}} {{文本=默认}}\n',tags:['科研'],folder:'中文领域',favorite:true,pinned:true,useCount:3}
const request=(convertVariables=true)=>({raw:JSON.stringify({format:'promptdock',version:1,prompts:[prompt]}),convertVariables})
it('显式适配显示转换前后/配置；长外部ID稳定映射，不导入置顶或执行内容',()=>{
  const a=adaptPromptImport(request()),b=adaptPromptImport(request())
  expect(a.raw).toBe(b.raw)
  const asset=JSON.parse(a.raw).assets[0]
  expect(asset.code.length).toBeLessThanOrEqual(100);expect(asset.code).toMatch(/^[a-z0-9]+(?:-[a-z0-9]+)*$/)
  expect(asset.content).toBe('  {{语言:中}} {{要求}} {{文本:默认}}\n')
  expect(asset.templateConfig.variables).toMatchObject({语言:{type:'single',options:['中','英']},要求:{type:'multi',separator:'\n'},文本:{type:'text'}})
  expect(a.changes[0]).toMatchObject({before:prompt.body,after:asset.content})
  expect(JSON.parse(asset.sourceJson)).toMatchObject({externalId:prompt.id,format:'promptdock'})
  expect(asset.categoryPath).toEqual(['中文领域'])
})
it('原样保留不重新解释变量，重复/未知格式/冲突声明与危险变量拒绝转换',()=>{
  expect(JSON.parse(adaptPromptImport(request(false)).raw).assets[0].content).toBe(prompt.body)
  for(const raw of [JSON.stringify({format:'unknown',version:1,prompts:[prompt]}),JSON.stringify({format:'promptdeck',version:1,prompts:[prompt,prompt]})])expect(()=>adaptPromptImport({raw,convertVariables:false})).toThrow()
  const bad={...prompt,body:'{{语言=[中|英]}} {{语言=[英|中]}}'}
  expect(()=>adaptPromptImport({raw:JSON.stringify({format:'promptdeck',version:1,prompts:[bad]}),convertVariables:true})).toThrow()
})
