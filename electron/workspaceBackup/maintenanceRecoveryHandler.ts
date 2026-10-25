import { WORKSPACE_BACKUP_CHANNELS, type MaintenanceRecoveryList, type MaintenanceRecoveryRequest, type MaintenanceRecoveryResult } from '../../shared/workspaceBackupContracts'
import { RestoreError } from './restoreContracts'
import { assertRestoreOperationId } from './restoreJournal'
import type { RecoveryCleanupView, RestoreRecovery } from './restoreRecovery'

type RecoveryMethods = Pick<RestoreRecovery, 'list' | 'register' | 'cleanup'>
export interface RecoveryHandlerDeps {
  recovery: RecoveryMethods
  confirmCleanup(view: RecoveryCleanupView): Promise<boolean>
  runWrite<T>(action: () => Promise<T>): Promise<T>
}
const safeCodes = new Set(['INVALID_TARGET', 'CONTROL_BLOCKED', 'LOCK_UNAVAILABLE', 'RECHECK_FAILED', 'REGISTRY_INVALID', 'REGISTER_FAILED'])
const statusValues = new Set(['pending-registration', 'registered', 'staging-retained', 'interrupted', 'no-output', 'cleaned', 'blocked'])
const count = (value: unknown) => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : 0
export function isTrustedMaintenanceRequest(event: unknown, owner: { isDestroyed(): boolean; webContents: { mainFrame: unknown } }): boolean {
  const e = event as { sender?: unknown; senderFrame?: unknown } | null
  return Boolean(e && !owner.isDestroyed() && owner.webContents.mainFrame && e.sender === owner.webContents && e.senderFrame === owner.webContents.mainFrame)
}
function publicList(result: MaintenanceRecoveryList): MaintenanceRecoveryList {
  const writable = result.writable === true
  return {
    ok: true, writable, invalidRecords: count(result.invalidRecords), truncated: result.truncated === true,
    ...(result.nextCursor ? { nextCursor: result.nextCursor } : {}),
    items: result.items.map(item => ({
      operationId: item.operationId, spaceName: item.spaceName, createdAt: item.createdAt, phase: item.phase,
      status: statusValues.has(item.status) ? item.status : 'blocked', entries: count(item.entries), totalBytes: count(item.totalBytes),
      actions: writable ? item.actions.filter(action => action === 'register' || action === 'cleanup') : []
    }))
  }
}
function request(value: unknown): MaintenanceRecoveryRequest | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  if (Object.keys(value).sort().join(',') !== 'action,operationId') return null
  const r = value as MaintenanceRecoveryRequest
  if (r.action !== 'register' && r.action !== 'cleanup') return null
  try { assertRestoreOperationId(r.operationId) } catch { return null }
  return { operationId: r.operationId, action: r.action }
}
export function buildRecoveryHandler(deps: RecoveryHandlerDeps) {
  return {
    list: async (cursor?: unknown): Promise<MaintenanceRecoveryList> => {
      if (cursor !== undefined) assertRestoreOperationId(cursor as string)
      return publicList(await deps.recovery.list(cursor as string | undefined))
    },
    action: async (value: unknown): Promise<MaintenanceRecoveryResult> => {
      const normalized = request(value)
      if (!normalized) return { ok: false, code: 'INVALID_TARGET', detail: '恢复操作标识或动作无效，请重新读取记录。' }
      try {
        return await deps.runWrite(async () => {
          if (normalized.action === 'register') {
            const result = await deps.recovery.register(normalized.operationId)
            return { ok: true, operationId: normalized.operationId, action: 'register', spaceId: result.spaceId, alreadyRegistered: result.alreadyRegistered }
          }
          if (!await deps.recovery.cleanup(normalized.operationId, deps.confirmCleanup)) return { ok: false, code: 'CANCELLED', detail: '已保留本次恢复暂存。' }
          return { ok: true, operationId: normalized.operationId, action: 'cleanup' }
        })
      } catch (error) {
        const code = error instanceof RestoreError && safeCodes.has(error.code) ? error.code : 'INTERNAL'
        return { ok: false, code, detail: code === 'LOCK_UNAVAILABLE' ? '维护或空间写锁尚未取得，请按锁处理规约确认后重试。' : code === 'CONTROL_BLOCKED' ? '操作暂不可执行，请等待任务完成并重新读取。' : '记录、资料或登记状态未通过核对；资料已保留，请重新读取后检查。' }
      }
    }
  }
}
export function registerRecoveryHandlers(
  ipc: { handle(channel: string, listener: (event: unknown, ...args: unknown[]) => unknown): void },
  trusted: (event: unknown) => boolean,
  handler: ReturnType<typeof buildRecoveryHandler>
): void {
  ipc.handle(WORKSPACE_BACKUP_CHANNELS.recoveryList, (event, cursor) => {
    if (!trusted(event)) throw Error('UNAUTHORIZED_SENDER')
    return handler.list(cursor)
  })
  ipc.handle(WORKSPACE_BACKUP_CHANNELS.recoveryAction, (event, value) => {
    if (!trusted(event)) throw Error('UNAUTHORIZED_SENDER')
    return handler.action(value)
  })
}
