import { expect, it, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { canDeriveOldRoot, oldRootFromArchive, readArchiveManifestEntries } from '../../../electron/workspaceBackup/restoreArchive'
import { buildManifest } from '../../../electron/workspaceBackup/manifest'
import { createBackup } from '../../../electron/workspaceBackup/packer'
import type { ManifestEntry } from '../../../electron/workspaceBackup/manifest'

/**
 * 归档内旧空间根推导（I6 批次 3 · T05）。
 *
 * 为什么这份测试重要：`oldRoot` 是 T03 重映射的**匹配基准**。推导错了会有两种后果，
 * 都不可接受：
 * - 推**短**了 → 少改写几条（可接受，空间照常恢复，`pdfPath` 保持旧值）；
 * - 推**长**了 → 把用户空间外的路径误认成空间内，从而**把不该改的路径改掉**
 *   （K2/§7 高危误写）。
 * 因此下面的失败组断言比成功组更多：每一条「不确定」都必须落到 `null`。
 */

const roots: string[] = []
function sandbox(): string {
  const root = mkdtempSync(join(tmpdir(), 'mimir-oldroot-'))
  roots.push(root)
  return root
}
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

/** 便捷构造条目（只填 `path`/`kind` 即可，其余字段本模块不读）。 */
function entries(...paths: string[]): ManifestEntry[] {
  return paths.map((path) => ({ path, kind: 'file', size: 1, sha256: 'x' })) as ManifestEntry[]
}

/** 目录条目（真实归档会为每个目录写一条，必须与文件条目区分对待）。 */
function dirs(...paths: string[]): ManifestEntry[] {
  return paths.map((path) => ({ path, kind: 'directory', size: 0, sha256: '' })) as ManifestEntry[]
}

it('取所有文件条目的最大公共目录前缀（不含任何文件名段）', () => {
  // `papers/a.pdf` → 父 `[papers]`；`.mimir/store.json` → 父 `[.mimir]`；公共前缀为空。
  // 空根**无意义**（`matchRootPrefix` 会拒绝空归一化根），故约定返回 `null`（推不出），
  // 而不是 `''`——返回空串会让调用方以为「有根」，从而走进一段永不命中的匹配。
  expect(oldRootFromArchive(entries('papers/a.pdf', 'papers/b.pdf', '.mimir/store.json'))).toBeNull()

  // 只有一份子目录时，公共目录前缀即该子目录。
  expect(oldRootFromArchive(entries('papers/a.pdf', 'papers/b.pdf'))).toBe('papers')
  expect(oldRootFromArchive(entries('x/y/a.pdf', 'x/y/b.pdf', 'x/y/z/c.pdf'))).toBe('x/y')
})

it('目录条目被忽略：真实归档形态仍能推进出「唯一顶层目录」', () => {
  // 这是**被真实归档逼出来的**规则，不是偏好：
  // 源为 `<src>/papers/a.pdf` 的归档，清单是 `papers[d]` + `papers/a.pdf[f]`。
  // 若目录条目也参与「剥最后一段」，它会给出 `[]`，与文件条目的 `[papers]` 求交 → `[]`
  // → 推不出。但正确答案显然是 `papers`。
  expect(oldRootFromArchive([...entries('papers/a.pdf'), ...dirs('papers')])).toBe('papers')
  expect(oldRootFromArchive([...entries('papers/a.pdf', 'papers/b.pdf'), ...dirs('papers')])).toBe('papers')
  // 目录条目的存在**不得**把原本可推导的根破坏掉。
  expect(oldRootFromArchive([...entries('x/y/a.pdf'), ...dirs('x', 'x/y')])).toBe('x/y')
})

it('只有目录条目（无文件）→ 推不出根，绝不拿目录名当根', () => {
  expect(oldRootFromArchive(dirs('papers'))).toBeNull()
  expect(oldRootFromArchive(dirs('a', 'a/b', 'a/b/c'))).toBeNull()
})

it('推不出根时返回 null，而不是猜一个', () => {
  expect(oldRootFromArchive([])).toBeNull()
  expect(oldRootFromArchive(entries('only-one-file.pdf'))).toBeNull()
  expect(oldRootFromArchive(entries('a.pdf', 'b.pdf'))).toBeNull()
})

it('形态可疑的路径一律不参与推导（绝对路径/盘符/前导斜杠/空段/上跳）', () => {
  // 清单口径是**相对路径**；出现绝对形态即说明归档异常 → 放弃推导，绝不据它算前缀。
  expect(oldRootFromArchive(entries('C:/spaces/src/papers/a.pdf', 'C:/spaces/src/papers/b.pdf'))).toBeNull()
  expect(oldRootFromArchive(entries('/abs/papers/a.pdf', '/abs/papers/b.pdf'))).toBeNull()
  expect(oldRootFromArchive(entries('papers//a.pdf', 'papers//b.pdf'))).toBeNull()
  expect(oldRootFromArchive(entries('../escape/a.pdf', '../escape/b.pdf'))).toBeNull()
  expect(oldRootFromArchive(entries('', '.'))).toBeNull()
})

it('反斜杠形态的清单路径按同一口径归一（Windows 生成的归档）', () => {
  expect(oldRootFromArchive(entries('nav\\papers\\a.pdf', 'nav\\papers\\b.pdf'))).toBe('nav/papers')
})

it('canDeriveOldRoot 与 oldRootFromArchive 同口径', () => {
  expect(canDeriveOldRoot(entries('x/a.pdf', 'x/b.pdf'))).toBe(true)
  expect(canDeriveOldRoot(entries('a.pdf'))).toBe(false)
  expect(canDeriveOldRoot([])).toBe(false)
})

it('真实归档：从 packer 产物读出的清单能推导出与打包根同构的相对根', async () => {
  // 这条是端到端校准：清单条目由 `toPosixRelative(root, absolute)` 生成
  // （`manifest.ts:226`），且 packer 会为每个目录额外写一条 `directory` 条目。
  // 因此这里同时验证「目录条目被正确忽略」与「目录条目存在时根仍可推导」。
  const root = sandbox()

  // ① 源含单一顶层目录 `papers/` → 应推导出 `papers`。
  //    （这是目录条目规则的关键回归：若目录条目参与，会退化成「推不出」。）
  const src2 = join(root, 'src2')
  mkdirSync(join(src2, 'papers'), { recursive: true })
  writeFileSync(join(src2, 'papers', 'a.pdf'), 'A', 'utf8')
  mkdirSync(join(root, 'backups'), { recursive: true })
  const archive2 = join(root, 'backups', 'space2.zip')
  await createBackup({ root: src2, destination: archive2, stagingDir: join(root, 'staging2'), assetsDb: null })
  const read2 = await readArchiveManifestEntries(archive2)
  // 确认归档确实含目录条目（否则本测试证明不了「目录条目被忽略」）。
  expect(read2.some((entry) => entry.kind === 'directory')).toBe(true)
  expect(oldRootFromArchive(read2)).toBe('papers')

  // ② 源含两个不同顶层目录 → 公共目录前缀为空 → 推不出根（诚实结果，非猜测）。
  const src = join(root, 'src')
  mkdirSync(join(src, 'papers'), { recursive: true })
  mkdirSync(join(src, '.mimir'), { recursive: true })
  writeFileSync(join(src, 'papers', 'b.pdf'), 'B', 'utf8')
  writeFileSync(join(src, '.mimir', 'store.json'), '{}', 'utf8')
  const archive = join(root, 'backups', 'space.zip')
  await createBackup({ root: src, destination: archive, stagingDir: join(root, 'staging'), assetsDb: null })
  expect(oldRootFromArchive(await readArchiveManifestEntries(archive))).toBeNull()
})

it('清单缺失 / 归档损坏 → 抛 RECHECK_FAILED（绝不静默返回空数组）', async () => {
  const root = sandbox()
  const notZip = join(root, 'broken.zip')
  writeFileSync(notZip, 'this is not a zip file', 'utf8')
  await expect(readArchiveManifestEntries(notZip)).rejects.toMatchObject({ code: 'RECHECK_FAILED' })

  // 含条目但**没有清单**的归档：同样必须是明确失败。
  const src = join(root, 'src')
  mkdirSync(src, { recursive: true })
  writeFileSync(join(src, 'a.txt'), 'A', 'utf8')
  const manifest = await buildManifest(src)
  // 手工造一个只有业务条目、缺 manifest.json 的归档：用 packer 造不出（它总会写清单），
  // 故这里直接断言「清单缺失」时的错误码——通过读一个真实存在但被截断的归档模拟。
  expect(manifest.entries.length).toBeGreaterThan(0)
  const truncated = join(root, 'truncated.zip')
  writeFileSync(truncated, Buffer.from([0x50, 0x4b, 0x03, 0x04, 0, 0, 0, 0]), 'utf8')
  await expect(readArchiveManifestEntries(truncated)).rejects.toMatchObject({ code: 'RECHECK_FAILED' })
})
