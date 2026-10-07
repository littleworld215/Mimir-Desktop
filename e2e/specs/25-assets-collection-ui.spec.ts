import {test,expect} from '@playwright/test'
import {readFileSync,writeFileSync} from 'node:fs'
import {join} from 'node:path'
import {launchApp} from '../fixtures/launch'
import {gotoModule} from '../helpers/nav'
for(const runtime of ['development',...(process.env.MIMIR_E2E_PACKAGED?['packaged']:[])]) {
test(`real Electron favorites/recent, saved filters, quick clipboard/file/link and native cancellation (${runtime})`,async()=>{
  const launched=await launchApp(runtime==='packaged'?{executablePath:process.env.MIMIR_E2E_PACKAGED}:{}),{page,app}=launched
  try{
    await gotoModule(page,'assets')
    const input=join(launched.tempHome.root,'take-input.txt'),output=join(launched.tempHome.root,'take-output.txt')
    writeFileSync(input,'文件原文\r\n')
    await app.evaluate(({dialog},p)=>{dialog.showOpenDialog=async()=>({canceled:false,filePaths:[p]})},input)
    const ids=await page.evaluate(async()=>{
      const api=window.electronAPI!.assets,c=await api.context();if(!c.ok)throw Error(c.message)
      const ids:number[]=[]
      for(const input of [{name:'快速原文',code:'quick-text',category:'inbox',storageType:'inline_text' as const,content:' 空白\r\n\n'},{name:'快速链接',code:'quick-link',category:'inbox',storageType:'external_link' as const,externalUrl:'https://example.org/research'},{name:'快速文件',code:'quick-file',category:'inbox',storageType:'file' as const}]){
        const a=await api.create({...c.context,input});if(!a.ok)throw Error(a.message);ids.push(a.asset.id);const f=await api.setFavorite({...c.context,assetId:a.asset.id,favorite:true});if(!f.ok)throw Error(f.message)
      }
      const selected=await window.electronAPI!.showOpenDialog({properties:['openFile']}) as {filePaths:string[]}
      const detail=await api.get({...c.context,assetId:ids[2]});if(!detail.ok)throw Error(detail.message)
      const imported=await api.importFile({...c.context,assetId:ids[2],expectedRevision:detail.asset.revision,sourcePath:selected.filePaths[0]});if(!imported.ok)throw Error(imported.message)
      return ids
    })
    await page.getByRole('button',{name:'刷新',exact:true}).click()
    await page.getByLabel('取用范围').selectOption('favorites')
    await expect(page.getByLabel('资产列表')).toContainText('共 3 条资产')
    await page.getByRole('button',{name:'保存筛选',exact:true}).click()
    await page.getByLabel('筛选名称').fill('个人收藏')
    await page.getByRole('button',{name:'保存当前条件'}).click()
    await expect(page.getByRole('button',{name:'应用 个人收藏'})).toBeEnabled()
    await page.getByRole('button',{name:'应用 个人收藏'}).click()
    expect(await page.evaluate(()=>JSON.parse(new URL(location.href).searchParams.get('assetQuery')!).view)).toBe('favorites')
    const trigger=page.getByRole('button',{name:'快速取用（Ctrl/Cmd+Shift+K）'})
    await trigger.focus();await page.keyboard.press('Control+Shift+K')
    await page.getByRole('button',{name:'快速原文 · inline_text',exact:true}).click()
    await page.getByRole('button',{name:'复制并关闭'}).click()
    await expect(page.getByRole('dialog')).toHaveCount(0)
    const clipboardText=await app.evaluate(({clipboard})=>clipboard.readText())
    console.log('Native clipboard newline representation:',JSON.stringify(clipboardText))
    // Windows clipboard may normalize LF to CRLF; renderer writeText is checked byte-for-byte in DOM tests.
    expect(clipboardText.replace(/\r\n/g,'\n')).toBe(' 空白\n\n')
    const original=await page.evaluate(async id=>{const a=window.electronAPI!.assets,c=await a.context();if(!c.ok)throw Error(c.message);return a.get({...c.context,assetId:id})},ids[0])
    expect(original).toMatchObject({ok:true,asset:{currentContent:' 空白\r\n\n',revision:1,versionCount:1}})
    await expect(trigger).toBeFocused()
    await page.getByLabel('取用范围').selectOption('recent');await expect(page.getByLabel('资产列表')).toContainText('共 1 条资产')
    await trigger.click();await page.getByRole('button',{name:'快速链接 · external_link',exact:true}).click();await page.getByRole('button',{name:'复制',exact:true}).click()
    await expect(page.getByRole('status').filter({hasText:'取用成功。'})).toBeVisible();expect(await app.evaluate(({clipboard})=>clipboard.readText())).toBe('https://example.org/research')
    await page.keyboard.press('Escape');await expect(page.getByLabel('快速取用结果')).toBeVisible()
    await page.getByRole('button',{name:'快速文件 · file',exact:true}).click()
    await app.evaluate(({dialog})=>{dialog.showSaveDialog=async()=>({canceled:true,filePath:undefined})})
    await page.getByRole('button',{name:'下载',exact:true}).click()
    await expect(page.getByRole('button',{name:'下载',exact:true})).toBeEnabled()
    const used=await page.evaluate(async id=>{const a=window.electronAPI!.assets,c=await a.context();if(!c.ok)throw Error(c.message);return a.get({...c.context,assetId:id})},ids[2])
    expect(used).toMatchObject({ok:true,asset:{lastUsedAt:null}})
    await app.evaluate(({dialog},p)=>{dialog.showSaveDialog=async()=>({canceled:false,filePath:p})},output)
    await page.getByRole('button',{name:'下载并关闭'}).click();await expect(page.getByRole('dialog')).toHaveCount(0);expect(readFileSync(output,'utf8')).toBe('文件原文\r\n')
    await page.getByRole('button',{name:'刷新',exact:true}).click();await expect(page.getByLabel('资产列表')).toContainText('共 3 条资产')
    const exported=await page.evaluate(async()=>{const a=window.electronAPI!.assets,c=await a.context();if(!c.ok)throw Error(c.message);return a.exportAssets({...c.context,query:{view:'recent'}})})
    expect(exported).toMatchObject({ok:true,result:{count:3}})
    await page.screenshot({path:'../../.git/codex-integration/i4-02-native-ui.png'})
  }finally{await launched.cleanup()}
})
}
