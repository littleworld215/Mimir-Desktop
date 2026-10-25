import { expect, it, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

import { createBackup } from '../../../electron/workspaceBackup/packer'
import {
  normalizeRestoreRequest,
  toRestoreResult,
  buildRestoreHandler,
  registerRestoreHandler
} from '../../../electron/workspaceBackup/maintenanceRestoreHandler'
import { runMaintenanceRestore } from '../../../electron/workspaceBackup/restoreMain'
import type { RestoreOutcome } from '../../../electron/workspaceBackup/restoreRunner'
import type { MaintenanceRestoreRequest } from '../../../shared/workspaceBackupContracts'
import type { RestoreHandlerDeps } from '../../../electron/workspaceBackup/maintenanceRestoreHandler'

it('原生选择取消后不得执行文本建议路径', async () => {
  let called = false
  const handler = buildRestoreHandler({ homeDir: 'synthetic', session: { assertUsable() {} },
    selectRequest: async () => null,
    run: async () => { called = true; throw Error('unexpected path execution') }
  } as RestoreHandlerDeps)
  const result = await handler({ archivePath: 'C:/suggested.zip', targetRoot: 'C:/suggested-target', spaceName: '合成' })
  expect(result).toMatchObject({ ok: false, code: 'CANCELLED' })
  expect(called).toBe(false)
})

it('生产选择器的额外字段拒绝不会被旧规范化静默丢弃', async () => {
  let called = false
  const handler = buildRestoreHandler({ homeDir: 'synthetic', session: { assertUsable() {} },
    selectRequest: async (request: unknown) => { expect(request).toHaveProperty('unsafe'); throw Error('invalid request') },
    run: async () => { called = true; throw Error('unexpected') }
  } as RestoreHandlerDeps)
  expect(await handler({ archivePath: 'C:/suggested.zip', targetRoot: 'C:/target', spaceName: '合成', unsafe: true } as MaintenanceRestoreRequest)).toMatchObject({ ok: false, code: 'SELECTION_CHANGED' })
  expect(called).toBe(false)
})

/**
 * 维护模式恢复 IPC 装配（I6 批次 3 · T05 收口）。
 *
 * 目标：**不启动 Electron** 验证装配层的三件事：
 * 1. 规范化（§4.2 S7：绝不信任渲染层拼的路径）；
 * 2. 结果映射（**绝不**把 `cleanup` / `remap` / 暂存根路径泄漏给渲染层）；
 * 3. sender 校验（非信任 sender → `UNAUTHORIZED_SENDER`）。
 *
 * 一条**端到端**用例跑真服务层 + 真临时目录，证明装配层能真正驱动一次恢复。
 */

const roots: string[] = []
function sandbox(): string {
  const root = mkdtempSync(join(tmpdir(), 'mimir-restore-ipc-'))
  roots.push(root)
  return root
}
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

/** 合成 home + 最小注册表（**绝不**写真实 `~/.mimir`）。 */
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

/** 造一份真实归档。 */
async function seedArchive(root: string): Promise<string> {
  const src = join(root, 'src')
  mkdirSync(join(src, 'papers'), { recursive: true })
  writeFileSync(join(src, 'papers', 'a.pdf'), 'PDF-A', 'utf8')
  mkdirSync(join(root, 'backups'), { recursive: true })
  const archive = join(root, 'backups', 'space.zip')
  await createBackup({ root: src, destination: archive, stagingDir: join(root, 'staging'), assetsDb: null })
  return archive
}

/** 记录调用顺序的假会话。 */
function fakeSession(order: string[]): { assertUsable(): void } {
  return { assertUsable: () => { order.push('assertUsable') } }
}

/** 可断言「是否被取锁」的假取锁器。 */
function fakeLock(order: string[], throwOnCall = false) {
  return (stagingRoot: string) => {
    order.push(`lock:${stagingRoot}`)
    if (throwOnCall) throw Error('不应取锁')
    return { release: () => { order.push('release') } }
  }
}

// ── 1. 规范化（§4.2 S7） ────────────────────────────────────────────────

it('normalizeRestoreRequest：targetRoot 被 path.resolve 成绝对路径，字符串 trim', () => {
  const normalized = normalizeRestoreRequest({
    archivePath: '  C:/a/b.zip  ',
    targetRoot: '  C:/x/../y/new space  ',
    spaceName: '  我的空间  '
  })
  expect(normalized).not.toBeNull()
  expect(normalized!.archivePath).toBe('C:/a/b.zip')
  expect(normalized!.spaceName).toBe('我的空间')
  // resolve 消除了 `..` 段。
  expect(normalized!.targetRoot).toBe(resolve('C:/x/../y/new space'))
  expect(normalized!.targetRoot).not.toContain('..')
})

it('normalizeRestoreRequest：空 spaceName / 空 targetRoot / 空 archivePath → null', () => {
  expect(normalizeRestoreRequest({ archivePath: 'a.zip', targetRoot: 'C:/t', spaceName: '   ' })).toBeNull()
  expect(normalizeRestoreRequest({ archivePath: 'a.zip', targetRoot: '   ', spaceName: 's' })).toBeNull()
  expect(normalizeRestoreRequest({ archivePath: '  ', targetRoot: 'C:/t', spaceName: 's' })).toBeNull()
})

// ── 2. 结果映射（**绝不**泄漏本机路径） ─────────────────────────────────

it('toRestoreResult：成功 → {ok:true,...}；**不含** cleanup / remap / 暂存根路径', () => {
  const outcome: RestoreOutcome = {
    stage: 'done',
    failure: null,
    result: { spaceId: 'id-1', name: '新空间', root: 'C:/spaces/new', entries: 7, totalBytes: 999 },
    // remap 报告含本机路径——**不得**出现在渲染层结果里。
    remap: {
      found: [],
      rewritten: [{ oldValue: 'C:/old/papers/a.pdf', newValue: 'C:/spaces/new/papers/a.pdf' } as never],
      skipped: [],
      observed: []
    },
    cleanup: null,
    finishedAt: '2024-01-01T00:00:00.000Z'
  }
  const result = toRestoreResult(outcome)
  expect(result.ok).toBe(true)
  if (!result.ok) throw Error('unreachable')
  expect(result).toEqual({
    ok: true,
    spaceId: 'id-1',
    name: '新空间',
    root: 'C:/spaces/new',
    entries: 7,
    totalBytes: 999,
    rewritten: 1
  })
  // 关键：渲染层结果里**不含**任何内部字段 / 本机暂存路径。
  expect('cleanup' in result).toBe(false)
  expect('remap' in result).toBe(false)
  expect(JSON.stringify(result)).not.toContain('mimir-restore-staging')
  expect(JSON.stringify(result)).not.toContain('oldValue')
})

it('G04关联结果只透出安全计数，不透出旧路径或模板正文', () => {
  const outcome: RestoreOutcome = {
    stage: 'done', failure: null, result: { spaceId: 'id', name: '新空间', root: 'C:/new', entries: 1, totalBytes: 1 },
    remap: { found: [], rewritten: [], skipped: [], observed: [], associations: { snapshotsRelinked: 2, unknownSnapshotBuckets: 1,
      templatesRelinked: 1, unresolvedTemplates: 3, externalSnapshotBuckets: 4, oldRoot: 'C:/private', template: 'secret content' } as never },
    cleanup: null, finishedAt: '2026-10-24'
  }
  const result = toRestoreResult(outcome)
  expect(result).toMatchObject({ associations: { snapshotsRelinked: 2, unknownSnapshotBuckets: 1, templatesRelinked: 1, unresolvedTemplates: 3, externalSnapshotBuckets: 4 } })
  expect(JSON.stringify(result)).not.toContain('private')
  expect(JSON.stringify(result)).not.toContain('secret content')
})

it('toRestoreResult：失败 → {ok:false, code, detail, retryable}；不含 cleanup 路径', () => {
  const outcome: RestoreOutcome = {
    stage: 'failed',
    failure: { stage: 'inspecting', code: 'TARGET_EXISTS', retryable: false, detail: '目标已存在' },
    result: null,
    remap: null,
    cleanup: { stagingRoot: 'C:/parent/.mimir-restore-staging-abc', createdTarget: null },
    finishedAt: '2024-01-01T00:00:00.000Z'
  }
  const result = toRestoreResult(outcome)
  expect(result).toEqual({ ok: false, code: 'TARGET_EXISTS', detail: '目标已存在', retryable: false })
  expect(JSON.stringify(result)).not.toContain('.mimir-restore-staging')
})

// ── 3. buildRestoreHandler：端到端 / 早退 / 不取锁 ──────────────────────

it('成功（端到端）：合法请求 → 真服务层 + 真临时目录 → {ok:true,...}', async () => {
  const root = sandbox()
  const archive = await seedArchive(root)
  const targetRoot = join(root, 'spaces', 'restored')
  mkdirSync(join(root, 'spaces'), { recursive: true })
  const home = seedHome(root)

  const handler = buildRestoreHandler({
    session: { assertUsable: () => {} },
    homeDir: home
    // 不注入 run / lockStagingRoot：走真服务层 + 真取锁器。
  })

  const result = await handler({ archivePath: archive, targetRoot, spaceName: '恢复的空间' })
  expect(result.ok).toBe(true)
  if (!result.ok) throw Error('unreachable')
  expect(result.name).toBe('恢复的空间')
  expect(result.entries).toBeGreaterThan(0)
  // 内容真的落到了目标目录。
  expect(existsSync(join(targetRoot, 'papers', 'a.pdf'))).toBe(true)
  expect(JSON.stringify(result)).not.toContain('mimir-restore-staging')
})

it('失败映射：targetRoot 已存在 → {ok:false, code:"TARGET_EXISTS"}', async () => {
  const root = sandbox()
  const archive = await seedArchive(root)
  const targetRoot = join(root, 'occupied')
  mkdirSync(targetRoot, { recursive: true })
  writeFileSync(join(targetRoot, 'keep.txt'), '用户既有内容', 'utf8')

  const handler = buildRestoreHandler({ session: { assertUsable: () => {} }, homeDir: seedHome(root) })
  const result = await handler({ archivePath: archive, targetRoot, spaceName: 's' })
  expect(result).toEqual({ ok: false, code: 'TARGET_EXISTS', detail: expect.any(String), retryable: false })
})

it('失败映射：父目录不存在 → INVALID_TARGET', async () => {
  const root = sandbox()
  const archive = await seedArchive(root)
  const targetRoot = join(root, 'very', 'deep', 'new', 'tree', 'restored')

  const handler = buildRestoreHandler({ session: { assertUsable: () => {} }, homeDir: seedHome(root) })
  const result = await handler({ archivePath: archive, targetRoot, spaceName: 's' })
  expect(result.ok).toBe(false)
  if (result.ok) throw Error('unreachable')
  expect(result.code).toBe('INVALID_TARGET')
})

it('早退：空 spaceName → INVALID_TARGET，且**不取锁、不调服务层**', async () => {
  const order: string[] = []
  let runCalled = false
  const handler = buildRestoreHandler({
    session: fakeSession(order),
    homeDir: 'C:/synthetic-home',
    // 服务层不该被调用；若被调用则置位（可断言）。
    run: (async () => { runCalled = true; return {} as RestoreOutcome }) as typeof runMaintenanceRestore,
    lockStagingRoot: fakeLock(order, true)
  })
  const result = await handler({ archivePath: 'C:/a.zip', targetRoot: 'C:/t', spaceName: '   ' })
  expect(result.ok).toBe(false)
  if (result.ok) throw Error('unreachable')
  expect(result.code).toBe('INVALID_TARGET')
  expect(runCalled).toBe(false)
  expect(order).toHaveLength(0)
})

it('早退：空 targetRoot → INVALID_TARGET，且不取锁', async () => {
  const order: string[] = []
  const handler = buildRestoreHandler({
    session: fakeSession(order),
    homeDir: 'C:/synthetic-home',
    lockStagingRoot: fakeLock(order, true)
  })
  const result = await handler({ archivePath: 'C:/a.zip', targetRoot: '  ', spaceName: 's' })
  expect(result.ok).toBe(false)
  if (result.ok) throw Error('unreachable')
  expect(result.code).toBe('INVALID_TARGET')
  expect(order).toHaveLength(0)
})

it('session 未就绪（undefined）→ LOCK_UNAVAILABLE（绝不无锁写入）', async () => {
  const root = sandbox()
  const archive = await seedArchive(root)
  const targetRoot = join(root, 'spaces', 'restored')
  mkdirSync(join(root, 'spaces'), { recursive: true })

  const handler = buildRestoreHandler({ session: undefined, homeDir: seedHome(root) })
  const result = await handler({ archivePath: archive, targetRoot, spaceName: 's' })
  expect(result.ok).toBe(false)
  if (result.ok) throw Error('unreachable')
  expect(result.code).toBe('LOCK_UNAVAILABLE')
  // 会话不可用 → 目标目录不应被创建（早退零副作用）。
  expect(existsSync(targetRoot)).toBe(false)
})

it('session 抛错 → LOCK_UNAVAILABLE（不继续恢复）', async () => {
  const root = sandbox()
  const archive = await seedArchive(root)
  const targetRoot = join(root, 'spaces', 'restored')
  mkdirSync(join(root, 'spaces'), { recursive: true })

  const handler = buildRestoreHandler({
    session: { assertUsable: () => { throw Error('写者会话失效') } },
    homeDir: seedHome(root)
  })
  const result = await handler({ archivePath: archive, targetRoot, spaceName: 's' })
  expect(result.ok).toBe(false)
  if (result.ok) throw Error('unreachable')
  expect(result.code).toBe('LOCK_UNAVAILABLE')
})

it('成功：规范化后的入参被传给服务层（targetRoot 已 resolve）', async () => {
  const order: string[] = []
  let seen: MaintenanceRestoreRequest | undefined
  const handler = buildRestoreHandler({
    session: fakeSession(order),
    homeDir: 'C:/synthetic-home',
    run: (async (request: MaintenanceRestoreRequest) => {
      seen = request
      return {
        stage: 'done',
        failure: null,
        result: { spaceId: 'id', name: request.spaceName, root: request.targetRoot, entries: 1, totalBytes: 1 },
        remap: { found: [], rewritten: [], skipped: [], observed: [] },
        cleanup: null,
        finishedAt: '2024-01-01T00:00:00.000Z'
      } as RestoreOutcome
    }) as typeof runMaintenanceRestore
  })
  const result = await handler({ archivePath: '  C:/a.zip ', targetRoot: ' ../x/new ', spaceName: ' s ' })
  expect(result.ok).toBe(true)
  expect(seen).toBeDefined()
  expect(seen!.archivePath).toBe('C:/a.zip')
  expect(seen!.spaceName).toBe('s')
  expect(seen!.targetRoot).toBe(resolve('../x/new'))
})

// ── 4. sender 校验 ──────────────────────────────────────────────────────

it('registerRestoreHandler：非信任 sender → 抛 UNAUTHORIZED_SENDER（不触发恢复）', () => {
  let invoked = false
  const captured: { listener?: (event: unknown, ...args: unknown[]) => unknown } = {}
  const ipc = {
    handle: (channel: string, listener: (event: unknown, ...args: unknown[]) => unknown) => {
      expect(channel).toBe('workspaceBackup:restore')
      captured.listener = listener
    }
  }
  const handler = buildRestoreHandler({
    session: { assertUsable: () => {} },
    homeDir: 'C:/synthetic-home',
    run: (async () => { invoked = true; return {} as RestoreOutcome }) as typeof runMaintenanceRestore
  })
  registerRestoreHandler(ipc, () => false, handler)
  expect(() => captured.listener!({ sender: 'untrusted' }, { archivePath: 'a', targetRoot: 'C:/t', spaceName: 's' }))
    .toThrowError('UNAUTHORIZED_SENDER')
  expect(invoked).toBe(false)
})

it('registerRestoreHandler：信任 sender → 正常返回结果', async () => {
  const captured: { listener?: (event: unknown, ...args: unknown[]) => unknown } = {}
  const ipc = {
    handle: (_channel: string, listener: (event: unknown, ...args: unknown[]) => unknown) => {
      captured.listener = listener
    }
  }
  const handler = buildRestoreHandler({
    session: { assertUsable: () => {} },
    homeDir: 'C:/synthetic-home',
    run: (async (request: MaintenanceRestoreRequest) => ({
      stage: 'done',
      failure: null,
      result: { spaceId: 'id', name: request.spaceName, root: request.targetRoot, entries: 1, totalBytes: 1 },
      remap: { found: [], rewritten: [], skipped: [], observed: [] },
      cleanup: null,
      finishedAt: '2024-01-01T00:00:00.000Z'
    } as RestoreOutcome)) as typeof runMaintenanceRestore
  })
  registerRestoreHandler(ipc, () => true, handler)
  const result = await (captured.listener!({ sender: 'trusted' }, { archivePath: 'a.zip', targetRoot: 'C:/t', spaceName: 's' }) as Promise<unknown>)
  expect(result).toMatchObject({ ok: true, name: 's' })
})
