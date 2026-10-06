import type { AssetsWriteSession } from './types'
import { normalizeTagName } from './tagNormalization'

/** 复用归一名，幂等替换关联；只能在资产写事务内调用。 */
export function replaceTags(s: AssetsWriteSession, assetId: number, names: string[]): void {
  s.run('DELETE FROM asset_tag WHERE asset_id=?', assetId)
  for (const name of names) {
    const normalized = normalizeTagName(name)
    s.run('INSERT INTO tag(name,normalized_name) VALUES (?,?) ON CONFLICT(normalized_name) DO NOTHING', name, normalized)
    const row = s.get<{ id: number }>('SELECT id FROM tag WHERE normalized_name=?', normalized)
    s.run('INSERT INTO asset_tag(asset_id,tag_id) VALUES (?,?) ON CONFLICT DO NOTHING', assetId, row?.id)
  }
}
