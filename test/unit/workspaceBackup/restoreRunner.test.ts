/**
 * `restoreRunner` 单测：逐条验证设计 `docs/design/I6-BATCH3-RESTORE.md` §1.3 的失败语义表。
 *
 * **反假绿要求**：本文件全部用**注入的假 steps**，每条失败用例都必须带**副作用断言**
 * ——即断言「哪一步被调用、哪一步**没**被调用」。只断言 `stage`/`code` 无法证明 §1.3 成立
 * （例如 `verifying` 失败是否误清了暂存根，只有副作用断言能查出来）。
 *
 * 说明：runner 采用「抛错即失败」的注入契约，因此这里抛的是 `restoreContracts.RestoreError`；
 * runner 的鸭子判定保证即使两份模块图各自加载了 `restoreContracts`，错误码也不会被降级。
 */

import { expect, it } from 'vitest'
import { join } from 'node:path'
import { readFileSync } from 'node:fs'

async function runnerModule() {
  const mod = await import(/* @vite-ignore */ join(process.cwd(), 'electron/workspaceBackup/restoreRunner.ts')).catch(() => ({} as any))
  expect(mod.runRestore).toBeTypeOf('function')
  return mod
}
async function contracts() {
  const mod = await import(/* @vite-ignore */ join(process.cwd(), 'electron/workspaceBackup/restoreContracts.ts')).catch(() => ({} as any))
  expect(mod.RestoreError).toBeTypeOf('function')
  return mod
}

// ─── 夹具 ──────────────────────────────────────────────────────────

const INPUT = {
  archivePath: 'C:/backups/我的空间-2026-01-01.zip',
  targetRoot: 'C:/spaces/恢复出来的空间',
  stagingRoot: 'C:/spaces/.mimir-restore-staging-token-1',
  homeDir: 'C:/synthetic-home',
  spaceName: '恢复出来的空间',
  oldRoot: 'C:/spaces/原空间'
} as const

const PLAN = {
  archivePath: INPUT.archivePath,
  targetRoot: INPUT.targetRoot,
  stagingRoot: INPUT.stagingRoot,
  entries: 12,
  totalBytes: 4096,
  formatVersion: 1
} as const

const EMPTY_REPORT = { found: [], rewritten: [], skipped: [], observed: [] } as const

/** 默认全绿的假 steps；`overrides` 用来注入失败。同时记录**调用轨迹**供副作用断言。 */
function fakeSteps(overrides: Record<string, (...args: any[]) => any> = {}) {
  const calls: string[] = []
  const seen: Record<string, any[]> = {}
  const defaults: Record<string, (...args: any[]) => any> = {
    inspect: () => ({ ...PLAN }),
    createStaging: () => INPUT.stagingRoot,
    extract: () => 12,
    remap: () => ({ ...EMPTY_REPORT, found: [{ storeKey: 'library:papers', locator: '2401.00001', field: 'pdfPath', oldValue: 'C:/spaces/原空间/papers/a.pdf', newValue: 'C:/spaces/恢复出来的空间/papers/a.pdf' }] }),
    recheck: () => undefined,
    publish: () => undefined,
    register: () => ({ appended: true }),
    cleanupStaging: () => undefined
  }
  const steps: Record<string, (...args: any[]) => any> = {}
  // 名称取并集：可选步骤（如 targetCreated）只会出现在 overrides 里。
  for (const name of new Set([...Object.keys(defaults), ...Object.keys(overrides)])) {
    const impl = overrides[name] ?? defaults[name]
    if (typeof impl !== 'function') continue
    steps[name] = async (...args: any[]) => {
      calls.push(name)
      seen[name] = args
      return await impl(...args)
    }
  }
  return {
    steps: steps as any,
    calls,
    seen,
    /** 某个步骤的调用次数。 */
    times: (name: string): number => calls.filter((c) => c === name).length
  }
}

const FIXED_NOW = (): Date => new Date('2026-01-02T03:04:05.000Z')
const OPTS = { newId: () => 'space-uuid-1', now: FIXED_NOW }

