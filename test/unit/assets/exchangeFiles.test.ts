import Database from 'better-sqlite3'
import * as fs from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeEach, afterEach, it, expect, vi } from 'vitest'
import { AssetsStoreManager } from '../../../electron/assets/store'
import type { AssetsContext } from '../../../electron/assets/types'
import { readExchangeFile, saveExchange } from '../../../electron/assets/exchangeFiles'
vi.mock('node:fs',async()=>({...await vi.importActual<typeof import('node:fs')>('node:fs')}))
let root:string,manager:AssetsStoreManager,ctx:AssetsContext
beforeEach(async()=>{root=fs.mkdtempSync(join(tmpdir(),'assets-exchange-files-'));manager=new AssetsStoreManager({active:()=>({id:'A',path:root}),epoch:()=> 'A#1'},(p,o)=>new Database(p,o));ctx=await manager.getForRequest(manager.context())})
afterEach(async()=>{vi.restoreAllMocks();await manager.close();fs.rmSync(root,{recursive:true,force:true})})
it('真实UTF8读写保持内容；已有目标拒绝覆盖，数据库不变',()=>{
  const input=join(root,'源.json'),out=join(root,'导出.json');fs.writeFileSync(input,'["中文\n正文"]')
  expect(readExchangeFile(ctx,input).raw).toBe('["中文\n正文"]')
  const before=ctx.write(s=>s.all('SELECT * FROM asset'))
  expect(saveExchange(ctx,{format:'json'},out)).toMatchObject({saved:true,count:0})
  const bytes=fs.readFileSync(out);expect(()=>saveExchange(ctx,{format:'json'},out)).toThrow(/已存在/)
  expect(fs.readFileSync(out)).toEqual(bytes);expect(ctx.write(s=>s.all('SELECT * FROM asset'))).toEqual(before)
})
it('链接与超过200MiB文件拒绝读取；失败描述符关闭',()=>{
  const input=join(root,'large.json');const fd=fs.openSync(input,'w');fs.ftruncateSync(fd,200*1024*1024+1);fs.closeSync(fd)
  const close=vi.spyOn(fs,'closeSync');expect(()=>readExchangeFile(ctx,input)).toThrow(/200MiB/);expect(close).toHaveBeenCalledTimes(1)
  const link=join(root,'linked');fs.symlinkSync(root,link,'junction');expect(()=>readExchangeFile(ctx,join(link,'large.json'))).toThrow()
})
it('写入故障清理自有文件并关闭描述符；fstat故障也必须关闭',()=>{
  const out=join(root,'failed.json'),close=vi.spyOn(fs,'closeSync')
  vi.spyOn(fs,'writeFileSync').mockImplementationOnce(()=>{throw new Error('disk fault')})
  expect(()=>saveExchange(ctx,{format:'json'},out)).toThrow('disk fault');expect(fs.existsSync(out)).toBe(false);expect(close).toHaveBeenCalledTimes(1)
  close.mockClear();vi.spyOn(fs,'fstatSync').mockImplementationOnce(()=>{throw new Error('stat fault')})
  expect(()=>saveExchange(ctx,{format:'json'},join(root,'stat.json'))).toThrow('stat fault');expect(close).toHaveBeenCalledTimes(1)
})
