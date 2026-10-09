import { startupMode } from './startupMode'

/** 入口回调必须惰性加载；普通main的静态依赖不能进入维护启动图。 */
export async function dispatchStartup(args: string[], entries: { normal(): Promise<unknown>; maintenance(): Promise<unknown> }) {
  return entries[startupMode(args)]()
}