// ─── ① inspecting 失败：零副作用 ────────────────────────────────────

it('inspecting 失败：createStaging 未被调用、cleanup 为 null、register 未被调用、retryable=false', async () => {
  const { runRestore } = await runnerModule()
  const { RestoreError } = await contracts()
  const fake = fakeSteps({
    inspect: () => {
      throw new RestoreError('DIGEST_MISMATCH', '归档摘要不符')
    }
  })

  const outcome = await runRestore(INPUT, fake.steps, OPTS)

  expect(outcome.stage).toBe('failed')
  expect(outcome.failure?.stage).toBe('inspecting')
  expect(outcome.failure?.code).toBe('DIGEST_MISMATCH')
  expect(outcome.failure?.retryable).toBe(false)
  // 副作用断言（§1.3 第 1 行：零副作用）
  expect(fake.calls).toContain('inspect')
  expect(fake.times('createStaging')).toBe(0)
  expect(fake.times('extract')).toBe(0)
  expect(fake.times('publish')).toBe(0)
  expect(fake.times('register')).toBe(0)
  expect(fake.times('cleanupStaging')).toBe(0)
  expect(outcome.cleanup).toBeNull()
  expect(outcome.result).toBeNull()
})

// ─── ② extracting 失败：清掉本操作暂存 ──────────────────────────────

it('extracting 失败：cleanupStaging 被调用且参数是本操作暂存根；publish/register 未被调用；retryable=true', async () => {
  const { runRestore } = await runnerModule()
  const { RestoreError } = await contracts()
  const fake = fakeSteps({
    extract: () => {
      throw new RestoreError('EXTRACT_FAILED', '磁盘写入失败')
    }
  })

  const outcome = await runRestore(INPUT, fake.steps, OPTS)

  expect(outcome.stage).toBe('failed')
  expect(outcome.failure?.stage).toBe('extracting')
  expect(outcome.failure?.code).toBe('EXTRACT_FAILED')
  expect(outcome.failure?.retryable).toBe(true)
  // 副作用断言（§1.3 第 2 行：删除本次暂存根）
  expect(fake.times('cleanupStaging')).toBe(1)
  expect(fake.seen.cleanupStaging[0]).toBe(INPUT.stagingRoot)
  expect(fake.times('publish')).toBe(0)
  expect(fake.times('register')).toBe(0)
})

it('extracting 失败：createStaging 失败时未取得暂存根 → 绝不调用 cleanupStaging（不碰不属于本次的路径）', async () => {
  const { runRestore } = await runnerModule()
  const { RestoreError } = await contracts()
  const fake = fakeSteps({
    createStaging: () => {
      throw new RestoreError('STAGING_CONFLICT', '暂存根已存在')
    }
  })

  const outcome = await runRestore(INPUT, fake.steps, OPTS)

  expect(outcome.failure?.stage).toBe('extracting')
  expect(outcome.failure?.code).toBe('STAGING_CONFLICT')
  expect(fake.times('cleanupStaging')).toBe(0)
  expect(outcome.cleanup).toBeNull()
})

// ─── ③ verifying 失败：保留暂存根 ───────────────────────────────────

it('verifying 失败（二次校验）：cleanupStaging 未被调用（暂存保留）、publish 未被调用、retryable=true', async () => {
  const { runRestore } = await runnerModule()
  const { RestoreError } = await contracts()
  const fake = fakeSteps({
    recheck: () => {
      throw new RestoreError('RECHECK_FAILED', '空间层 store.json 非法')
    }
  })

  const outcome = await runRestore(INPUT, fake.steps, OPTS)

  expect(outcome.failure?.stage).toBe('verifying')
  expect(outcome.failure?.code).toBe('RECHECK_FAILED')
  expect(outcome.failure?.retryable).toBe(true)
  // 副作用断言（§1.3 第 3 行：保留暂存根供排查）
  expect(fake.times('cleanupStaging')).toBe(0)
  expect(fake.times('publish')).toBe(0)
  expect(fake.times('register')).toBe(0)
  expect(outcome.cleanup?.stagingRoot).toBe(INPUT.stagingRoot)
  expect(outcome.cleanup?.createdTarget).toBeNull()
})

