import {ASSET_TRANSFER_MAX_BYTES} from '../../../shared/assetsContracts'

/** Count UTF-8 without allocating another copy; lone surrogates encode as U+FFFD. */
export function utf8Bytes(text:string):number {
  let bytes=0
  for(let i=0;i<text.length;i++) {
    const code=text.charCodeAt(i)
    if(code<0x80)bytes++
    else if(code<0x800)bytes+=2
    else if(code>=0xd800&&code<=0xdbff&&i+1<text.length&&text.charCodeAt(i+1)>=0xdc00&&text.charCodeAt(i+1)<=0xdfff){bytes+=4;i++}
    else bytes+=3
  }
  return bytes
}
export function textBuilder(limit=ASSET_TRANSFER_MAX_BYTES) {
  if(!Number.isSafeInteger(limit)||limit<1||limit>ASSET_TRANSFER_MAX_BYTES)throw new Error('文本预算非法。')
  const parts:string[]=[]
  let bytes=0,pendingHigh=false
  return {
    append(text:string){
      if(!text.length)return
      // Defer a trailing high surrogate: a following chunk can complete the same scalar.
      const first=text.charCodeAt(0),last=text.charCodeAt(text.length-1)
      bytes+=utf8Bytes(text)+(pendingHigh?(first>=0xdc00&&first<=0xdfff?1:3):0)
      pendingHigh=last>=0xd800&&last<=0xdbff
      if(pendingHigh)bytes-=3
      if(bytes>limit)throw new Error('文本超过预算，请减少所选资产或填值；未截断正文。')
      parts.push(text)
    },
    finish(){if(bytes+(pendingHigh?3:0)>limit)throw new Error('文本超过预算，未截断正文。');return parts.join('')}
  }
}
