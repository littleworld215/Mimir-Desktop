import { test, expect } from '@playwright/test'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { launchApp } from '../fixtures/launch'
import { gotoModule } from '../helpers/nav'
const runtimes=[{name:'development',executablePath:undefined as string|undefined},...(process.env.MIMIR_E2E_PACKAGED?[{name:'packaged',executablePath:resolve(process.env.MIMIR_E2E_PACKAGED)}]:[])]
for(const runtime of runtimes)test(`${runtime.name}: exchange UI, batch metadata, native file grants and folder queue`,async()=>{
  const launched=await launchApp({executablePath:runtime.executablePath}),{page,app}=launched
  try{
    await gotoModule(page,'assets')
    await page.evaluate(async()=>{const api=window.electronAPI!.assets,c=await api.context();if(!c.ok)throw Error(c.message);const a=await api.create({...c.context,input:{name:'交换原文',code:'exchange-ui',category:'inbox',storageType:'inline_text',content:' 空白\r\n\n'}});if(!a.ok)throw Error(a.message)})
    await page.getByRole('button',{name:'刷新',exact:true}).click()
    await page.getByLabel('选择交换原文',{exact:true}).check()
    await page.getByRole('button',{name:'批量整理',exact:true}).click()
    await page.getByLabel('新增标签（逗号分隔）').fill('整合验收')
    await page.getByRole('button',{name:'预览批量影响'}).click()
    await expect(page.getByLabel('批量影响')).toContainText('将修改 1 项')
    await page.getByRole('button',{name:'确认批量修改'}).click()
    await expect(page.getByRole('dialog')).toHaveCount(0)
    await page.getByLabel('选择交换原文',{exact:true}).check()
    const out=join(launched.tempHome.root,'exchange.json'),folder=join(launched.tempHome.root,'collection')
    mkdirSync(folder);writeFileSync(join(folder,'中文.txt'),'文件字节\r\n')
    await app.evaluate(({dialog},p)=>{dialog.showSaveDialog=async()=>({canceled:false,filePath:p.out});dialog.showOpenDialog=async()=>({canceled:false,filePaths:[p.folder]})},{out,folder})
    await page.getByRole('button',{name:'导出',exact:true}).click()
    await page.getByRole('button',{name:'保存导出'}).click()
    await expect(page.getByRole('status')).toContainText('已导出 1 项')
    const doc=JSON.parse(readFileSync(out,'utf8'));expect(doc.assets[0]).toMatchObject({name:'交换原文',content:' 空白\r\n\n',tags:[{name:'整合验收'}]})
    await page.getByRole('button',{name:'保存导出'}).click();await expect(page.getByRole('alert')).toContainText(/已存在|新路径/)
    expect(JSON.parse(readFileSync(out,'utf8'))).toEqual(doc)
    await page.getByRole('button',{name:'关闭',exact:true}).click()
    await page.getByRole('button',{name:'导入JSON',exact:true}).click()
    await page.getByLabel('JSON内容').fill(JSON.stringify(doc));await page.getByLabel('冲突策略').selectOption('copy')
    await page.getByRole('button',{name:'预览差异'}).click();await expect(page.getByLabel('导入差异')).toContainText('新增 1')
    await page.getByRole('button',{name:'确认导入'}).click();await expect(page.getByRole('dialog')).toHaveCount(0)
    await page.getByRole('button',{name:'导入文件夹',exact:true}).click()
    await page.getByRole('button',{name:'选择文件夹并扫描'}).click();await expect(page.getByLabel('文件导入队列')).toContainText('0 / 1')
    await page.getByRole('button',{name:'开始／继续'}).click();await expect(page.getByLabel('文件导入队列')).toContainText('成功 1')
    await page.getByRole('button',{name:'取消队列并关闭'}).click();await expect(page.getByRole('dialog')).toHaveCount(0)
    const result=await page.evaluate(async()=>{const api=window.electronAPI!.assets,c=await api.context();if(!c.ok)throw Error(c.message);const list=await api.list(c.context);const denied=await api.scanFolder({...c.context,folderPath:'C:/unselected-synthetic-folder'});return{list,denied}})
    expect(result.list).toMatchObject({ok:true,page:{total:3}});expect(result.denied).toMatchObject({ok:false,code:'PATH_REJECTED'})
    await page.screenshot({path:`../../.git/codex-integration/i3-ui-${runtime.name}.png`})
  }finally{await launched.cleanup()}
})
