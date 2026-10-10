import { AsyncLocalStorage } from 'node:async_hooks'
import { resolve } from 'node:path'
import { workspaceOperationGate, type OperationScope } from '../workspaceBackup/operationGate'
import { WorkspaceTaskSupervisor } from '../workspaceBackup/taskSupervisor'
import { AssetsStoreError, type AssetsContext } from './types'

const accepted = new AsyncLocalStorage<OperationScope>()
let unreportedFailure = false
const tasks = new WorkspaceTaskSupervisor(workspaceOperationGate, () => {
  const scope = accepted.getStore()
  if (!scope) throw Error('资产AI缺少可信空间上下文。')
  return scope
})

/** scope只来自主进程资产会话；公开取消反馈不能缩短原模型与发布的任务寿命。 */
export function runAssetsAiTask<T>(ctx: AssetsContext, controller: AbortController, fn: (signal: AbortSignal) => Promise<T>): Promise<T> {
  ctx.assertCurrent()
  const scope = { id: ctx.scope.workspaceId, epoch: ctx.scope.spaceEpoch, root: resolve(ctx.layout.root, '../..') }
  const parent = workspaceOperationGate.current()
  const normalized = (path: string) => process.platform === 'win32' ? resolve(path).toLowerCase() : resolve(path)
  if (parent && (parent.id !== scope.id || parent.epoch !== scope.epoch || normalized(parent.root) !== normalized(scope.root))) {
    throw new AssetsStoreError('SPACE_CHANGED', '资产AI与父任务空间不匹配。')
  }
  return accepted.run(scope, () => tasks.run(fn, controller))
}

/** 仅供主进程维护编排；拒绝新请求并等待实际请求/发布结束，不授予失败交接。 */
export async function stopAllAssetsAiTasksAndWait(): Promise<void> {
  await tasks.stop()
  if (unreportedFailure) throw new AssetsStoreError('AI_FAILED', '资产AI有未报告的晚失败，不能授予维护交接。')
}

/** 仅留无正文的故障标记：公开race结束后，非取消失败不能被任务集合清理遗忘。 */
export function recordUnreportedAssetsAiFailure(): void { unreportedFailure = true }
