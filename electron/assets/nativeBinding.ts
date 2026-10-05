/**
 * better-sqlite3 原生绑定解析（**只由主进程资产 store 使用**）。
 *
 * 背景（INTEGRATION-PLAN-I0-I1 §2.2）：Node 与 Electron 使用**不同 ABI**。
 * - 开发 / 测试（Node ABI）：直接让 better-sqlite3 解析自身默认绑定。
 * - 打包后（Electron ABI）：绑定被 `electron-builder` 的 `asarUnpack` 解到 `app.asar.unpacked`，
 *   需要显式给出 `nativeBinding` 路径。
 *
 * 纪律：
 * - 找不到绑定 / ABI 不匹配时**抛出明确错误**（`NATIVE_BINDING_UNAVAILABLE`），
 *   **绝不**自动换空库或静默降级。
 * - 本模块不做任何数据库打开，只回答「绑定在哪」。
 */

import { existsSync } from 'fs'
import { join } from 'path'

export class NativeBindingUnavailableError extends Error {
  readonly code = 'NATIVE_BINDING_UNAVAILABLE'
  constructor(message: string) {
    super(message)
    this.name = 'NativeBindingUnavailableError'
  }
}

export interface NativeBindingResolution {
  /** 传给 better-sqlite3 构造选项的 nativeBinding；undefined 表示用默认解析。 */
  nativeBinding: string | undefined
  /** 解析模式，用于日志与验证。 */
  mode: 'default' | 'unpacked'
  /** 说明（失败时给出可操作指引）。 */
  detail: string
}

/** better-sqlite3 原生二进制的文件名。 */
function bindingFileName(): string {
  return 'better_sqlite3.node'
}

/**
 * 解析原生绑定。
 *
 * @param opts.isPackaged Electron `app.isPackaged`
 * @param opts.resourcesPath Electron `process.resourcesPath`（打包后资源根）
 * @param opts.appRoot 开发模式应用根（定位 `.native/` 缓存），缺省用 `process.cwd()`
 * @param opts.electronVersion / opts.platform / opts.arch 供测试注入，缺省取运行时值
 */
export function resolveAssetsNativeBinding(opts: {
  isPackaged: boolean
  resourcesPath?: string
  appRoot?: string
  electronVersion?: string
  platform?: string
  arch?: string
}): NativeBindingResolution {
  const platform = opts.platform ?? process.platform
  const arch = opts.arch ?? process.arch
  const electronVersion = opts.electronVersion ?? process.versions.electron

  if (!opts.isPackaged) {
    // 开发模式：
    // - 运行在 Electron 下 → 需要 **Electron ABI** 绑定（`.native/electron-<ver>/<platform>-<arch>/`，
    //   由 scripts/prepareAssetsNative.mjs 生成），否则 ABI 不匹配会崩。
    // - 纯 Node（vitest / 脚本）→ 用 node_modules 内的 Node ABI 默认绑定。
    if (typeof electronVersion === 'string' && electronVersion !== '') {
      const root = opts.appRoot ?? process.cwd()
      const candidate = join(
        root,
        '.native',
        `electron-${electronVersion}`,
        `${platform}-${arch}`,
        bindingFileName()
      )
      if (!existsSync(candidate)) {
        throw new NativeBindingUnavailableError(
          `未找到开发模式 Electron 原生绑定：${candidate}。请先运行 scripts/prepareAssetsNative.mjs 生成 Electron ABI 绑定。`
        )
      }
      return { nativeBinding: candidate, mode: 'unpacked', detail: `开发模式 Electron 绑定：${candidate}` }
    }
    return { nativeBinding: undefined, mode: 'default', detail: '开发模式（Node 测试）：使用默认原生绑定解析' }
  }

  const resourcesPath = opts.resourcesPath
  if (resourcesPath === undefined || resourcesPath === '') {
    throw new NativeBindingUnavailableError(
      '打包运行但无法取得 resourcesPath，不能解析 better-sqlite3 原生绑定'
    )
  }

  // electron-builder asarUnpack 后的典型位置：
  //   <resources>/app.asar.unpacked/node_modules/better-sqlite3/build/Release/better_sqlite3.node
  const candidate = join(
    resourcesPath,
    'app.asar.unpacked',
    'node_modules',
    'better-sqlite3',
    'build',
    'Release',
    bindingFileName()
  )
  if (!existsSync(candidate)) {
    throw new NativeBindingUnavailableError(
      `未找到 better-sqlite3 原生绑定：${candidate}。请确认 electron-builder 的 asarUnpack 已包含 better-sqlite3，且已按 Electron ABI 重建。`
    )
  }
  return { nativeBinding: candidate, mode: 'unpacked', detail: `使用解包原生绑定：${candidate}` }
}
