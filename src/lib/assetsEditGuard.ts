export type AssetsLeaveChoice = 'save' | 'discard' | 'cancel'
declare global { interface Window { mimirRequestAssetsLeave?: (choice: AssetsLeaveChoice) => Promise<boolean> } }
export interface AssetsEditorSession {
  isDirty(): boolean
  isBusy(): boolean
  save(): Promise<boolean>
  discard(): void
}
const editors = new Set<AssetsEditorSession>()
let choose: (() => Promise<AssetsLeaveChoice>) | undefined
let deciding = false
export function registerAssetsEditor(editor: AssetsEditorSession): () => void {
  editors.add(editor)
  return () => { editors.delete(editor) }
}
export function setAssetsLeaveChooser(next: () => Promise<AssetsLeaveChoice>): () => void {
  choose = next
  return () => { if (choose === next) choose = undefined }
}
export function hasAssetsWork(): boolean { return [...editors].some(editor => editor.isDirty() || editor.isBusy()) }
export async function requestAssetsLeave(nativeChoice?: AssetsLeaveChoice): Promise<boolean> {
  if (deciding || [...editors].some(editor => editor.isBusy())) return false
  const dirty = [...editors].filter(editor => editor.isDirty())
  if (!dirty.length) return true
  if (!choose && nativeChoice === undefined) return false
  deciding = true
  try {
    const choice = nativeChoice ?? await choose!()
    if (choice === 'cancel') return false
    for (const editor of dirty) {
      if (!editors.has(editor)) continue
      if (editor.isBusy()) return false
      if (choice === 'discard') editor.discard()
      else if (!await editor.save()) return false
    }
    return true
  } catch { return false }
  finally { deciding = false }
}
