import {it,expect} from 'vitest'
import {assetQueryUrl,readAssetQuery} from '../../../src/components/modules/assets/assetQueryUrl'
it('URL完整筛选包含取用范围与最近排序；不保存选择，保留其它模块路由',()=>{
  const query={view:'recent' as const,sort:'recent' as const,q:'科研 &',tagIds:[2],excludeTagIds:[3],kind:null,page:2,ids:[99]}
  const url=assetQueryUrl('file:///app/index.html?other=1#assets',query)
  expect(readAssetQuery(url)).toMatchObject({view:'recent',sort:'recent',q:'科研 &',tagIds:[2],excludeTagIds:[3],kind:null,page:2})
  expect(readAssetQuery(url)).not.toHaveProperty('ids');expect(new URL(url).hash).toBe('#assets');expect(new URL(url).searchParams.get('other')).toBe('1')
})
it('坏URL/非对象/null分页/未知字段不执行且恢复默认',()=>{
  for(const value of ['{bad','[]','null','{"page":null}','{"pageSize":201}','{"secret":1}'])expect(readAssetQuery(`https://local/?assetQuery=${encodeURIComponent(value)}`)).toEqual({page:1,pageSize:30,archived:'exclude'})
})
it('URL已知键仍须校验类型/枚举/日期，错误标签数组不能进入组件',()=>{
  for(const value of [{tagIds:1},{excludeTagIds:[null]},{q:{}},{sort:'bad'},{view:null},{category:[]},{kind:1},{updatedAfter:'2026-02-29'}])expect(readAssetQuery(`https://local/?assetQuery=${encodeURIComponent(JSON.stringify(value))}`)).toEqual({page:1,pageSize:30,archived:'exclude'})
})
