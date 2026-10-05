/**
 * 资产库 SQLite schema（**目标自有版本，从 1 开始，与来源 v8 无关**）。
 *
 * 设计依据：docs/INTEGRATION-PLAN-I0-I1.md §3.1 / §3.2。
 * - 五张业务表：asset_category / asset / asset_version / tag / asset_tag。
 * - `asset_version` **append-only**：由 trigger 禁止 UPDATE；删除资产时可级联删除其版本。
 * - `asset.current_version_id` 不得跨资产：用组合外键
 *   `asset(id, current_version_id) → asset_version(asset_id, id)` 表达，DB 层强约束。
 * - `revision` 用于并发元信息写入（正文冲突另由 expectedCurrentVersionId 覆盖）。
 * - I2 再加 asset_reference / FTS；I4 加 saved_filter；I5 加 ai_draft。此处不预建空表。
 */

export const ASSETS_SCHEMA_VERSION = 1

/**
 * 预置分类（与来源 `server/src/db/seed.ts` 的 CATEGORIES / AI_TREE / inbox 语义对齐，共 15 项）。
 *
 * 对齐要求：`code` / `name` / `defaultStorageType` / `parentCode` **必须与来源一致**；
 * `icon` 用目标 lucide key（来源是 Element Plus 名，不照搬）。
 * - 10 个顶层：literature-note / code-template / experiment-paradigm / workflow-spec /
 *   rule / skill / prompt / glossary / writing-material / experience；
 * - AI 子树（parent 链）：ai-collab → domain-nlp → task-polish → scene-pre-submit；
 * - inbox 未分类（parentCode null，defaultStorageType=file）。
 */
export interface BuiltinCategory {
  code: string
  name: string
  parentCode: string | null
  icon: string | null
  defaultStorageType: 'inline_text' | 'file' | 'external_link' | null
  sortOrder: number
}

export const BUILTIN_CATEGORIES: readonly BuiltinCategory[] = [
  { code: 'inbox', name: '未分类', parentCode: null, icon: 'inbox', defaultStorageType: 'file', sortOrder: -1 },
  { code: 'literature-note', name: '文献笔记', parentCode: null, icon: 'book-open', defaultStorageType: 'inline_text', sortOrder: 1 },
  { code: 'code-template', name: '代码模板', parentCode: null, icon: 'code', defaultStorageType: 'file', sortOrder: 2 },
  { code: 'experiment-paradigm', name: '实验记录范式', parentCode: null, icon: 'flask-conical', defaultStorageType: 'file', sortOrder: 3 },
  { code: 'workflow-spec', name: '工作流规范', parentCode: null, icon: 'workflow', defaultStorageType: 'inline_text', sortOrder: 4 },
  { code: 'rule', name: '规则约束', parentCode: null, icon: 'shield-check', defaultStorageType: 'inline_text', sortOrder: 5 },
  { code: 'skill', name: 'Skill', parentCode: null, icon: 'zap', defaultStorageType: 'inline_text', sortOrder: 6 },
  { code: 'prompt', name: 'Prompt 模板', parentCode: null, icon: 'wand-sparkles', defaultStorageType: 'inline_text', sortOrder: 7 },
  { code: 'glossary', name: '专业词汇表', parentCode: null, icon: 'languages', defaultStorageType: 'inline_text', sortOrder: 8 },
  { code: 'writing-material', name: '写作素材', parentCode: null, icon: 'pen-line', defaultStorageType: 'inline_text', sortOrder: 9 },
  { code: 'experience', name: '经验贴', parentCode: null, icon: 'lightbulb', defaultStorageType: 'inline_text', sortOrder: 10 },
  { code: 'ai-collab', name: 'AI 协作', parentCode: null, icon: 'sparkles', defaultStorageType: 'inline_text', sortOrder: 11 },
  { code: 'domain-nlp', name: '领域：NLP', parentCode: 'ai-collab', icon: null, defaultStorageType: 'inline_text', sortOrder: 12 },
  { code: 'task-polish', name: '任务类型：论文润色', parentCode: 'domain-nlp', icon: null, defaultStorageType: 'inline_text', sortOrder: 13 },
  { code: 'scene-pre-submit', name: '场景：投稿前语言打磨', parentCode: 'task-polish', icon: null, defaultStorageType: 'inline_text', sortOrder: 14 }
]

