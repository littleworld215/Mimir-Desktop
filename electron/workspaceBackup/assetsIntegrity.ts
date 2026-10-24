/**
 * 资产库只读检查公共入口（I6 G-03）。
 *
 * 检查实现见 assetsRestore：复用资产域完整DDL、版本、外键预检，逐一核对全部历史附件。
 * 此入口不迁移；已知旧库只由 prepareStagedAssets 在维护恢复的持锁暂存根中升级。
 * readonly可能生成空WAL/SHM，但不改主库业务内容；未来版本报VERSION_UNSUPPORTED，
 * 其它失败报INTEGRITY_FAILED。原生绑定由主进程显式传入选项，不依赖业务store启动。
 */
import { inspectAssetsCopy } from './assetsRestore'
import { ASSETS_DDL } from '../assets/schema'

export interface AssetsIntegrityOptions {
  readonly isPackaged?: boolean
  readonly resourcesPath?: string
  readonly appRoot?: string
  /** 显式绑定位置；Node测试通常使用默认绑定。 */
  readonly nativeBinding?: string
}

/** 保留既有导出供兼容调用；完整检查不以表名集合替代DDL检查。 */
export function expectedTableNames(ddl: readonly string[] = ASSETS_DDL): string[] {
  const names = new Set<string>()
  for (const statement of ddl) {
    const match = /^\s*CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?([A-Za-z_][A-Za-z0-9_]*|"[^"]+"|`[^`]+`|\[[^\]]+\])/i.exec(statement)
    if (match === null) continue
    names.add(match[1].replace(/^["'`\[]|["'`\]]$/g, ''))
  }
  return [...names].sort()
}

/** 只读核验已知结构、全部外键及非NULL历史附件，关闭失败也阻断恢复。 */
export async function checkRestoredAssetsIntegrity(dbPath: string, options: AssetsIntegrityOptions = {}): Promise<void> {
  inspectAssetsCopy(dbPath, options)
}
