import type { EvidenceScope } from '../../shared/libraryEvidenceContracts'

export interface PdfExcerpt {
  id: string
  scope: EvidenceScope
  paperId: string
  renderId: string
  page: number
  quote: string
}
