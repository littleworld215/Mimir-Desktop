export const WORKSPACE_BACKUP_CHANNELS = { overview: 'workspaceBackup:overview' } as const
export type MaintenanceOverview = { ok: true; spaces: Array<{ id: string; name: string }> } | { ok: false; code: 'REGISTRY_INVALID' }
export interface WorkspaceBackupMaintenanceApi { overview(): Promise<MaintenanceOverview> }
