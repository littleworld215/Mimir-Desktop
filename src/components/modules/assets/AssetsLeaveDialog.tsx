import { useEffect, useRef, useState } from 'react'
import { Button } from '@/components/ui/button'
import { hasAssetsWork, requestAssetsLeave, setAssetsLeaveChooser, type AssetsLeaveChoice } from '@/lib/assetsEditGuard'
import { AssetModal } from './assetsUi'

export function AssetsLeaveDialog() {
  const [open, setOpen] = useState(false)
  const pending = useRef<((choice: AssetsLeaveChoice) => void) | null>(null)
  function answer(choice: AssetsLeaveChoice) { pending.current?.(choice); pending.current = null; setOpen(false) }
  useEffect(() => {
    const unregister = setAssetsLeaveChooser(() => new Promise(resolve => { pending.current = resolve; setOpen(true) }))
    window.mimirRequestAssetsLeave = requestAssetsLeave
    const closing = (event: BeforeUnloadEvent) => { if (hasAssetsWork()) { event.preventDefault(); event.returnValue = '' } }
    window.addEventListener('beforeunload', closing)
    return () => { unregister(); delete window.mimirRequestAssetsLeave; pending.current?.('cancel'); pending.current = null; window.removeEventListener('beforeunload', closing) }
  }, [])
  return open ? <AssetModal title="存在未保存的资产编辑" onClose={() => answer('cancel')}>
    <p className="text-sm">保存成功后才能离开。丢弃只放弃本次未保存输入。</p>
    <div className="flex flex-wrap justify-end gap-2"><Button variant="outline" onClick={() => answer('cancel')}>留在这里</Button><Button variant="destructive" onClick={() => answer('discard')}>丢弃后离开</Button><Button onClick={() => answer('save')}>保存后离开</Button></div>
  </AssetModal> : null
}
