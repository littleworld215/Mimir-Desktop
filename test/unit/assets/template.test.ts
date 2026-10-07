import { it, expect } from 'vitest'
import oracle from '../../fixtures/assets/i4-source-oracle.json'
import { parseVariables, renderTemplate, buildFinalPrompt, initialTemplateValues, renderConfiguredTemplate, variableControls } from '../../../src/lib/assets/template'
import {textBuilder} from '../../../src/lib/assets/textBudget'

it('旧语法解析/首次默认值/非法占位符与冻结来源一致', () => {
  for (const item of oracle.templates) {
    expect(parseVariables(item.input)).toEqual(item.parsed)
    expect(renderTemplate(item.input, item.values)).toBe(item.rendered)
    expect(buildFinalPrompt(item.input, item.values, ' x\r\n\n')).toBe(item.final)
  }
})
it('缺值按各占位符默认、填值表单用首次默认；空值与原文多行不折叠', () => {
  expect(renderTemplate('{{x:A}}/{{x:B}}', {})).toBe('A/B')
  expect(initialTemplateValues('{{x:A}}/{{x:B}}')).toEqual({x:'A'})
  expect(renderTemplate('{{x:A}}/{{x:B}}', {x:''})).toBe('/')
  expect(renderTemplate('{{原文}}', {原文:' \r\n\n'})).toBe(' \r\n\n')
  expect(variableControls('{{原文}}')).toEqual([{name:'原文',defaultValue:'',type:'textarea',options:[]}])
})
it('原型名是旧语法字面变量，继承值不读取、不污染原型', () => {
  const template='{{constructor}} {{__proto__}} {{toString}}'
  const values=initialTemplateValues(template)
  expect(Object.getPrototypeOf(values)).toBe(null)
  expect(renderTemplate(template, {})).toBe('  ')
  values.__proto__='literal'
  expect(renderTemplate(template,values)).toBe(' literal ')
  expect({}).not.toHaveProperty('literal')
})
it('单选/多选配置与来源一致，连接符含空串，未配置旧变量不变', () => {
  const config={version:1 as const,variables:{语言:{type:'single' as const,options:['中','英']},格式:{type:'multi' as const,options:['表','段'],separator:'\n'},原文:{type:'textarea' as const}}}
  const template='{{语言:中}} {{格式:表}} {{原文}} {{旧:默认}}'
  expect(initialTemplateValues(template,config)).toEqual(oracle.configured.initial)
  const values={语言:'英',格式:['段','表'],原文:'\r\n'}
  expect(renderConfiguredTemplate(template,values,config)).toBe(oracle.configured.rendered)
  expect(renderConfiguredTemplate('{{格式}}',{格式:['表','段']},{...config,variables:{格式:{type:'multi',options:['表','段'],separator:''}}})).toBe('表段')
  expect(variableControls(template,config).map(v=>v.type)).toEqual(['single','multi','textarea','text'])
})
it('坏配置不改变旧模板，返回控件/默认值独立，警告不改原文', () => {
  for(const config of [null,{version:2,variables:{}},{version:1,variables:{x:{type:'multi',options:[]}}},JSON.parse('{"version":1,"variables":{"__proto__":{"type":"text"}}}')])expect(renderConfiguredTemplate('{{x:A}}',{x:['B','C']},config)).toBe('B、C')
  const config={version:1,variables:{x:{type:'single',options:['A','B']}}}
  const controls=variableControls('{{x:A}} {{:bad}}',config);controls[0].options.push('mutation')
  expect(config.variables.x.options).toEqual(['A','B'])
  expect(parseVariables('{{x:A}} {{:bad}}').invalid).toBe(1)
})
it('变量展开按最终UTF8预算拒绝超限，不把多次重复值截断；未配变量的默认值也计入',()=>{
  expect(renderTemplate('{{x}}/{{x}}',{x:'中😀'},15)).toBe('中😀/中😀')
  expect(()=>renderTemplate('{{x}}/{{x}}',{x:'中😀'},14)).toThrow('预算')
  expect(()=>renderTemplate('{{x:中😀}}',{},6)).toThrow('预算')
  expect(()=>renderTemplate('',{},NaN)).toThrow('预算')
})
it('跨片段的UTF16代理对按最终UTF8计数，未配对字符仍计替代字符字节',()=>{
  expect(renderTemplate('a{{x}}{{y}}',{x:'\ud83d',y:'\ude00'},5)).toBe('a😀')
  const b=textBuilder(6);b.append('ab\ud83d');b.append('');b.append('\ude00');expect(b.finish()).toBe('ab😀')
  const lone=textBuilder(2);lone.append('\ud83d');expect(()=>lone.finish()).toThrow('预算')
})
it('不同Unicode切片的预算与TextEncoder最终编码逐例一致',()=>{
  const units=['a','中','\ud83d','\ude00','\ud800','\udfff','\u0080','']
  let seed=12345
  const random=()=>{seed=(Math.imul(seed,1664525)+1013904223)>>>0;return seed}
  for(let i=0;i<1000;i++){
    const chunks=Array.from({length:1+random()%12},()=>units[random()%units.length]+units[random()%units.length])
    const text=chunks.join(''),size=new TextEncoder().encode(text).length,b=textBuilder(Math.max(1,size))
    for(const chunk of chunks)b.append(chunk)
    expect(b.finish()).toBe(text)
    if(size>1)expect(()=>{const small=textBuilder(size-1);for(const chunk of chunks)small.append(chunk);small.finish()}).toThrow('预算')
  }
})
