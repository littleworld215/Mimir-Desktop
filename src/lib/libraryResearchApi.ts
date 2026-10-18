import type { ResearchApi } from '../../shared/libraryResearchContracts'

/** 固定业务桥；不开放任意通道或路径。 */
export function libraryResearchApi(): ResearchApi {
  const api = window.electronAPI?.libraryResearch
  if (!api) throw Error('请在Mimir桌面版中打开研究问题和写作素材')
  return api
}
