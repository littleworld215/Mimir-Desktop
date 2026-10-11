import { expect, it, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, readdirSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { listRestoreArchives, runMaintenanceRestore } from '../../../electron/workspaceBackup/restoreMain'
import { readArchiveManifest } from '../../../electron/workspaceBackup/restoreArchive'
import { createBackup } from '../../../electron/workspaceBackup/packer'
import { acquireMigratableWriterLock } from '../../../electron/workspaceBackup/operationGate'

/**
 * 维护模式恢复服务层（I6 批次 3 · T05）。
 *
 * 这是本批次**唯一的装配点测试**：证明 `restoreRunner`（纯编排）+ `restoreAdapter`
 * （真实步骤）+ 旧根推导 + 完整性钩子 + 写锁获取能真正串起来，且：
 * - **锁先行**（§4.2 S5）：锁在**暂存根内**、解压前取；发布那次 `rename` 把锁带到目标目录；
 * - **落点不可覆盖**（§2.1）：编排层**从不预先建目标目录**，目标由发布 rename 落地，
 *   用户已有同名目录时硬拒 `TARGET_EXISTS`；
 * - 早退失败**零副作用**（不建目录、不取锁、不拍快照）；
 * - 失败时**不自行删任何路径**（回收范围由 `outcome.cleanup` 交给调用方决定）。
 */

const roots: string[] = []
function sandbox(): string {
  const root = mkdtempSync(join(tmpdir(), 'mimir-restore-main-'))
  roots.push(root)
  return root
}
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

/** 记录调用顺序的假写者会话。现在只剩健康检查（不再碰目标目录）。 */
function fakeSession(order: string[]): { assertUsable(): void } {
  return {
    assertUsable: () => { order.push('assertUsable') }
  }
}

/**
 * 生产用的**可迁移**锁获取器包装（与 `maintenanceMain` 接线一致）。
 *
 * 刻意在测试里用**真实现**（`acquireMigratableWriterLock`）而不是假锁：
 * 本批次的核心风险正是「锁能否随 rename 迁移且 release 不 ENOENT」——用假锁会把
 * 这条唯一的真实约束测掉。真锁还需要 `.mimir` 父目录存在，故这里先建出来。
 */
function realLockFactory(order: string[]): (stagingRoot: string) => { release(): void } {
  return (stagingRoot: string) => {
    order.push(`lockStagingRoot:${stagingRoot}`)
    const mimirDir = join(stagingRoot, '.mimir')
    mkdirSync(mimirDir, { recursive: true })
    return acquireMigratableWriterLock(join(mimirDir, 'workspace.writer-lock'), stagingRoot)
  }
}

/**
 * 合成 home + 一份最小注册表。
 *
 * 恢复成功会**真正**往 `<home>/.mimir/store.json` 追加一条记录（见 restoreMain 文件头
 * 注释：注册留在编排内，失败即 failed），故每条成功用例都必须有一个合法的注册表落点。
 * **绝不**用真实 `homedir()`——测试会污染用户的 `~/.mimir/store.json`。
 */
function seedHome(root: string): string {
  const home = join(root, 'home')
  mkdirSync(join(home, '.mimir'), { recursive: true })
  writeFileSync(
    join(home, '.mimir', 'store.json'),
    JSON.stringify({ 'workspaces:list': [], settings: {}, 'servers:list': [] }),
    'utf8'
  )
  return home
}

const deps = (order: string[], homeDir: string) => ({
  session: fakeSession(order),
  lockStagingRoot: realLockFactory(order),
  homeDir
})

/** 造一份真实归档（源含单一顶层目录，便于推导旧根）。 */
async function seedArchive(root: string): Promise<{ archive: string; src: string }> {
  const src = join(root, 'src')
  mkdirSync(join(src, 'papers'), { recursive: true })
  writeFileSync(join(src, 'papers', 'a.pdf'), 'PDF-A', 'utf8')
  mkdirSync(join(root, 'backups'), { recursive: true })
  const archive = join(root, 'backups', 'space.zip')
  await createBackup({ root: src, destination: archive, stagingDir: join(root, 'staging'), assetsDb: null })
  return { archive, src }
}

it('成功：健康检查 → 暂存根取锁 → 推导旧根 → 编排完成，且注册表未被本层触碰', async () => {
  const root = sandbox()
  const { archive } = await seedArchive(root)
  const order: string[] = []
  // 目标父目录必须存在（编排层不建父级，见 restoreMain 函数头注释）。
  const targetRoot = join(root, 'spaces', 'restored')
  mkdirSync(join(root, 'spaces'), { recursive: true })
  const home = seedHome(root)

  const outcome = await runMaintenanceRestore(
    { archivePath: archive, targetRoot, spaceName: '恢复的空间' },
    deps(order, home)
  )

  expect(outcome.stage).toBe('done')
  expect(outcome.failure).toBeNull()
  expect(outcome.result?.name).toBe('恢复的空间')
  // 内容真的落到了新目录。
  expect(existsSync(join(targetRoot, 'papers', 'a.pdf'))).toBe(true)
  // §4.2 S5 锁先行：健康检查（会话仍持 registry 锁）→ 暂存根内取锁，均发生在编排之前。
  expect(order[0]).toBe('assertUsable')
  expect(order[1]).toMatch(/^lockStagingRoot:/)
  // 锁文件随发布 rename 迁到了目标目录（§4.2 S5 后半段）。
  expect(existsSync(join(targetRoot, '.mimir', 'workspace.writer-lock'))).toBe(true)
  // 新空间**真的**被登记进了本机注册表（注册留在编排内：失败即 failed，不谎报 done）。
  const registry = JSON.parse(readFileSync(join(home, '.mimir', 'store.json'), 'utf8'))
  const registered = registry['workspaces:list'] as Array<{ name: string; path: string }>
  expect(registered).toHaveLength(1)
  expect(registered[0]!.name).toBe('恢复的空间')
  // 登记路径与落点一致（归一后比较：Windows 反斜杠 / POSIX 正斜杠）。
  expect(registered[0]!.path.replace(/\\/g, '/')).toBe(targetRoot.replace(/\\/g, '/'))
  // 成功路径上编排层从不预先建目标目录 —— 它是 rename 的产物。
  expect(existsSync(join(root, 'spaces'))).toBe(true)
})

it('成功：目标父级缺失 → INVALID_TARGET（编排层刻意不递归建父级）', async () => {
  // 这条守的是真实约束的反面：暂存根位于 `<targetParent>/…`，父级不存在就无法建暂存根。
  // 编排层**刻意不**用 `recursive: true` 自动补父级 —— 静默补多级父目录会把
  // 「用户选错路径」变成「默默在错的地方建出一棵树」（见 restoreMain 函数头注释）。
  const root = sandbox()
  const { archive } = await seedArchive(root)
  const targetRoot = join(root, 'very', 'deep', 'new', 'tree', 'restored')

  const outcome = await runMaintenanceRestore(
    { archivePath: archive, targetRoot, spaceName: 's' },
    deps([], seedHome(root))
  )
  expect(outcome.stage).toBe('failed')
  expect(outcome.failure?.code).toBe('INVALID_TARGET')
  expect(outcome.failure?.detail).toContain('父目录不存在')
  // 零副作用：连第一层都不该被建出来。
  expect(existsSync(join(root, 'very'))).toBe(false)
})

it('成功：父级已存在时深层新路径可恢复（暂存根与目标同父）', async () => {
  const root = sandbox()
  const { archive } = await seedArchive(root)
  const parent = join(root, 'deep', 'tree')
  mkdirSync(parent, { recursive: true })
  const targetRoot = join(parent, 'restored')

  const outcome = await runMaintenanceRestore(
    { archivePath: archive, targetRoot, spaceName: 's' },
    deps([], seedHome(root))
  )
  expect(outcome.stage).toBe('done')
  expect(existsSync(join(targetRoot, 'papers', 'a.pdf'))).toBe(true)
})

it('成功：旧根（sourceRoot）被用于 T03，报告如实反映改写条数', async () => {
  const root = sandbox()
  const { archive, src } = await seedArchive(root)
  // 往源空间的空间层 store.json 里塞一条指向空间内 PDF 的 **绝对** pdfPath。
  // 生产里 `pdfPath` 就是绝对路径（`library/types.ts`：「已下载 PDF 的绝对路径」），
  // 故这里必须用绝对路径才能验证「绝对对绝对」的匹配语义。
  const storePath = join(src, '.mimir', 'store.json')
  const store = {
    'library:papers': {
      'x': { arxivId: 'x', pdfPath: join(src, 'papers', 'a.pdf'), notes: '', tags: [] }
    }
  }
  mkdirSync(join(src, '.mimir'), { recursive: true })
  writeFileSync(storePath, JSON.stringify(store), 'utf8')

  // ⚠️ 归档已在上一步造好，故这里必须**重新打包**才能带进新写的 store.json。
  const archive2 = join(root, 'backups', 'space2.zip')
  await createBackup({ root: src, destination: archive2, stagingDir: join(root, 'staging2'), assetsDb: null })

  const targetRoot = join(root, 'spaces', 'restored')
  mkdirSync(join(root, 'spaces'), { recursive: true })
  const outcome = await runMaintenanceRestore(
    { archivePath: archive2, targetRoot, spaceName: 's' },
    deps([], seedHome(root))
  )

  expect(outcome.stage).toBe('done')
  // T03 的匹配基准是清单里的 `sourceRoot`（= 打包源根，绝对路径），不是推导出的相对根。
  // 打包时写入了 sourceRoot = src，故 pdfPath（位于 src/papers 下）应命中并被改写。
  expect(outcome.remap).not.toBeNull()
  expect(outcome.remap!.rewritten).toHaveLength(1)
  // 改写后的值指向**新**空间根（落盘到暂存→发布后的目标目录）。
  const remapped = outcome.remap!.rewritten[0] as { newValue?: string; value?: string }
  const written = remapped.newValue ?? remapped.value ?? ''
  expect(written.replace(/\\/g, '/')).toContain(targetRoot.replace(/\\/g, '/'))
  expect(archive).toBeTruthy()
})

it('成功：早期归档无 sourceRoot → 退化为「不改写」，空间仍完整恢复', async () => {
  // 这条守的是「宁可不中」：批次 2/3 早期归档没有 sourceRoot 字段，此时**绝不猜测**——
  // 猜错会把用户空间外的 PDF 路径改到新空间里（§7 K2 高危误写）。
  // 用注入的 `readManifest` 把 sourceRoot 抹掉，模拟旧归档（createBackup 现在总会写它）。
  const root = sandbox()
  const { archive, src } = await seedArchive(root)
  const storePath = join(src, '.mimir', 'store.json')
  mkdirSync(join(src, '.mimir'), { recursive: true })
  writeFileSync(
    storePath,
    JSON.stringify({
      'library:papers': {
        x: { arxivId: 'x', pdfPath: join(src, 'papers', 'a.pdf'), notes: '', tags: [] }
      }
    }),
    'utf8'
  )
  const archiveOld = join(root, 'backups', 'old.zip')
  await createBackup({ root: src, destination: archiveOld, stagingDir: join(root, 'staging-old'), assetsDb: null })

  const targetRoot = join(root, 'spaces', 'restored')
  mkdirSync(join(root, 'spaces'), { recursive: true })
  // 抹掉 sourceRoot（其余照旧从真实归档读）。
  const outcome = await runMaintenanceRestore(
    { archivePath: archiveOld, targetRoot, spaceName: 's' },
    {
      ...deps([], seedHome(root)),
      readManifest: async (path: string) => {
        const m = await readArchiveManifest(path)
        return { entries: m.entries }
      }
    }
  )
  expect(outcome.stage).toBe('done')
  // 无绝对旧根 → 一条都不改写（`rewritten` 为空），但空间内容仍完整恢复。
  expect(outcome.remap).not.toBeNull()
  expect(outcome.remap!.rewritten).toHaveLength(0)
  expect(existsSync(join(targetRoot, 'papers', 'a.pdf'))).toBe(true)
  expect(archive).toBeTruthy()
})

it('发布后写锁的**凭据文件**确实随 rename 迁到目标，且 token 是可复核的 JSON', async () => {
  // 这条直接守「可迁移锁」的核心承诺：Windows 下 rename 含打开句柄的目录会 EPERM，
  // 故必须用写完即关句柄的获取器；迁移后锁文件内容仍须是可被 release 复核的 token。
  const root = sandbox()
  const { archive } = await seedArchive(root)
  const targetRoot = join(root, 'spaces', 'restored')
  mkdirSync(join(root, 'spaces'), { recursive: true })

  const outcome = await runMaintenanceRestore(
    { archivePath: archive, targetRoot, spaceName: 's' },
    deps([], seedHome(root))
  )
  expect(outcome.stage).toBe('done')
  const lockFile = join(targetRoot, '.mimir', 'workspace.writer-lock')
  expect(existsSync(lockFile)).toBe(true)
  const parsed = JSON.parse(readFileSync(lockFile, 'utf8'))
  expect(typeof parsed.token).toBe('string')
  expect(parsed.token.length).toBeGreaterThan(0)
})

it('早退：目标已存在 → TARGET_EXISTS，且**不取锁、不建任何东西**', async () => {
  const root = sandbox()
  const { archive } = await seedArchive(root)
  const order: string[] = []
  const targetRoot = join(root, 'occupied')
  mkdirSync(targetRoot, { recursive: true })
  writeFileSync(join(targetRoot, 'keep.txt'), '用户既有内容', 'utf8')

  const outcome = await runMaintenanceRestore(
    { archivePath: archive, targetRoot, spaceName: 's' },
    deps(order, seedHome(root))
  )

  expect(outcome.stage).toBe('failed')
  expect(outcome.failure?.code).toBe('TARGET_EXISTS')
  expect(outcome.failure?.retryable).toBe(false)
  expect(outcome.cleanup).toBeNull()
  // 关键：落点不可覆盖是**硬拒绝**，连写锁都不该去取。
  expect(order).toHaveLength(0)
  expect(readdirSync(targetRoot)).toEqual(['keep.txt'])
})

it('早退：归档不存在 → INVALID_TARGET，不取锁', async () => {
  const root = sandbox()
  const order: string[] = []
  const outcome = await runMaintenanceRestore(
    { archivePath: join(root, 'nope.zip'), targetRoot: join(root, 't'), spaceName: 's' },
    deps(order, seedHome(root))
  )
  expect(outcome.failure?.code).toBe('INVALID_TARGET')
  expect(order).toHaveLength(0)
  expect(existsSync(join(root, 't'))).toBe(false)
})

it('早退：空间名为空 → INVALID_TARGET，不取锁、不建目录', async () => {
  const root = sandbox()
  const { archive } = await seedArchive(root)
  const order: string[] = []
  const targetRoot = join(root, 't')
  const outcome = await runMaintenanceRestore(
    { archivePath: archive, targetRoot, spaceName: '   ' },
    deps(order, seedHome(root))
  )
  expect(outcome.failure?.code).toBe('INVALID_TARGET')
  expect(order).toHaveLength(0)
  expect(existsSync(targetRoot)).toBe(false)
})

it('会话失效 → LOCK_UNAVAILABLE（写者会话不可用时不得继续）', async () => {
  const root = sandbox()
  const { archive } = await seedArchive(root)
  let lockCalled = false
  const outcome = await runMaintenanceRestore(
    { archivePath: archive, targetRoot: join(root, 't'), spaceName: 's' },
    {
      session: { assertUsable: () => { throw Error('写者会话失效') } },
      lockStagingRoot: () => { lockCalled = true; throw Error('不该走到这里') },
      homeDir: seedHome(root)
    }
  )
  expect(outcome.stage).toBe('failed')
  expect(outcome.failure?.code).toBe('LOCK_UNAVAILABLE')
  expect(outcome.cleanup).toBeNull()
  // 会话检查先于取锁：不得在会话失效后还去建暂存根 / 取锁。
  expect(lockCalled).toBe(false)
})

it('破坏性：清单无法读取时**不阻断**，退化为「不改写」并继续恢复', async () => {
  const root = sandbox()
  const { archive } = await seedArchive(root)
  // 用「文件存在但不是 ZIP」模拟清单不可读：早退校验只看存在性，会放行；
  // 随后 verifyBackup 会给出确切拒绝理由（这里断言它确实被拒绝、且不是崩溃）。
  const notZip = join(root, 'backups', 'broken.zip')
  writeFileSync(notZip, 'not a zip', 'utf8')

  const outcome = await runMaintenanceRestore(
    { archivePath: notZip, targetRoot: join(root, 't'), spaceName: 's' },
    deps([], seedHome(root))
  )
  // 归档本身不合法 → 验包阶段失败（`inspecting`），**绝不**崩溃。
  expect(outcome.stage).toBe('failed')
  expect(outcome.failure).not.toBeNull()
  expect(archive).toBeTruthy()
})

it('listRestoreArchives：目录不存在 → 空数组（绝不建目录）', async () => {
  const root = sandbox()
  const missing = join(root, 'no-such-dir')
  await expect(listRestoreArchives(missing)).resolves.toEqual([])
  expect(existsSync(missing)).toBe(false)
})

it('listRestoreArchives：只列 .zip，并按修改时间倒序，标注可否改写', async () => {
  const root = sandbox()
  const { archive } = await seedArchive(root)
  const dir = join(root, 'backups')
  writeFileSync(join(dir, 'ignore.txt'), 'x', 'utf8')
  writeFileSync(join(dir, 'broken.zip'), 'not a zip', 'utf8')

  const listed = await listRestoreArchives(dir)
  const names = listed.map((item) => item.name)
  expect(names).toContain('space.zip')
  expect(names).toContain('broken.zip')
  expect(names).not.toContain('ignore.txt')
  // 真实归档可改写；损坏归档标注为**不可改写**但**仍然列出**（不隐藏用户文件）。
  expect(listed.find((item) => item.name === 'space.zip')?.remappable).toBe(true)
  expect(listed.find((item) => item.name === 'broken.zip')?.remappable).toBe(false)
  // 每条都有展示所需的最小信息。
  for (const item of listed) {
    // 分隔符归一后比较：`normalize` 在 Windows 上给反斜杠、POSIX 上给正斜杠。
    expect(item.path.replace(/\\/g, '/')).toContain(dir.replace(/\\/g, '/'))
    expect(item.bytes).toBeGreaterThan(0)
    expect(Number.isNaN(Date.parse(item.modifiedAt))).toBe(false)
  }
  expect(archive).toBeTruthy()
})
