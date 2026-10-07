import {it,expect,vi} from 'vitest'
import {takeAndRecord,missingFilterConditions,readPins} from '../../../src/components/modules/assets/assetTake'
it('真实取用失败不记使用；取消不记；记录失败不撤销复制',async()=>{
  const record=vi.fn().mockRejectedValue(new Error('record failed'))
  await expect(takeAndRecord(async()=>{throw new Error('clipboard denied')},record)).rejects.toThrow('clipboard denied')
  expect(record).not.toHaveBeenCalled()
  expect(await takeAndRecord(async()=>false,record)).toBe(null)
  expect(record).not.toHaveBeenCalled()
  expect(await takeAndRecord(async()=>true,record)).toContain('record failed')
  expect(record).toHaveBeenCalledTimes(1)
})
it('保存筛选失效条件可见，浏览器置顶仅接受有限正整数',()=>{
  expect(missingFilterConditions({category:'gone',tagIds:[1],excludeTagIds:[2]},[],[])).toEqual(['分类 gone','标签 #1','标签 #2'])
  expect(readPins('[1,1,0,"2",3]')).toEqual([1,3])
  expect(readPins('{bad')).toEqual([])
  expect(readPins(JSON.stringify(Array.from({length:100},(_,i)=>i+1)))).toHaveLength(20)
})
