import type { EvidenceApi, EvidenceFilter } from '../../shared/libraryEvidenceContracts'

/** 固定桥接面；无任意路径/通道/外部URL参数。 */
export const libraryEvidenceApi = (): EvidenceApi => {
  const api = window.electronAPI?.libraryEvidence
  if (!api) throw new Error('请在Mimir桌面版中打开文献证据功能')
  return api
}
export const initialEvidenceFilter = (): EvidenceFilter => ({ archive: 'exclude', source: 'all' })
