/**
 * `fs:stat` IPC 通道单测（消除附件 `size === -1` 的批次 A）。
 *
 * 守护点（本文件存在的理由）：
 * 1. **授权门不被绕过**：`fs:stat` 与 `fs:readFile` 必须共用 `assertRendererFilePath`
 *    （即 `pickedPaths` 白名单）。未在原生对话框选中过的路径**一律拒绝**，
 *    否则就是一个「任意路径读文件元信息」的旁路——与 `fs:readImageDataUrl` 早先
 *    按扩展名放行的同类缺陷。
 * 2. **真实字节数**：对已授权文件返回磁盘字节数（而非字符数），这是修 `size === -1` 的目的。
 * 3. **失败不抛**：stat 失败（不存在/越界）返回 `{ ok:false, message }`，
 *    不让一个统计失败打断整批附件导入。
 *
 * 说明：`electron/ipc/index.ts` 的 `setupIpcHandlers` 会拉起大量主进程依赖，
 * 本文件**局部** mock 掉与本通道无关的重依赖，只保留真实的 `rendererPathGuards`，
 * 使「授权门确实生效」成为**真实断言**而非 mock 断言。
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

const hoisted = vi.hoisted(() => ({ handlers: new Map<string, (...args: unknown[]) => unknown>() }))

vi.mock('electron', () => ({
  ipcMain: {
    handle: (channel: string, handler: (...args: unknown[]) => unknown): void => {
      hoisted.handlers.set(channel, handler)
    },
    on: vi.fn()
  },
  dialog: { showOpenDialog: vi.fn(), showSaveDialog: vi.fn() },
  shell: { openPath: vi.fn(), showItemInFolder: vi.fn(), openExternal: vi.fn() },
  app: { isPackaged: false, getPath: () => tmpdir(), getVersion: () => '0.0.0-test' },
  BrowserWindow: class {}
}))

// 重依赖：与本通道无关，mock 掉即可（真实逻辑用不到它们）。
// 注意：**不要** mock `electron/library/store`——vitest alias 已把它指向内存桩
// （见 vitest.config.ts 的 store 别名），手工 mock 会打断模块图。
vi.mock('node-pty', () => ({ spawn: vi.fn() }))

import { setupIpcHandlers } from '../../../electron/ipc/index'
import { pickedPaths } from '../../../electron/ipc/rendererPathGuards'

let root: string
let external: string

/**
 * `setupIpcHandlers` 会注册**全部** IPC handler（含 `node-pty` 等重依赖），
 * 是全仓最重的模块加载路径。故**只注册一次**（`beforeAll`），且整个文件共用一个临时根——
 * 避免每个用例重复加载/注册导致的内存峰值（本机 16GB、常态剩余 ~2GB，
 * 逐用例注册会触发 tinypool worker 被 OS 强杀，表现为 `Worker exited unexpectedly`）。
 */
beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'mimir-fsstat-'))
  external = join(root, 'external')
  mkdirSync(external, { recursive: true })
  hoisted.handlers.clear()
  setupIpcHandlers({ current: null })
})

beforeEach(() => {
  // 只清授权白名单；handler 注册保持（见上）。
  pickedPaths.clear()
})

afterAll(() => {
  rmSync(root, { recursive: true, force: true })
})

/** 直接调用注册好的 `fs:stat` handler。 */
const stat = (path: unknown): Promise<unknown> => hoisted.handlers.get('fs:stat')!({}, path)

describe('fs:stat —— 授权门', () => {
  it('未在对话框选中过的路径一律拒绝（ok:false，含提示）', async () => {
    const file = join(external, 'not-picked.txt')
    writeFileSync(file, 'hello')
    // 未加入 pickedPaths → 必须拒绝，且**不泄漏**不存在的 size。
    const result = (await stat(file)) as { ok: boolean; size?: number; message?: string }
    expect(result.ok).toBe(false)
    expect(result.size).toBeUndefined()
    expect(typeof result.message).toBe('string')
  })

  it('目录本身若未授权同样拒绝（不因是目录而放行）', async () => {
    const result = (await stat(external)) as { ok: boolean }
    expect(result.ok).toBe(false)
  })

  it('仅授权精确文件后放行；其兄弟文件仍拒绝', async () => {
    const file = join(external, 'picked.txt')
    const sibling = join(external, 'sibling.txt')
    writeFileSync(file, 'abcde')
    writeFileSync(sibling, 'x')
    pickedPaths.add(file)
    expect((await stat(file)) as { ok: boolean }).toMatchObject({ ok: true })
    // 授权是**精确路径**的，不是整个目录的——兄弟文件不可读。
    expect((await stat(sibling)) as { ok: boolean }).toMatchObject({ ok: false })
  })
})

describe('fs:stat —— 真实字节数', () => {
  it('返回磁盘字节数而非字符数（多字节内容验证）', async () => {
    const file = join(external, 'zh.txt')
    // 「中文」= 6 字节 UTF-8，但 .length === 2。size 必须是字节数。
    writeFileSync(file, '中文')
    pickedPaths.add(file)
    const result = (await stat(file)) as { ok: boolean; size: number; isDirectory: boolean }
    expect(result.ok).toBe(true)
    expect(result.size).toBe(6)
    expect(result.isDirectory).toBe(false)
  })

  it('大二进制文件返回精确 size（不再有 -1）', async () => {
    const file = join(external, 'blob.bin')
    writeFileSync(file, Buffer.alloc(4096, 7))
    pickedPaths.add(file)
    const result = (await stat(file)) as { ok: boolean; size: number }
    expect(result).toMatchObject({ ok: true, size: 4096 })
  })

  it('已授权目录返回 isDirectory:true', async () => {
    pickedPaths.add(external)
    const result = (await stat(external)) as { ok: boolean; isDirectory?: boolean }
    expect(result.ok).toBe(true)
    expect(result.isDirectory).toBe(true)
  })
})

describe('fs:stat —— 失败不抛', () => {
  it('已授权但文件已被删除 → { ok:false }，不抛异常', async () => {
    const file = join(external, 'ghost.txt')
    writeFileSync(file, 'x')
    pickedPaths.add(file)
    rmSync(file)
    const result = (await stat(file)) as { ok: boolean; message?: string }
    expect(result.ok).toBe(false)
    expect(typeof result.message).toBe('string')
  })

  it('非法入参（空串/非字符串）→ { ok:false }，不抛异常', async () => {
    for (const bad of ['', '   ', null, 42, undefined]) {
      expect(((await stat(bad)) as { ok: boolean }).ok).toBe(false)
    }
  })
})
