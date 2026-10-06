import type { AssetsWriteSession } from './types'
import { normalizeTagName } from './tagNormalization'

/** 复用归一名，幂等替换关联；只能在资产写事务内调用。 */
export function replaceTags(s: AssetsWriteSession, assetId: number, names: string[]): void {
  const before = new Set(s.all<{ tag_id: number }>('SELECT tag_id FROM asset_tag WHERE asset_id=?', assetId).map(row => row.tag_id))
  const after = new Set<number>()
  s.run('DELETE FROM asset_tag WHERE asset_id=?', assetId)
  for (const name of names) {
    const normalized = normalizeTagName(name)
    s.run('INSERT INTO tag(name,normalized_name) VALUES (?,?) ON CONFLICT(normalized_name) DO NOTHING', name, normalized)
    const row = s.get<{ id: number }>('SELECT id FROM tag WHERE normalized_name=?', normalized)
    if (row) after.add(row.id)
    s.run('INSERT INTO asset_tag(asset_id,tag_id) VALUES (?,?) ON CONFLICT DO NOTHING', assetId, row?.id)
  }
  for (const id of new Set([...before, ...after])) {
    if (before.has(id) !== after.has(id)) s.run('UPDATE tag SET revision=revision+1 WHERE id=?', id)
  }
}
