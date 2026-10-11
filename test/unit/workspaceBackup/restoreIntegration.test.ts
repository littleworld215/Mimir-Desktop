import { expect, it, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, readdirSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join, sep } from 'node:path'

/**
 * 端到端恢复集成测试（I6 批次 3 · 第 4 块验收）。
 *
 * 与 `restoreRunner.test.ts` 的区别：**那条用注入的假实现**断言失败语义的副作用；
 * 这条跑**真实链路**——批次 2 的 packer 真打包 → verify → 真实适配器 → runRestore →
 * 断言新空间内容、源空间**逐字节未动**、注册表只追加一条。
 *
 * 之所以必须动态 import：`vitest.config.ts` 把 `electron/library/store.ts` alias 到了 stub，
 * 静态 import 拿到的是替身（沿用 `registryView.test.ts` 的 `subject()` 手法）。
 */
async function mod<T = any>(rel: string): Promise<T> {
  const loaded = await import(/* @vite-ignore */ join(process.cwd(), rel))
  return loaded as T
}

const roots: string[] = []
function sandbox(): string {
  const root = mkdtempSync(join(tmpdir(), 'mimir-restore-it-'))
  roots.push(root)
  return root
}
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

/** 目录下所有文件的「相对路径:内容SHA256」指纹（排序后），用于「逐字节未动」比对。 */
function fingerprint(dir: string): string {
  const collect = (current: string, base: string): string[] => {
    const out: string[] = []
    for (const entry of readdirSync(current, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const abs = join(current, entry.name)
      if (entry.isDirectory()) out.push(...collect(abs, base))
      else out.push(abs.slice(base.length).split(sep).join('/'))
    }
    return out
  }
  return collect(dir, dir)
    .map((rel) => `${rel}:${createHash('sha256').update(readFileSync(join(dir, rel))).digest('hex')}`)
    .join('\n')
}

const HOME_REGISTRY = {
  settings: { theme: 'dark', apiKey: 'synthetic-secret' },
  'servers:list': [{ name: 's1', password: 'synthetic-password' }],
  activeWorkspaceId: 'origin-space',
  defaultWorkspaceId: 'origin-space',
  'workspaces:list': [{ id: 'origin-space', name: '原空间', path: 'C:/spaces/origin', createdAt: 'c', updatedAt: 'u' }]
}

/** 种一个合成 home（**绝不**写真实 `~/.mimir`），返回 home 与注册表路径。 */
function seedHome(root: string): { home: string; registry: string } {
  const home = join(root, 'home')
  mkdirSync(join(home, '.mimir'), { recursive: true })
  const registry = join(home, '.mimir', 'store.json')
  writeFileSync(registry, JSON.stringify(HOME_REGISTRY, null, 2), 'utf8')
  return { home, registry }
}

/**
 * 种一个源科研空间：
 * - 论文 A 的 `pdfPath` 指向**空间内**（应被 R1 改写）；
 * - 论文 B 的 `pdfPath` 指向**空间外**（应进 skipped，逐字保留）；
 * - `notes` / `tags` / `project.paperDir` 里**故意嵌入旧空间根路径**——它们必须逐字不变
 *   （这是设计 §7 K1「重映射误伤正文」的核心防线）。
 */
function seedSourceSpace(root: string): { src: string; store: string } {
  const src = join(root, 'src')
  mkdirSync(join(src, '.mimir'), { recursive: true })
  mkdirSync(join(src, 'papers'), { recursive: true })
  writeFileSync(join(src, 'papers', 'a.pdf'), 'PDF-A-CONTENT-0123456789', 'utf8')
  const store = {
    'library:papers': {
      '2103.00020v2': {
        arxivId: '2103.00020v2',
        title: '论文A',
        url: 'https://arxiv.org/abs/2103.00020',
        notes: `笔记里提到了旧路径 ${join(src, 'papers', 'a.pdf')}，这段自由文本绝不能被改写`,
        summary: '摘要 A',
        tags: [join(src, 'papers', 'a.pdf')],
        pdfPath: join(src, 'papers', 'a.pdf'),
        addedAt: '2026-01-01T00:00:00.000Z'
      },
      'doi:10.1000/b': {
        arxivId: 'doi:10.1000/b',
        title: '论文B',
        url: 'https://example.org/b',
        notes: '',
        summary: '摘要 B',
        tags: [],
        pdfPath: join(root, 'outside', 'manual', 'b.pdf'),
        addedAt: '2026-01-02T00:00:00.000Z'
      }
    },
    'library:projects': [
      { id: 'p1', title: '项目一', paperDir: join(root, 'outside', 'latex'), createdAt: 'c', updatedAt: 'u' }
    ]
  }
  const storePath = join(src, '.mimir', 'store.json')
  writeFileSync(storePath, JSON.stringify(store, null, 2), 'utf8')
  return { src, store: storePath }
}

it('端到端：打包真实空间 → 恢复到新目录，源空间逐字节未动、注册表只追加一条', async () => {
  const { createBackup } = await mod('electron/workspaceBackup/packer.ts')
  const { runRestore } = await mod('electron/workspaceBackup/restoreRunner.ts')
  const { createRestoreSteps } = await mod('electron/workspaceBackup/restoreAdapter.ts')
  const { stagingPathFor } = await mod('electron/workspaceBackup/stagingRoot.ts')
  const { normalizeRootForMatch } = await mod('electron/workspaceBackup/remapRules.ts')

  const root = sandbox()
  const { home, registry } = seedHome(root)
  const { src } = seedSourceSpace(root)

  // ── ① 真实打包 ────────────────────────────────────────────────
  mkdirSync(join(root, 'backups'), { recursive: true })
  const archive = join(root, 'backups', 'space.zip')
  const backups = await createBackup({ root: src, destination: archive, stagingDir: join(root, 'staging'), assetsDb: null })
  expect(backups.entries).toBeGreaterThan(0)
  expect(existsSync(archive)).toBe(true)

  const sourceBefore = fingerprint(src)
  const registryBefore = readFileSync(registry, 'utf8')

  // ── ② 真实恢复 ────────────────────────────────────────────────
  const parent = join(root, 'spaces')
  mkdirSync(parent, { recursive: true })
  const targetRoot = join(parent, 'restored')
  const outcome = await runRestore(
    {
      archivePath: archive,
      targetRoot,
      stagingRoot: stagingPathFor(targetRoot, 'it'),
      homeDir: home,
      spaceName: '恢复的新空间',
      oldRoot: src
    },
    createRestoreSteps({ now: () => '2026-10-11T00:00:00.000Z' }),
    { newId: () => 'restored-space-uuid', now: () => new Date('2026-10-11T00:00:00.000Z') }
  )

  // ── ③ 编排结果 ────────────────────────────────────────────────
  expect(outcome.failure).toBeNull()
  expect(outcome.stage).toBe('done')
  expect(outcome.result).not.toBeNull()
  expect(outcome.result!.spaceId).toBe('restored-space-uuid')

  // ── ④ 新空间内容 ──────────────────────────────────────────────
  expect(readFileSync(join(targetRoot, 'papers', 'a.pdf'), 'utf8')).toBe('PDF-A-CONTENT-0123456789')

  const restoredStore = JSON.parse(readFileSync(join(targetRoot, '.mimir', 'store.json'), 'utf8'))
  const paperA = restoredStore['library:papers']['2103.00020v2']
  const paperB = restoredStore['library:papers']['doi:10.1000/b']

  // R1：空间内的 pdfPath 已改写为新空间根（归一化后比较，绕开分隔符/大小写差异）
  expect(normalizeRootForMatch(paperA.pdfPath)).toBe(normalizeRootForMatch(join(targetRoot, 'papers', 'a.pdf')))
  expect(paperA.pdfPath).not.toBe(join(src, 'papers', 'a.pdf'))

  // K1：自由文本**逐字未变**——这是「重映射误伤正文」的核心断言
  expect(paperA.notes).toContain(join(src, 'papers', 'a.pdf'))
  expect(paperA.summary).toBe('摘要 A')
  expect(paperA.tags).toEqual([join(src, 'papers', 'a.pdf')])

  // skipped：空间外的 pdfPath 原样保留
  expect(paperB.pdfPath).toBe(join(root, 'outside', 'manual', 'b.pdf'))
  // ProjectRecord.paperDir 绝不改写
  expect(restoredStore['library:projects'][0].paperDir).toBe(join(root, 'outside', 'latex'))

  // 审计报告如实反映：1 条改写、1 条未命中
  expect(outcome.remap!.rewritten).toHaveLength(1)
  expect(outcome.remap!.skipped.length).toBeGreaterThanOrEqual(1)

  // ── ⑤ 源空间逐字节未动（I6「不覆盖」的核心保证）────────────────
  expect(fingerprint(src)).toBe(sourceBefore)

  // ── ⑥ 注册表只追加一条，指针与全局键逐字不变 ───────────────────
  const after = JSON.parse(readFileSync(registry, 'utf8'))
  expect(after['workspaces:list']).toHaveLength(2)
  expect(after['workspaces:list'][1]).toMatchObject({
    id: 'restored-space-uuid',
    name: '恢复的新空间',
    path: targetRoot,
    createdAt: '2026-10-11T00:00:00.000Z'
  })
  expect(after.settings).toEqual(HOME_REGISTRY.settings)
  expect(after['servers:list']).toEqual(HOME_REGISTRY['servers:list'])
  expect(after.activeWorkspaceId).toBe('origin-space')
  expect(after.defaultWorkspaceId).toBe('origin-space')

  // 保护快照存在（写前留原字节）
  const snapshots = readdirSync(join(home, '.mimir')).filter((name) => name.includes('.pre-restore-'))
  expect(snapshots.length).toBeGreaterThanOrEqual(1)
  expect(registryBefore).toBe(JSON.stringify(HOME_REGISTRY, null, 2))
})

it('端到端：目标已存在 → TARGET_EXISTS，源空间与注册表均逐字节未动', async () => {
  const { createBackup } = await mod('electron/workspaceBackup/packer.ts')
  const { runRestore } = await mod('electron/workspaceBackup/restoreRunner.ts')
  const { createRestoreSteps } = await mod('electron/workspaceBackup/restoreAdapter.ts')
  const { stagingPathFor } = await mod('electron/workspaceBackup/stagingRoot.ts')

  const root = sandbox()
  const { home, registry } = seedHome(root)
  const { src } = seedSourceSpace(root)

  mkdirSync(join(root, 'backups'), { recursive: true })
  const archive = join(root, 'backups', 'space.zip')
  await createBackup({ root: src, destination: archive, stagingDir: join(root, 'staging'), assetsDb: null })

  // 目标**预先存在**：落点不可覆盖是硬拒绝
  const parent = join(root, 'spaces')
  mkdirSync(join(parent, 'occupied'), { recursive: true })
  writeFileSync(join(parent, 'occupied', 'keep.txt'), '用户既有内容', 'utf8')
  const targetRoot = join(parent, 'occupied')

  const sourceBefore = fingerprint(src)
  const registryBefore = readFileSync(registry, 'utf8')

  const outcome = await runRestore(
    {
      archivePath: archive,
      targetRoot,
      stagingRoot: stagingPathFor(targetRoot, 'it'),
      homeDir: home,
      spaceName: '不该被创建的空间',
      oldRoot: src
    },
    createRestoreSteps(),
    { newId: () => 'never-used' }
  )

  expect(outcome.stage).toBe('failed')
  expect(outcome.failure).not.toBeNull()
  expect(outcome.failure!.code).toBe('TARGET_EXISTS')
  expect(outcome.result).toBeNull()
  // 零副作用：既没建暂存根，也没注册
  expect(outcome.cleanup).toBeNull()

  // 用户既有目录**必须**原样保留（这也是 targetCreated 探针绝不误删的端到端证明）
  expect(readFileSync(join(targetRoot, 'keep.txt'), 'utf8')).toBe('用户既有内容')
  expect(fingerprint(src)).toBe(sourceBefore)
  expect(readFileSync(registry, 'utf8')).toBe(registryBefore)
})
