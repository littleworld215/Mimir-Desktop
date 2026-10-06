/**
 * 渲染层路径边界守卫（**主进程共用**，被 `ipc/index.ts` 与 `ipc/assets.ts` 同时引用）。
 *
 * 抽离自原 `ipc/index.ts`：资产库 IPC（`ipc/assets.ts`）也需要同一套边界，若各写一份
 * 就会出现「两条口径不一的旁路」。这里作为唯一实现，两侧都 import 它，避免循环依赖
 *（`assets.ts` 不再反向 import `index.ts`）。
 *
 * 放行三条（顺序即优先级）：
 * 1. 控制平面 → 硬拒绝（与 Agent 侧同口径，见 `isControlPlanePath`）；
 * 2. 当前科研空间根目录内 —— 用户自己的资料库；
 * 3. 用户在本会话里经原生对话框显式选中的路径及其子路径（见 `pickedPaths`）。
 */
import { resolve } from 'node:path'
import { lstatSync } from 'node:fs'
import { isControlPlanePath } from '../agent/controlPlane'
import { isPathWithin } from './pathGuards'
import { isManagedAssetPath, MANAGED_ASSET_REJECT_MESSAGE } from '../assets/managedPaths'
import { spaceRoot, getStoreValue, getActiveWorkspace, currentSpaceEpoch } from '../library/store'

/** 用户在原生文件对话框里**显式选中**过的路径（文件与目录，绝对路径）。 */
export const pickedPaths = new Set<string>()

/**
 * 资产导出专用一次性授权（R4）：保存对话框登记可信 workspace/epoch，handler 首个 await 前消费。
 * 仅放行**完全相等**的文件路径——不放行父目录，也不放行同目录下其它（相邻）文件；
 * 控制平面 / 托管目录已在前面先行拒绝。用于「保存到用户刚在对话框里选的文件」这一合法动作，
 * 而不把整个目录永久加入白名单（与 `pickedPaths` 的长期复用区分开）。
 */
interface SaveAuthorization { workspaceId: string; spaceEpoch: string; claimed: boolean }
const oneShotFileAuths = new Map<string, SaveAuthorization>()
export interface AssetSaveLease { path: string; commit(): void; release(): void }

function trustedScope(): { workspaceId: string; spaceEpoch: string } {
  const workspace = getActiveWorkspace()
  if (workspace === null) throw new Error('当前没有科研空间。')
  return { workspaceId: workspace.id, spaceEpoch: currentSpaceEpoch() }
}
function authKey(path: string): string {
  const absolute = resolve(path)
  return process.platform === 'win32' ? absolute.toLowerCase() : absolute
}

/** 资产导出专用：外部文件授权在首个 await 前原子领取，不为通用读写授权。 */
export function claimAssetSavePath(input: unknown): AssetSaveLease {
  if (typeof input !== 'string' || input.trim() === '') throw new Error('无效路径')
  const target = resolve(input)
  if (isControlPlanePath(target)) throw new Error(CONTROL_PLANE_REJECTED)
  if (isManagedAssetPath(target, safeSpaceRoot())) throw new Error(MANAGED_ASSET_REJECT_MESSAGE)
  if (isPathWithin(target, safeSpaceRoot())) return { path: target, commit() {}, release() {} }
  const key = authKey(target)
  const auth = oneShotFileAuths.get(key)
  const current = trustedScope()
  if (auth === undefined || auth.claimed || auth.workspaceId !== current.workspaceId || auth.spaceEpoch !== current.spaceEpoch) {
    throw new Error('已拒绝：请通过保存对话框重新选择该精确文件。')
  }
  auth.claimed = true
  let settled = false
  return {
    path: target,
    commit() {
      if (settled) return
      settled = true
      if (oneShotFileAuths.get(key) === auth) oneShotFileAuths.delete(key)
    },
    release() {
      if (settled) return
      settled = true
      if (oneShotFileAuths.get(key) !== auth) return
      let active: ReturnType<typeof trustedScope>
      try { active = trustedScope() } catch { oneShotFileAuths.delete(key); return }
      let absent = false
      try { lstatSync(target) } catch (error) { absent = (error as NodeJS.ErrnoException).code === 'ENOENT' }
      if (absent && auth.workspaceId === active.workspaceId && auth.spaceEpoch === active.spaceEpoch) auth.claimed = false
      else oneShotFileAuths.delete(key)
    }
  }
}

