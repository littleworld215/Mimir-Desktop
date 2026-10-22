/** Any present tombstone hides the record; malformed markers must never resurrect data. */
export function isPaperTrashed(paper: { removedAt?: unknown }): boolean {
  return paper.removedAt !== undefined
}
export interface PaperLifecycleScope { workspaceId: string; spaceEpoch: string }
export interface PaperLifecyclePreview {
  arxivId: string; title: string; action: 'trash' | 'restore'; token: string
  projectNames: string[]; missingProjectIds: string[]
  counts: { evidenceCards: number; evidenceVersions: number; questions: number; packs: number; planningItems: number; planningDrafts: number; editingDrafts: number }
}
export type PaperLifecycleResult<T> = ({ ok: true } & T) | { ok: false; message: string }
export interface PaperTrashRow { arxivId: string; title: string; removedAt: string; hasPdf: boolean; tagCount: number }
export interface LibraryLifecycleApi {
  paperTrash(): Promise<PaperLifecycleResult<{ scope: PaperLifecycleScope; papers: PaperTrashRow[] }>>
  previewPaperLifecycle(request: { scope: PaperLifecycleScope; arxivId: string; action: 'trash' | 'restore' }): Promise<PaperLifecycleResult<{ preview: PaperLifecyclePreview }>>
  applyPaperLifecycle(request: { scope: PaperLifecycleScope; token: string }): Promise<PaperLifecycleResult<Record<never, never>>>
}
