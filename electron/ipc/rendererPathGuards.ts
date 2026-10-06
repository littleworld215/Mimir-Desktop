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
import { isControlPlanePath } from '../agent/controlPlane'
import { isPathWithin } from './pathGuards'
import { isManagedAssetPath, MANAGED_ASSET_REJECT_MESSAGE } from '../assets/managedPaths'
import { spaceRoot, getStoreValue } from '../library/store'

/** 用户在原生文件对话框里**显式选中**过的路径（文件与目录，绝对路径）。 */
export const pickedPaths = new Set<string>()

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
