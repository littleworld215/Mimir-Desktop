/** File capabilities are checked by IPC; descriptors bound reads, and exclusive writes never replace existing files. */
import { closeSync, fstatSync, fsyncSync, lstatSync, openSync, readSync, realpathSync, unlinkSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { ASSET_TRANSFER_MAX_BYTES } from '../../shared/assetsContracts'
import { AssetsStoreError, type AssetsContext } from './types'
import { sourceIsLink } from './fileService'
import { exportAssets } from './exchangeExport'

export function readExchangeFile(ctx:AssetsContext,path:string): {raw:string} {
  ctx.assertCurrent()
  const full=resolve(path),meta=lstatSync(full)
  if(sourceIsLink(meta,full,realpathSync(full))||!meta.isFile())throw new AssetsStoreError('PATH_REJECTED','请选择普通JSON文件，不能使用链接。')
  const fd=openSync(full,'r')
  try {
    const initial=fstatSync(fd)
    if(!initial.isFile()||initial.dev!==meta.dev||initial.ino!==meta.ino)throw new AssetsStoreError('PATH_REJECTED','所选文件已变化。')
    if(initial.size>ASSET_TRANSFER_MAX_BYTES)throw new AssetsStoreError('BAD_REQUEST','JSON超过200MiB。')
    const chunks:Buffer[]=[],buffer=Buffer.alloc(64*1024)
    let bytes=0,n:number
    while((n=readSync(fd,buffer,0,buffer.length,null))>0){bytes+=n;if(bytes>ASSET_TRANSFER_MAX_BYTES)throw new AssetsStoreError('BAD_REQUEST','JSON超过200MiB。');chunks.push(Buffer.from(buffer.subarray(0,n)))}
    ctx.assertCurrent()
    return {raw:Buffer.concat(chunks).toString('utf8')}
  } finally {closeSync(fd)}
}
export function saveExchange(ctx:AssetsContext,input:unknown,path:string): {saved:true;count:number} {
  const output=exportAssets(ctx,input)
  ctx.assertCurrent()
  let fd:number
  try {fd=openSync(path,'wx')} catch(error){if((error as NodeJS.ErrnoException).code==='EEXIST')throw new AssetsStoreError('FILE_EXISTS','目标文件已存在，请选择新路径。');throw error}
  let own:ReturnType<typeof fstatSync>|undefined
  try {own=fstatSync(fd);writeFileSync(fd,output.content,'utf8');fsyncSync(fd);ctx.assertCurrent();return {saved:true,count:output.count}}
  catch(error){try{const current=lstatSync(path);if(own&&current.dev===own.dev&&current.ino===own.ino)unlinkSync(path)}catch{/* 原错误保留，不能删除不属于本操作的文件。 */}throw error}
  finally {closeSync(fd)}
}
