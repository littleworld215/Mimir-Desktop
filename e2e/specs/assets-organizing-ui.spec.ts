import {test,expect} from '@playwright/test'
import {launchApp} from '../fixtures/launch'
import {gotoModule} from '../helpers/nav'
test('真实整理流程：折叠、标签搜索、条件单项移除、收藏与更新时间',async({},testInfo)=>{
 const launched=await launchApp({executablePath:process.env.MIMIR_E2E_PACKAGED});const {page}=launched
 try{
  await gotoModule(page,'assets')
  await page.evaluate(async()=>{
   const api=window.electronAPI!.assets,c=await api.context();if(!c.ok)throw Error(c.message)
   for(const input of [{code:'org-parent',name:'整理父分类'},{code:'org-child',name:'整理子分类',parentCode:'org-parent'}]){
    const r=await api.createCategory({...c.context,input});if(!r.ok)throw Error(r.message)
   }
   const r=await api.create({...c.context,input:{name:'整理验证资料',category:'org-child',storageType:'inline_text',content:'合成正文',tagNames:['方法','证据']}});if(!r.ok)throw Error(r.message)
   const f=await api.setFavorite({...c.context,assetId:r.asset.id,favorite:true});if(!f.ok)throw Error(f.message)
  })
  await page.getByRole('button',{name:'刷新',exact:true}).click()
  await page.getByRole('button',{name:'折叠分类 整理父分类',exact:true}).click()
  await expect(page.getByRole('button',{name:/^整理子分类/})).toHaveCount(0)
  await page.getByRole('button',{name:'展开分类 整理父分类',exact:true}).press('Enter')
  await page.getByRole('button',{name:/^整理子分类/}).click()
  await expect(page.getByRole('button',{name:'移除筛选 分类：整理子分类'})).toBeVisible()
  await page.getByText('更多筛选',{exact:true}).click()
  await page.getByLabel('包含标签 方法',{exact:true}).check()
  await page.getByLabel('搜索筛选标签').fill('证据')
  await expect(page.getByLabel('包含标签 方法',{exact:true})).toBeVisible()
  await expect(page.getByLabel('包含标签 证据',{exact:true})).toBeVisible()
  await page.getByRole('button',{name:'移除筛选 包含标签：方法'}).click()
  await expect(page.getByRole('button',{name:'移除筛选 分类：整理子分类'})).toBeVisible()
  await expect(page.getByLabel('资产列表').getByLabel('已收藏')).toBeVisible()
  await expect(page.getByLabel('资产列表')).toContainText('更新：')
  await page.evaluate(()=>document.documentElement.classList.add('dark'))
  await page.screenshot({path:testInfo.outputPath('organization-dark.png')})
 }finally{await launched.cleanup()}
})
test('窄窗200码点筛选芯片保持容器边界，完整条件可访问',async({},testInfo)=>{
 const launched=await launchApp({executablePath:process.env.MIMIR_E2E_PACKAGED});const {page,app}=launched
 try{
  await app.evaluate(({BrowserWindow})=>{BrowserWindow.getAllWindows()[0]!.setSize(900,760)})
  await gotoModule(page,'assets')
  const q='😀'.repeat(200)
  await page.getByLabel('检索资产',{exact:true}).fill(q)
  await page.getByLabel('检索资产',{exact:true}).press('Enter')
  const chip=page.getByRole('button',{name:'移除筛选 检索：'+q})
  await expect(chip).toBeVisible()
  const dimensions=await page.getByLabel('已选筛选条件').evaluate(el=>({container:el.getBoundingClientRect().width,button:el.querySelector('button')!.getBoundingClientRect().width}))
  await testInfo.attach('narrow-filter-dimensions',{body:JSON.stringify(dimensions),contentType:'application/json'})
  await page.screenshot({path:testInfo.outputPath('narrow-filter.png')})
  expect(dimensions.button).toBeLessThanOrEqual(dimensions.container+1)
  await chip.press('Enter')
  await expect(page.getByLabel('检索资产',{exact:true})).toHaveValue('')
 }finally{await launched.cleanup()}
})