it('verifying 失败（T03 改写步骤）：同样保留暂存根且不发布', async () => {
  const { runRestore } = await runnerModule()
  const { RestoreError } = await contracts()
  const fake = fakeSteps({
    remap: () => {
      throw new RestoreError('RECHECK_FAILED', '改写后 JSON 不可解析')
    }
  })

  const outcome = await runRestore(INPUT, fake.steps, OPTS)

  expect(outcome.failure?.stage).toBe('verifying')
  expect(outcome.failure?.retryable).toBe(true)
  expect(fake.times('cleanupStaging')).toBe(0)
  expect(fake.times('publish')).toBe(0)
  expect(fake.times('recheck')).toBe(0)
})

// ─── ④ publishing 失败：保留暂存、目标未创建 ────────────────────────

it('publishing 失败：cleanupStaging 未被调用、register 未被调用、retryable=true', async () => {
  const { runRestore } = await runnerModule()
  const { RestoreError } = await contracts()
  const fake = fakeSteps({
    publish: () => {
      throw new RestoreError('PUBLISH_FAILED', 'rename 失败')
    }
  })

  const outcome = await runRestore(INPUT, fake.steps, OPTS)

  expect(outcome.failure?.stage).toBe('publishing')
  expect(outcome.failure?.code).toBe('PUBLISH_FAILED')
  expect(outcome.failure?.retryable).toBe(true)
  // 副作用断言（§1.3 第 4 行：保留暂存根、目标未创建 → 绝不注册）
  expect(fake.times('cleanupStaging')).toBe(0)
  expect(fake.times('register')).toBe(0)
  expect(outcome.cleanup?.createdTarget).toBeNull()
  expect(outcome.result).toBeNull()
})

it('publishing 病态失败（rename 已成功但复核失败）：targetCreated=true 时 createdTarget 必须给出，避免漏清本操作产物', async () => {
  const { runRestore } = await runnerModule()
  const { RestoreError } = await contracts()
  const fake = fakeSteps({
    publish: () => {
      throw new RestoreError('PUBLISH_FAILED', '发布后复核失败')
    },
    targetCreated: () => true
  })

  const outcome = await runRestore(INPUT, fake.steps, OPTS)

  expect(outcome.failure?.stage).toBe('publishing')
  expect(outcome.failure?.code).toBe('PUBLISH_FAILED')
  expect(outcome.cleanup?.createdTarget).toBe(INPUT.targetRoot)
  expect(outcome.cleanup?.stagingRoot).toBe(INPUT.stagingRoot)
  expect(fake.times('cleanupStaging')).toBe(0)
  expect(fake.times('register')).toBe(0)
})

it('publishing 失败：targetCreated=false（如 TARGET_EXISTS，目标是用户既有目录）→ createdTarget 为 null，绝不误删', async () => {
  const { runRestore } = await runnerModule()
  const { RestoreError } = await contracts()
  const fake = fakeSteps({
    publish: () => {
      throw new RestoreError('TARGET_EXISTS', '目标已存在')
    },
    targetCreated: () => false
  })

  const outcome = await runRestore(INPUT, fake.steps, OPTS)

  expect(outcome.failure?.code).toBe('TARGET_EXISTS')
  // 关键安全断言：目标是用户既有目录，绝不能进入本操作清理范围。
  expect(outcome.cleanup?.createdTarget).toBeNull()
})

it('publishing 失败：未注入 targetCreated 探针 → 保守按「未创建」处理', async () => {
  const { runRestore } = await runnerModule()
  const { RestoreError } = await contracts()
  const fake = fakeSteps({
    publish: () => {
      throw new RestoreError('PUBLISH_FAILED', 'rename 失败')
    }
  })

  const outcome = await runRestore(INPUT, fake.steps, OPTS)

  expect(outcome.cleanup?.createdTarget).toBeNull()
})

