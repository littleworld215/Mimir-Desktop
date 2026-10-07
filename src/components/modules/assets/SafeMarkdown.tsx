import ReactMarkdown from 'react-markdown'

// Tables are parsed locally; never enable raw HTML or create network-capable elements.
const cells=(line:string)=>line.trim().replace(/^\|/,'').replace(/\|$/,'').split('|').map(s=>s.trim())
export function SafeMarkdown({content}:{content:string}) {
  const lines=content.split('\n'),blocks:React.ReactNode[]=[],pending:string[]=[]
  const markdown=(text:string,key:number)=><ReactMarkdown key={key} skipHtml urlTransform={()=>''} components={{img:()=>null,a:({children})=><span>{children}</span>}}>{text}</ReactMarkdown>
  const flush=()=>{if(pending.length){blocks.push(markdown(pending.join('\n'),blocks.length));pending.length=0}}
  let fence:{character:string;length:number}|null=null
  for(let i=0;i<lines.length;i++) {
    const mark=lines[i].match(/^ {0,3}(`{3,}|~{3,})(.*)$/)
    if(mark){if(!fence&&(mark[1][0]!=='`'||!mark[2].includes('`')))fence={character:mark[1][0],length:mark[1].length};else if(fence&&mark[1][0]===fence.character&&mark[1].length>=fence.length&&!mark[2].trim())fence=null}
    const header=cells(lines[i]),separator=cells(lines[i+1]??'')
    if(!fence&&header.length>1&&header.length===separator.length&&separator.every(c=>/^:?-{3,}:?$/.test(c))) {
      flush();i++;const rows:string[][]=[]
      while(i+1<lines.length&&lines[i+1].includes('|')&&lines[i+1].trim()){rows.push(cells(lines[++i]))}
      blocks.push(<div key={blocks.length} className="overflow-x-auto"><table className="w-full border-collapse text-sm"><thead><tr>{header.map((c,n)=><th key={n} className="border p-2 text-left">{c}</th>)}</tr></thead><tbody>{rows.map((row,n)=><tr key={n}>{header.map((_,j)=><td key={j} className="border p-2">{row[j]??''}</td>)}</tr>)}</tbody></table></div>)
    }else pending.push(lines[i])
  }
  flush()
  return <div className="prose prose-sm max-w-none break-words dark:prose-invert [&_pre]:overflow-auto"><p className="text-xs text-muted-foreground">安全阅读：不执行 HTML，不加载图片，链接仅显示文字。表格单元格按原文显示。</p>{blocks}</div>
}
