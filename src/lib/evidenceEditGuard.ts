export type EvidenceLeaveChoice = 'save' | 'discard' | 'cancel'
export interface EvidenceEditorSession { isDirty(): boolean; isBusy(): boolean; save(): Promise<boolean>; discard(): void }
import { requestAssetsLeave } from './assetsEditGuard'
declare global { interface Window { mimirRequestEvidenceLeave?: (choice: EvidenceLeaveChoice) => Promise<boolean> } }
const editors = new Set<EvidenceEditorSession>()
let chooser: (() => Promise<EvidenceLeaveChoice>) | undefined, deciding = false
export function registerEvidenceEditor(editor: EvidenceEditorSession) { editors.add(editor); return () => { editors.delete(editor) } }
export function setEvidenceLeaveChooser(next: () => Promise<EvidenceLeaveChoice>) { chooser = next; return () => { if (chooser === next) chooser = undefined } }
export function hasEvidenceWork() { return [...editors].some(e => e.isDirty() || e.isBusy()) }
export async function requestEvidenceLeave(nativeChoice?: EvidenceLeaveChoice): Promise<boolean> {
  if (deciding || [...editors].some(e => e.isBusy())) return false
  const dirty = [...editors].filter(e => e.isDirty())
  if (!dirty.length) return true
  if (!chooser && nativeChoice === undefined) return false
  deciding = true
  try {
    const choice = nativeChoice ?? await chooser!()
    if (choice === 'cancel') return false
    for (const e of dirty) {
      if (!editors.has(e)) continue
      if (e.isBusy()) return false
      if (choice === 'discard') e.discard()
      else if (!await e.save()) return false
    }
    return true
  } catch { return false }
  finally { deciding = false }
}
export async function requestResearchLeave() { return await requestAssetsLeave() && await requestEvidenceLeave() }