it('publishing 失败：targetCreated 探针自身抛错 → 保守置 null，且错误码不被冲成 INTERNAL', async () => {
  const { runRestore } = await runnerModule()
  const { RestoreError } = await contracts()
  const fake = fakeSteps({
    publish: () => {
      throw new RestoreError('PUBLISH_FAILED', 'rename 失败')
    },
    targetCreated: () => {
      throw new Error('探针崩了')
    }
  })

  const outcome = await runRestore(INPUT, fake.steps, OPTS)

  expect(outcome.stage).toBe('failed')
  expect(outcome.failure?.code).toBe('PUBLISH_FAILED')
  expect(outcome.failure?.detail).toContain('探测失败')
  expect(outcome.cleanup?.createdTarget).toBeNull()
})

// ─── ⑤ registering 失败：目录已发布，仅需重试注册 ────────────────────

it('registering 失败：publish 已调用一次、result 为 null、failure.stage=registering、retryable=true', async () => {
  const { runRestore } = await runnerModule()
  const { RestoreError } = await contracts()
  const fake = fakeSteps({
    register: () => {
      throw new RestoreError('REGISTER_FAILED', '写注册表失败')
    }
  })

  const outcome = await runRestore(INPUT, fake.steps, OPTS)

  expect(outcome.stage).toBe('failed')
  expect(outcome.failure?.stage).toBe('registering')
  expect(outcome.failure?.code).toBe('REGISTER_FAILED')
  expect(outcome.failure?.retryable).toBe(true)
  expect(fake.times('publish')).toBe(1)
  expect(fake.times('register')).toBe(1)
  expect(outcome.result).toBeNull()
  // 目录已发布 → cleanup 必须带上本次创建的目标（§1.3 规则 2 / §4.2 S9）
  expect(outcome.cleanup?.createdTarget).toBe(INPUT.targetRoot)
  expect(outcome.cleanup?.stagingRoot).toBe(INPUT.stagingRoot)
})

// ─── ⑥ 成功路径 ────────────────────────────────────────────────────

it('成功路径：stage=done、result.root=targetRoot、remap 非空、cleanup 为 null', async () => {
  const { runRestore } = await runnerModule()
  const fake = fakeSteps()

  const outcome = await runRestore(INPUT, fake.steps, OPTS)

  expect(outcome.stage).toBe('done')
  expect(outcome.failure).toBeNull()
  expect(outcome.result).not.toBeNull()
  expect(outcome.result?.root).toBe(INPUT.targetRoot)
  expect(outcome.result?.spaceId).toBe('space-uuid-1')
  expect(outcome.result?.name).toBe(INPUT.spaceName)
  expect(outcome.result?.entries).toBe(PLAN.entries)
  expect(outcome.result?.totalBytes).toBe(PLAN.totalBytes)
  expect(outcome.remap?.found.length).toBe(1)
  expect(outcome.cleanup).toBeNull()
  expect(outcome.finishedAt).toBe('2026-01-02T03:04:05.000Z')
  // 成功路径上每个副作用恰好发生一次，且不清理暂存（它已被 rename 消费）
  expect(fake.times('inspect')).toBe(1)
  expect(fake.times('createStaging')).toBe(1)
  expect(fake.times('extract')).toBe(1)
  expect(fake.times('remap')).toBe(1)
  expect(fake.times('recheck')).toBe(1)
  expect(fake.times('publish')).toBe(1)
  expect(fake.times('register')).toBe(1)
  expect(fake.times('cleanupStaging')).toBe(0)
  // 注册走注入的直接函数，spaceId 由 runner 生成并传入
  expect(fake.seen.register[1]).toBe('space-uuid-1')
})

// ─── ⑦ 非法转移防御：绝不静默继续 ───────────────────────────────────

it('非法转移防御：注入的推进器抛错 → INTERNAL 且不向上抛出', async () => {
  const { runRestore } = await runnerModule()
  const fake = fakeSteps()

  const outcome = await runRestore(INPUT, fake.steps, {
    ...OPTS,
    advance: () => {
      throw new Error('推进器被破坏')
    }
  })

  expect(outcome.stage).toBe('failed')
  expect(outcome.failure?.code).toBe('INTERNAL')
  expect(outcome.failure?.retryable).toBe(false)
  expect(outcome.result).toBeNull()
})

