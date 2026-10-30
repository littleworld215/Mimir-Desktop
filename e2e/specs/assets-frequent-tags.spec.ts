import {test,expect} from '@playwright/test'
import {launchApp} from '../fixtures/launch'
import {gotoModule} from '../helpers/nav'
import {seedResearchWorkflow} from '../fixtures/researchWorkflow'
import {reopenEvidenceApp} from '../fixtures/libraryEvidence'

test('常用标签真实设定、重启、重命名失效和双空间隔离',async({},info)=>{
 const ctx=await launchApp({executablePath:process.env.MIMIR_E2E_PACKAGED,transformSeed:seed=>seedResearchWorkflow(seed).seed})
 let reopened:Awaited<ReturnType<typeof reopenEvidenceApp>>|undefined
 try{
  let page=ctx.page
  await gotoModule(page,'assets')
  await page.getByRole('button',{name:'标签管理',exact:true}).click()
  let manager=page.getByRole('dialog',{name:'标签管理',exact:true})
  await manager.getByLabel('新标签名称',{exact:true}).fill('合成常用方法')
  await manager.getByRole('button',{name:'创建标签',exact:true}).click()
  await expect(manager.getByRole('button',{name:'合成常用方法',exact:true})).toBeVisible()
  await manager.getByRole('button',{name:'Close',exact:true}).click()
  let frequent=page.getByRole('region',{name:'常用标签',exact:true})
  await frequent.getByText('管理常用标签',{exact:true}).click()
  await frequent.getByLabel('设为常用的标签',{exact:true}).selectOption({label:'合成常用方法'})
  await frequent.getByRole('button',{name:'添加常用标签',exact:true}).click()
  await frequent.getByRole('button',{name:'常用标签 合成常用方法',exact:true}).press('Enter')
  await expect(page.getByRole('button',{name:'移除筛选 包含标签：合成常用方法',exact:true})).toBeVisible()
  reopened=await reopenEvidenceApp(ctx);page=reopened.page
  await gotoModule(page,'assets')
  frequent=page.getByRole('region',{name:'常用标签',exact:true})
  await expect(frequent.getByRole('button',{name:'常用标签 合成常用方法',exact:true})).toBeVisible()
  await page.getByRole('button',{name:'标签管理',exact:true}).click()
  manager=page.getByRole('dialog',{name:'标签管理',exact:true})
  await manager.getByRole('button',{name:'合成常用方法',exact:true}).click()
  await manager.getByLabel('标签新名称',{exact:true}).fill('重命名常用方法')
  await manager.getByRole('button',{name:'保存标签名称',exact:true}).click()
  await expect(manager.getByRole('button',{name:'重命名常用方法',exact:true})).toBeVisible()
  await manager.getByRole('button',{name:'Close',exact:true}).click()
  await expect(frequent.getByRole('button',{name:'常用标签 重命名常用方法',exact:true})).toBeVisible()
  await page.getByTitle('切换科研空间').click()
  await page.getByRole('button',{name:'闭环第二空间',exact:true}).click()
  await expect(frequent.getByRole('button',{name:'常用标签 重命名常用方法',exact:true})).toHaveCount(0)
  await page.getByTitle('切换科研空间').click()
  await page.getByRole('button',{name:'科研空间',exact:true}).click()
  await expect(frequent.getByRole('button',{name:'常用标签 重命名常用方法',exact:true})).toBeVisible()
  await reopened.app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0]!.setSize(920,720))
  for(const dark of [false,true]){await page.evaluate(value=>document.documentElement.classList.toggle('dark',value),dark);await page.screenshot({path:info.outputPath(dark?'frequent-dark.png':'frequent-light.png')})}
  await page.getByRole('button',{name:'标签管理',exact:true}).click()
  manager=page.getByRole('dialog',{name:'标签管理',exact:true})
  await manager.getByRole('button',{name:'重命名常用方法',exact:true}).click()
  await manager.getByRole('button',{name:'读取治理影响',exact:true}).click()
  await manager.getByLabel('确认上述标签影响',{exact:true}).check()
  await manager.getByRole('button',{name:'删除标签',exact:true}).click()
  await expect(manager.getByRole('button',{name:'重命名常用方法',exact:true})).toHaveCount(0)
  await manager.getByRole('button',{name:'Close',exact:true}).click()
  const missing=frequent.getByRole('button',{name:/^常用标签 已失效标签 #\d+$/})
  await expect(missing).toBeDisabled()
  await frequent.getByRole('button',{name:/^取消常用标签 已失效标签 #\d+$/}).click()
  await expect(missing).toHaveCount(0)
 }finally{if(reopened)await reopened.app.close();await ctx.cleanup()}
})