/** 原生保存对话框前捕获可信 scope；对话框期间切空间则不登记授权。 */
export async function authorizeSaveDialog<T extends { canceled: boolean; filePath?: string }>(show: () => Promise<T>): Promise<T> {
  let captured: ReturnType<typeof trustedScope> | null = null
  try { captured = trustedScope() } catch { /* 无空间仍展示通用原生对话框。 */ }
  const result = await show()
  if (result.canceled) clearOneShotFileAuths()
  let current: ReturnType<typeof trustedScope> | null = null
  try { current = trustedScope() } catch { /* 空间消失只取消授权，不改变对话框结果。 */ }
  if (!result.canceled && result.filePath && captured !== null && current !== null && captured.workspaceId === current.workspaceId && captured.spaceEpoch === current.spaceEpoch) {
    registerOneShotFileAuth(result.filePath)
  }
  return result
}

/** dialog:save 成功选定文件后注册一次性精确授权（不含父目录 / 相邻路径）。 */
export function registerOneShotFileAuth(filePath: string): void {
  if (typeof filePath !== 'string' || filePath.trim() === '') return
  oneShotFileAuths.set(authKey(filePath), { ...trustedScope(), claimed: false })
}

/** 保存成功后消费（焚毁）该一次性授权，避免被长期复用。 */
export function consumeOneShotFileAuth(filePath: string): void {
  if (typeof filePath !== 'string') return
  oneShotFileAuths.delete(authKey(filePath))
}

/** 取消 / 切换时清空一次性授权（cancel 解注册）。 */
export function clearOneShotFileAuths(): void {
  oneShotFileAuths.clear()
}

/** 控制平面拒绝文案（settings / 能力域 / 技能 / 桥接凭据；与 Agent 侧同一条硬约束）。 */
const CONTROL_PLANE_REJECTED = '已拒绝：该路径属于 Mimir 的配置/能力控制平面，不允许经此通道访问。'

/** 当前科研空间根目录；取不到（store 未就绪等）时返回空串，由调用方按「越界」处理。 */
function safeSpaceRoot(): string {
  try {
    return resolve(spaceRoot())
  } catch {
    return ''
  }
}

/** 用户已保存的工作台背景图路径（settings.wallpaper.path），无则返回空串。 */
function resolveWallpaperPath(): string {
  try {
    const settings = getStoreValue<Record<string, unknown>>('settings')
    const wp = settings?.wallpaper
    if (wp === null || typeof wp !== 'object') return ''
    const p = (wp as { path?: unknown }).path
    return typeof p === 'string' && p !== '' ? resolve(p) : ''
  } catch {
    return ''
  }
}

/** **渲染层路径边界的唯一入口**：所有接收路径参数的 IPC 处理器都必须先过这里。 */
export function assertRendererPath(input: unknown, mode: 'read' | 'write' = 'read'): string {
  if (typeof input !== 'string' || input.trim() === '') throw new Error('无效路径')
  const target = resolve(input)
  if (isControlPlanePath(target)) throw new Error(CONTROL_PLANE_REJECTED)
  // 资产库托管数据（数据库 / 版本 blob / 暂存 / 备份）不接受通用文件通道读写。
  if (isManagedAssetPath(target, safeSpaceRoot())) throw new Error(MANAGED_ASSET_REJECT_MESSAGE)
  if (isPathWithin(target, safeSpaceRoot())) return target
  for (const picked of pickedPaths) {
    if (isPathWithin(target, picked)) return target
  }
  throw new Error(
    mode === 'write'
      ? '已拒绝：写入目标不在当前科研空间内，也不是你在本会话中选择过的目录。请重新选择该目录后再试。'
      : '已拒绝：目标不在当前科研空间内，也不是你在本会话中选择过的文件或目录。请重新选择后再试。'
  )
}

/** 校验渲染层**文件**通道的目标路径（`fs:readFile` / `fs:readImageDataUrl` / `fs:writeFile`）。 */
export function assertRendererFilePath(input: unknown, mode: 'read' | 'write' = 'read'): string {
  if (typeof input !== 'string' || input.trim() === '') throw new Error('无效路径')
  const target = resolve(input)
  if (isControlPlanePath(target)) throw new Error(CONTROL_PLANE_REJECTED)
  if (isManagedAssetPath(target, safeSpaceRoot())) throw new Error(MANAGED_ASSET_REJECT_MESSAGE)
  if (mode === 'read') {
    if (pickedPaths.has(target) || target === resolveWallpaperPath()) return target
    throw new Error('已拒绝：仅允许读取你在文件对话框中主动选择的文件。')
  }
  if (!isPathWithin(target, safeSpaceRoot())) {
    throw new Error('已拒绝：写入目标必须位于当前科研空间内。')
  }
  return target
}