it('非法转移防御：注入的推进器给出错误落点 → INTERNAL，绝不静默继续', async () => {
  const { runRestore } = await runnerModule()
  const fake = fakeSteps()

  const outcome = await runRestore(INPUT, fake.steps, {
    ...OPTS,
    // 前两步正常，到 `planned --userConfirm--> extracting` 时给出非法落点 `done`：必须被拦下。
    advance: (_stage: string, event: string) => {
      if (event === 'selectArchive') return 'inspecting'
      if (event === 'planReady') return 'planned'
      if (event === 'userConfirm') return 'done'
      return 'failed'
    }
  })

  expect(outcome.stage).toBe('failed')
  expect(outcome.failure?.code).toBe('INTERNAL')
  expect(outcome.failure?.detail).toContain('状态机推进异常')
  // 被拦下后不得继续产生副作用
  expect(fake.times('extract')).toBe(0)
  expect(fake.times('publish')).toBe(0)
  expect(fake.times('register')).toBe(0)
})

// ─── ⑧ 非 RestoreError 归一为 INTERNAL ─────────────────────────────

it('非 RestoreError 异常归一为 INTERNAL 且不向上抛出', async () => {
  const { runRestore } = await runnerModule()
  const fake = fakeSteps({
    publish: () => {
      throw new Error('底层 IO 崩了')
    }
  })

  const outcome = await runRestore(INPUT, fake.steps, OPTS)

  expect(outcome.stage).toBe('failed')
  expect(outcome.failure?.stage).toBe('publishing')
  expect(outcome.failure?.code).toBe('INTERNAL')
  expect(outcome.failure?.detail).toContain('底层 IO 崩了')
  expect(outcome.failure?.retryable).toBe(true)
})

it('错误码归一：RestoreError 子类（name 被改写）跨模块图时语义码不被降级成 INTERNAL', async () => {
  const { runRestore } = await runnerModule()
  // 模拟 T04a 规划中的 PublishError 子类：name 已改写为 'PublishError'，
  // 且来自另一份模块图（instanceof 失效）——只认 name==='RestoreError' 的实现会漏判。
  class PublishErrorLike extends Error {
    readonly code = 'PUBLISH_FAILED'
    constructor(message: string) {
      super(message)
      this.name = 'PublishError'
    }
  }
  const fake = fakeSteps({
    publish: () => {
      throw new PublishErrorLike('rename 成功但发布后复核失败')
    }
  })

  const outcome = await runRestore(INPUT, fake.steps, OPTS)

  expect(outcome.failure?.stage).toBe('publishing')
  expect(outcome.failure?.code).toBe('PUBLISH_FAILED')
  expect(outcome.failure?.detail).toContain('发布后复核失败')
})

it('错误码归一：带无关 code 的系统错误（ENOENT）不会被误认作恢复错误码', async () => {
  const { runRestore } = await runnerModule()
  const fake = fakeSteps({
    publish: () => {
      const ioError = new Error('ENOENT: no such file') as Error & { code: string }
      ioError.code = 'ENOENT'
      throw ioError
    }
  })

  const outcome = await runRestore(INPUT, fake.steps, OPTS)

  expect(outcome.failure?.code).toBe('INTERNAL')
  expect(outcome.failure?.detail).toContain('ENOENT')
})

// ─── ⑨ 注册不重复：appended=false 仍正常 done ───────────────────────

it('注册不重复：register 返回 appended=false（幂等命中）仍 done，不报错', async () => {
  const { runRestore } = await runnerModule()
  const fake = fakeSteps({ register: () => ({ appended: false }) })

  const outcome = await runRestore(INPUT, fake.steps, OPTS)

  expect(outcome.stage).toBe('done')
  expect(outcome.failure).toBeNull()
  expect(outcome.result?.spaceId).toBe('space-uuid-1')
  expect(fake.times('register')).toBe(1)
})

// ─── ⑩ 纪律 3：ok:false 一律按失败处理 ──────────────────────────────

