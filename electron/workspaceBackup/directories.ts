/**
 * 归档目录的**单一事实源**（I6 批次 3.5 · T01）。
 *
 * 收口「`backups` 目录名」这一事实：此前它在三处各写了一遍字面量
 * （`maintenanceMain.ts` 的只读清单、`retentionService.ts` 的清理目标、
 * `doctorReport.ts` 的归档扫描）。四处各写一遍迟早漂移，故上提为本常量。
 *
 * 纪律：本模块**纯常量 + 纯函数**，除 `node:path` 外**零 import**，**不 import electron**。
 * 这样主进程各模块与单测都能安全引用它，不引入任何 Electron / 运行环境耦合。
 */

import { join } from 'node:path'

/**
 * 归档目录名（相对用户 home）。
 *
 * 单一事实源：维护窗口的只读清单、doctor 的归档扫描、保留策略的清理目标、
 * 以及批次 3.5 的备份落点，**全部**取自本常量——四处各写一遍字面量迟早漂移。
 */
export const ARCHIVE_DIRECTORY_NAME = 'backups'

/**
 * 归档目录绝对路径（`join(home, ARCHIVE_DIRECTORY_NAME)`）。
 *
 * @param home 用户 home 目录（本机数据根）。
 * @returns 归档目录绝对路径。
 */
export function archiveDirectory(home: string): string {
  return join(home, ARCHIVE_DIRECTORY_NAME)
}