/**
 * 建库 DDL（version 0 → 1）。
 *
 * 说明：
 * - 组合外键 `(id, current_version_id) → asset_version(asset_id, id)` 需要
 *   `asset_version` 上有 `UNIQUE(asset_id, id)`；由于 asset 先建、asset_version 后建，
 *   该外键在 SQLite 中允许「引用尚未存在行的表」——外键是延迟校验的，只要插入顺序正确即可。
 * - `PRAGMA foreign_keys = ON` 由连接层设置（store.ts），DDL 本身不设置。
 */
export const ASSETS_DDL: readonly string[] = [
  `CREATE TABLE IF NOT EXISTS asset_category (
    code TEXT PRIMARY KEY NOT NULL,
    name TEXT NOT NULL,
    icon TEXT,
    default_storage_type TEXT CHECK (default_storage_type IS NULL OR default_storage_type IN ('inline_text','file','external_link')),
    description TEXT NOT NULL DEFAULT '',
    builtin INTEGER NOT NULL DEFAULT 0 CHECK (builtin IN (0,1)),
    parent_code TEXT REFERENCES asset_category(code) ON DELETE RESTRICT,
    sort_order INTEGER NOT NULL DEFAULT 0,
    revision INTEGER NOT NULL DEFAULT 1 CHECK (revision >= 1),
    created_at TEXT NOT NULL
  )`,

  `CREATE TABLE IF NOT EXISTS asset (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    code TEXT NOT NULL UNIQUE,
    name TEXT NOT NULL,
    category TEXT NOT NULL REFERENCES asset_category(code) ON DELETE RESTRICT,
    description TEXT NOT NULL DEFAULT '',
    storage_type TEXT NOT NULL CHECK (storage_type IN ('inline_text','file','external_link')),
    external_url TEXT,
    source_json TEXT NOT NULL DEFAULT '{}',
    source_task TEXT NOT NULL DEFAULT '',
    notes TEXT NOT NULL DEFAULT '',
    kind TEXT CHECK (kind IS NULL OR kind IN ('thought','rule','file','prompt')),
    template_config TEXT NOT NULL DEFAULT '{"version":1,"variables":{}}',
    current_version_id INTEGER,
    is_favorite INTEGER NOT NULL DEFAULT 0 CHECK (is_favorite IN (0,1)),
    last_used_at TEXT,
    archived_at TEXT,
    revision INTEGER NOT NULL DEFAULT 1 CHECK (revision >= 1),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    FOREIGN KEY (id, current_version_id) REFERENCES asset_version(asset_id, id) ON DELETE RESTRICT
  )`,

  `CREATE TABLE IF NOT EXISTS asset_version (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    asset_id INTEGER NOT NULL REFERENCES asset(id) ON DELETE CASCADE,
    version INTEGER NOT NULL CHECK (version > 0),
    content TEXT NOT NULL DEFAULT '',
    file_path TEXT,
    file_name TEXT,
    changelog TEXT NOT NULL DEFAULT '',
    source_json TEXT NOT NULL DEFAULT '{}',
    created_at TEXT NOT NULL,
    UNIQUE (asset_id, version),
    UNIQUE (asset_id, id)
  )`,

  `CREATE TABLE IF NOT EXISTS tag (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    normalized_name TEXT NOT NULL UNIQUE,
    color TEXT,
    revision INTEGER NOT NULL DEFAULT 1 CHECK (revision >= 1)
  )`,

  `CREATE TABLE IF NOT EXISTS asset_tag (
    asset_id INTEGER NOT NULL REFERENCES asset(id) ON DELETE CASCADE,
    tag_id INTEGER NOT NULL REFERENCES tag(id) ON DELETE CASCADE,
    PRIMARY KEY (asset_id, tag_id)
  )`,

  `CREATE INDEX IF NOT EXISTS idx_asset_category_parent ON asset_category(parent_code)`,
  `CREATE INDEX IF NOT EXISTS idx_asset_category_archived_updated ON asset(category, archived_at, updated_at)`,
  `CREATE INDEX IF NOT EXISTS idx_asset_archived_updated ON asset(archived_at, updated_at, id)`,
  `CREATE INDEX IF NOT EXISTS idx_asset_version_asset_version ON asset_version(asset_id, version DESC)`,
  `CREATE INDEX IF NOT EXISTS idx_asset_tag_tag_asset ON asset_tag(tag_id, asset_id)`,

  // append-only 纵深防护：任何 UPDATE 直接失败（应用层无 update/delete 版本 API）。
  `CREATE TRIGGER IF NOT EXISTS trg_asset_version_no_update
    BEFORE UPDATE ON asset_version
    BEGIN
      SELECT RAISE(ABORT, 'asset_version is append-only');
    END`
]
