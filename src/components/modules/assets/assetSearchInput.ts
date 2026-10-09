import { ASSET_SEARCH_MAX_CODE_POINTS } from '../../../../shared/assetsContracts'

export function searchInputError(value: string): string {
  return [...value.trim()].length > ASSET_SEARCH_MAX_CODE_POINTS
    ? `检索内容最多${ASSET_SEARCH_MAX_CODE_POINTS}个字符，请缩短后重试。`
    : ''
}
