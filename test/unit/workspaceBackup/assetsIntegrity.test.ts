import { expect, it, afterEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, readFileSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import Database from 'better-sqlite3'

import {
  checkRestoredAssetsIntegrity,
  expectedTableNames
} from '../../../electron/workspaceBackup/assetsIntegrity'
import { ASSETS_DDL, ASSETS_SCHEMA_VERSION } from '../../../electron/assets/schema'

/**
 * 恢复后资产库完整性校验（I6 批次 3 · T05）。
 *
 * 背景：设计 §3.4 步骤 c 要求对暂存副本做「数据库 / 外键」二次校验，但 `recheck.ts`
 * 从未落地，`restoreAdapter` 只好把该步做成可注入钩子（默认跳过）。
 * **本文件证明「钩子有真实现、且真能拦住坏库」**——否则「不注入就跳过」会变成
 * 「生产上悄悄不校验」（§7 K11 同类风险）。
 *
 * 双组结构（反假绿）：通过组（真库 → 不抛） + 篡改组（每种损坏 → 必须抛 INTEGRITY_FAILED）。
 */

const roots: string[] = []
function sandbox(): string {
  const root = mkdtempSync(join(tmpdir(), 'mimir-assets-integrity-'))
  roots.push(root)
  return root
}
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

/** 造一个「像真库」的资产库：用 ASSETS_DDL 建全部表。 */
function seedAssetsDb(path: string): void {
  const db = new Database(path)
  db.pragma('journal_mode = WAL')
  for (const statement of ASSETS_DDL) db.exec(statement)
  db.pragma(`user_version = ${ASSETS_SCHEMA_VERSION}`)
  db.close()
}

/** 模拟批次 2 packer 的做法：`backup()` 出一份一致快照（这才是归档里的字节）。 */
async function snapshot(source: string, destination: string): Promise<void> {
  const db = new Database(source)
  await db.backup(destination)
  db.close()
}

it('期望表名从 ASSETS_DDL 真源提取，不手抄', () => {
  const names = expectedTableNames()
  // 8 张业务表（v1 五张 + v2 见参/版本 + I4 saved_filter + I5 ai_draft）。
  expect(names).toContain('asset')
  expect(names).toContain('asset_version')
  expect(names).toContain('asset_tag')
  expect(names).toContain('asset_category')
  expect(names).toContain('asset_reference')
  expect(names).toContain('saved_filter')
  expect(names).toContain('ai_draft')
  expect(names).toContain('tag')
  // 真源驱动：改了 ASSETS_DDL 就直接反映，不需要同步第二份清单。
  expect(names.length).toBeGreaterThanOrEqual(8)
})

it('通过组：真快照只读打开即通过（含 integrity + 外键 + 期望表齐全）', async () => {
  const root = sandbox()
  const live = join(root, 'assets.db')
  const snap = join(root, 'snapshot.db')
  seedAssetsDb(live)
  await snapshot(live, snap)

  // 不抛即为通过。用 `nativeBinding: undefined` 走 Node 默认绑定（vitest 是 Node ABI）。
  await expect(
    checkRestoredAssetsIntegrity(snap, { nativeBinding: undefined })
  ).resolves.toBeUndefined()
})

it('通过组：校验**不改动**被验收的快照主文件（逐字节未动）', async () => {
  const root = sandbox()
  const live = join(root, 'assets.db')
  const snap = join(root, 'snapshot.db')
  seedAssetsDb(live)
  await snapshot(live, snap)

  const before = readFileSync(snap)
  await checkRestoredAssetsIntegrity(snap, { nativeBinding: undefined })
  const after = readFileSync(snap)

  // 核心断言：**主库文件逐字节未动**。这是「只读」的真正含义——
  // 校验绝不能把待验收的副本改坏，否则验过的东西就不是要发布的东西了。
  expect(Buffer.compare(before, after)).toBe(0)
})

it('已知行为（实测留档）：只读打开仍会生成空 -wal 与 -shm 边车', async () => {
  // ⚠️ 这是**实测发现的、必须留档**的行为，不是缺陷断言：
  // `readonly: true` 下 SQLite 依然会为 WAL 模式的库创建 `-shm`（32KB）与**空** `-wal`。
  // 主文件不受影响（上一条测试已断言），但这些边车会留在**暂存根**里。
  // 影响评估：暂存根随后被 `rename` 成目标目录，故 `-wal`/`-shm` 会作为「多出来的文件」
  // 出现在**新空间**根下。这是**已知且可接受**的：它们体积固定、是 SQLite 正常副产物，
  // 且恢复后的空间首次打开资产库时会自行接管。
  // 记录在此，是为了避免后人误以为「只读 = 零副作用」而据此写出错误的不变量。
  const root = sandbox()
  const live = join(root, 'assets.db')
  const snap = join(root, 'snapshot.db')
  seedAssetsDb(live)
  await snapshot(live, snap)

  await checkRestoredAssetsIntegrity(snap, { nativeBinding: undefined })
  const sidecars = readdirSync(root).filter((name) => name.startsWith('snapshot.db-'))
  expect(sidecars.sort()).toEqual(['snapshot.db-shm', 'snapshot.db-wal'])
  // 空 -wal：没有任何页被写入 WAL → 进一步证明未发生写事务。
  expect(readFileSync(join(root, 'snapshot.db-wal')).length).toBe(0)
})

it('篡改组：不是 SQLite 文件 → INTEGRITY_FAILED', async () => {
  const root = sandbox()
  const broken = join(root, 'broken.db')
  writeFileSync(broken, 'definitely not a sqlite database at all', 'utf8')
  await expect(
    checkRestoredAssetsIntegrity(broken, { nativeBinding: undefined })
  ).rejects.toMatchObject({ code: 'INTEGRITY_FAILED' })
})

it('篡改组：缺表（归档内容被截断/被换过）→ INTEGRITY_FAILED', async () => {
  const root = sandbox()
  const live = join(root, 'assets.db')
  // 只建一张表，其余全缺。
  const db = new Database(live)
  db.exec('CREATE TABLE asset (id INTEGER PRIMARY KEY)')
  db.close()
  await expect(
    checkRestoredAssetsIntegrity(live, { nativeBinding: undefined })
  ).rejects.toMatchObject({ code: 'INTEGRITY_FAILED' })
})

it('篡改组：文件不存在 → INTEGRITY_FAILED（绝不静默通过）', async () => {
  const root = sandbox()
  await expect(
    checkRestoredAssetsIntegrity(join(root, 'missing.db'), { nativeBinding: undefined })
  ).rejects.toMatchObject({ code: 'INTEGRITY_FAILED' })
})

it('错误信息里带上路径，便于用户定位是哪份归档的哪一步失败', async () => {
  const root = sandbox()
  const broken = join(root, 'nope.db')
  writeFileSync(broken, 'nope', 'utf8')
  await expect(
    checkRestoredAssetsIntegrity(broken, { nativeBinding: undefined })
  ).rejects.toThrow(new RegExp(broken.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
})
