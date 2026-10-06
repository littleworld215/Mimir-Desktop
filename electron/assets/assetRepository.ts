import { existsSync } from 'node:fs'
import type { AssetDetail, AssetSummary, AssetTag, StorageType, AssetKind, TemplateConfig } from '../../shared/assetsContracts'
import type { AssetsWriteSession } from './types'
import { AssetsStoreError } from './types'
import { selectCategory } from './categoryRepository'
import { resolveWithinFiles, type AssetsLayout } from './paths'

export interface AssetRow {
  id: number; code: string; name: string; category: string; description: string
  storage_type: StorageType; external_url: string | null; source_json: string; source_task: string
  notes: string; kind: AssetKind | null; template_config: string; current_version_id: number | null
  is_favorite: 0 | 1; last_used_at: string | null; archived_at: string | null
  revision: number; created_at: string; updated_at: string
}

export function selectAsset(s: AssetsWriteSession, id: number): AssetRow | undefined {
  return s.get<AssetRow>('SELECT * FROM asset WHERE id=?', id)
}

export function assetTags(s: AssetsWriteSession, id: number): AssetTag[] {
  return s.all<AssetTag>('SELECT t.id,t.name,t.color,t.revision FROM tag t JOIN asset_tag a ON a.tag_id=t.id WHERE a.asset_id=? ORDER BY t.id', id)
}

export function categoryPath(s: AssetsWriteSession, code: string): string[] {
  const result: string[] = []
  const visited = new Set<string>()
  let current: string | null = code
  while (current !== null) {
    if (visited.has(current)) throw new AssetsStoreError('CYCLE', '分类路径存在循环。')
    visited.add(current)
    const row = selectCategory(s, current)
    if (row === undefined) throw new AssetsStoreError('BAD_CATEGORY', '资产分类不存在。')
    result.unshift(row.name)
    current = row.parent_code
  }
  return result
}

export function detail(s: AssetsWriteSession, row: AssetRow, layout?: AssetsLayout): AssetDetail {
  const version = row.current_version_id === null ? undefined : s.get<{ version: number; content: string; file_name: string | null; file_path: string | null }>(
    'SELECT version,content,file_name,file_path FROM asset_version WHERE id=? AND asset_id=?', row.current_version_id, row.id)
  return {
    id: row.id, code: row.code, name: row.name, category: row.category, categoryPath: categoryPath(s, row.category),
    description: row.description, storageType: row.storage_type, externalUrl: row.external_url,
    sourceJson: row.source_json, sourceTask: row.source_task, notes: row.notes, kind: row.kind,
    templateConfig: JSON.parse(row.template_config) as TemplateConfig, currentVersionId: row.current_version_id,
    currentVersion: version?.version ?? null, currentContent: version?.content ?? '',
    isFavorite: row.is_favorite, lastUsedAt: row.last_used_at, archivedAt: row.archived_at,
    revision: row.revision, createdAt: row.created_at, updatedAt: row.updated_at,
    versionCount: s.get<{ n: number }>('SELECT count(*) n FROM asset_version WHERE asset_id=?', row.id)?.n ?? 0,
    tags: assetTags(s, row.id), fileAvailable: fileAvailableFor(row, version, layout), currentFileName: version?.file_name ?? null
  }
}

/**
 * 文件型资产：当前版本 blob 是否仍在托管目录下。
 * `layout` 缺失（如纯服务层单测未注入）时为 false；路径非法（realpath 越界/junction）按不可用处理。
 */
function fileAvailableFor(row: AssetRow, version: { file_path: string | null } | undefined, layout: AssetsLayout | undefined): boolean {
  if (row.storage_type !== 'file' || version?.file_path == null || layout === undefined) return false
  try {
    return existsSync(resolveWithinFiles(layout, version.file_path))
  } catch {
    return false
  }
}

/** 列表只取元信息与版本编号，不读取正文。 */
export function summary(s: AssetsWriteSession, row: AssetRow): AssetSummary {
  return {
    id: row.id, code: row.code, name: row.name, category: row.category, categoryPath: categoryPath(s, row.category),
    description: row.description, storageType: row.storage_type, kind: row.kind,
    currentVersion: row.current_version_id === null ? null : s.get<{ version: number }>('SELECT version FROM asset_version WHERE id=? AND asset_id=?', row.current_version_id, row.id)?.version ?? null,
    archivedAt: row.archived_at, revision: row.revision, updatedAt: row.updated_at, tags: assetTags(s, row.id)
  }
}

/** 版本与指针必须由调用者在同一受守卫事务中提交。可附带不可变文件 blob（file_path）与显式 source。 */
export function appendVersion(
  s: AssetsWriteSession,
  row: AssetRow,
  content: string,
  changelog: string,
  now: string,
  filePath: string | null = null,
  sourceJson?: string
): void {
  const next = (s.get<{ n: number }>('SELECT coalesce(max(version),0) n FROM asset_version WHERE asset_id=?', row.id)?.n ?? 0) + 1
  s.run(
    'INSERT INTO asset_version(asset_id,version,content,changelog,source_json,file_path,created_at) VALUES (?,?,?,?,?,?,?)',
    row.id, next, content, changelog, sourceJson ?? row.source_json, filePath, now
  )
  const id = s.get<{ id: number }>('SELECT last_insert_rowid() id')?.id
  s.run('UPDATE asset SET current_version_id=? WHERE id=?', id, row.id)
}