it('纪律 3：步骤返回 { ok:false } 一律按失败处理（不得当成功继续）', async () => {
  const { runRestore } = await runnerModule()
  const fake = fakeSteps({
    register: () => ({ ok: false, appended: false, code: 'REGISTER_FAILED', message: '注册表写入被拒' })
  })

  const outcome = await runRestore(INPUT, fake.steps, OPTS)

  expect(outcome.stage).toBe('failed')
  expect(outcome.failure?.stage).toBe('registering')
  expect(outcome.failure?.code).toBe('REGISTER_FAILED')
  expect(outcome.failure?.detail).toContain('ok:false')
  expect(outcome.result).toBeNull()
})

it('纪律 3：inspect 返回 { ok:false } 时零副作用（不建暂存、不注册）', async () => {
  const { runRestore } = await runnerModule()
  const fake = fakeSteps({ inspect: () => ({ ok: false, code: 'PATH_ESCAPE', message: '条目越界' }) })

  const outcome = await runRestore(INPUT, fake.steps, OPTS)

  expect(outcome.failure?.stage).toBe('inspecting')
  expect(outcome.failure?.code).toBe('PATH_ESCAPE')
  expect(fake.times('createStaging')).toBe(0)
  expect(fake.times('register')).toBe(0)
  expect(outcome.cleanup).toBeNull()
})

// ─── ⑪ 清理范围的安全边界 ──────────────────────────────────────────

it('目标与暂存根同路径 → INVALID_TARGET 拒绝（不进入解压、不留可疑清理范围）', async () => {
  const { runRestore } = await runnerModule()
  const fake = fakeSteps()

  const outcome = await runRestore({ ...INPUT, stagingRoot: INPUT.targetRoot }, fake.steps, OPTS)

  expect(outcome.stage).toBe('failed')
  expect(outcome.failure?.code).toBe('INVALID_TARGET')
  expect(outcome.failure?.retryable).toBe(false)
  expect(fake.times('createStaging')).toBe(0)
  expect(fake.calls.length).toBe(0)
  expect(outcome.cleanup).toBeNull()
})

it('依赖方向纪律：restoreRunner 不 import 未落地的 publish.ts / registryAppend.ts，也不碰 IPC（纪律 4）', async () => {
  const source = readFileSync(join(process.cwd(), 'electron/workspaceBackup/restoreRunner.ts'), 'utf8')
  // 只扫描**代码**：注释里为说明纪律会提到这些名字，不能据此误判。
  const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|\s)\/\/[^\n]*/g, '$1')
  // 步骤必须是注入的：不得静态依赖 T04 并行产物，否则现在就 typecheck 不过。
  expect(code).not.toMatch(/from\s+['"]\.\/publish['"]/)
  expect(code).not.toMatch(/from\s+['"]\.\/registryAppend['"]/)
  // 纪律 4：控制不可嵌套——本文件不得引入任何 IPC / 控制门，否则会自我等待排空而死锁。
  expect(code).not.toContain('ipcMain')
  expect(code).not.toContain('ipcRenderer')
  expect(code).not.toContain('installWorkspaceIpcGate')
  expect(code).not.toContain('runControl')
  // 正向：确实复用了 T01 的状态机与 abortScope（清理范围不自行拼路径）。
  expect(code).toContain('abortScope')
  expect(code).toContain('nextStage')
})

it('cleanup 绝不包含原空间根 / homeDir / 注册表（§1.3 规则 2）', async () => {
  const { runRestore } = await runnerModule()
  const { RestoreError } = await contracts()
  const fake = fakeSteps({
    register: () => {
      throw new RestoreError('REGISTER_FAILED', '写注册表失败')
    }
  })

  const outcome = await runRestore(INPUT, fake.steps, OPTS)
  const json = JSON.stringify(outcome.cleanup)

  expect(json).toContain(INPUT.stagingRoot)
  expect(json).toContain(INPUT.targetRoot)
  expect(json).not.toContain(INPUT.oldRoot)
  expect(json).not.toContain(INPUT.homeDir)
  expect(json).not.toContain('store.json')
})
