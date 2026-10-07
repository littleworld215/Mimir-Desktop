import { cloneElement, isValidElement, useEffect, useId, useRef } from 'react'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from '@/components/ui/dialog'
import { registerAssetsEditor, type AssetsEditorSession } from '@/lib/assetsEditGuard'

export const controlClass = 'w-full rounded-md border border-input bg-background px-3 py-2 text-sm disabled:opacity-50'
export function AssetField({ label, children }: { label: string; children: React.ReactNode }) {
  const id = useId()
  return <div className="flex flex-col gap-1 text-sm"><label htmlFor={id}>{label}</label>{isValidElement<{ id?: string }>(children) ? cloneElement(children, { id }) : children}</div>
}
export function AssetModal({ title, children, onClose, onEscape }: { title: string; children: React.ReactNode; onClose: () => void;onEscape?:()=>boolean }) {
  const previousFocus=useRef(document.activeElement)
  return <Dialog open onOpenChange={open => { if (!open) onClose() }}><DialogContent onEscapeKeyDown={e=>{if(onEscape?.())e.preventDefault()}} onCloseAutoFocus={e=>{e.preventDefault();const element=previousFocus.current;if(element instanceof HTMLElement&&element.isConnected)element.focus()}} className="max-h-[90vh] max-w-3xl overflow-y-auto">
    <DialogHeader><DialogTitle>{title}</DialogTitle><DialogDescription>当前科研空间的资产库</DialogDescription></DialogHeader>{children}
  </DialogContent></Dialog>
}
export function AssetError({ message }: { message: string }) { return message ? <p role="alert" className="whitespace-pre-wrap text-sm text-destructive">{message}</p> : null }
export function errorMessage(error: unknown): string { return error instanceof Error ? error.message : '操作失败，请重试。' }
export function useAssetsEditorGuard(session: AssetsEditorSession): void {
  const ref = useRef(session)
  ref.current = session
  useEffect(() => registerAssetsEditor({ isDirty: () => ref.current.isDirty(), isBusy: () => ref.current.isBusy(), save: () => ref.current.save(), discard: () => ref.current.discard() }), [])
}
