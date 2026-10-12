import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  WORKSPACE_BACKUP_CHANNELS
} from '../../../shared/workspaceBackupContracts'
import { ARCHIVE_DIRECTORY_NAME, archiveDirectory } from '../../../electron/workspaceBackup/directories'

/**
 * I6 批次 3.5 · T01 契约与共享常量的**源码契约**测试。
 *
 * 两条纪律在这里用「逐字字符串断言」钉死，防止后续重构悄悄漂移：
 * 1. 新增通道 `backupSpace` / `backupProgress` 的通道名必须与 `ipcGate.ts` 的
 *    `control` / `workspaceChanges` 集合**互斥**（沿袭 `ipcGate.test.ts` 的读源码文本手法）。
 * 2. 归档目录名 `backups` 收口为共享常量后，三个消费方都**不再**各自写死字面量。
 */

/** 读仓库内某源码文件的文本（用仓库根作基准，与既有 `mainWiring.test.ts` 手法一致）。 */
const readSource = (relativePath: string): string =>
  readFileSync(join(process.cwd(), relativePath), 'utf8')

describe('WORKSPACE_BACKUP_CHANNELS · 批次 3.5 新增通道', () => {
  it('backupSpace 通道名逐字对齐（防漂移）', () => {
    // 逐字对齐：通道名是 preload / main 两侧的单一事实源，改一个字就会让 invoke 静默失联。
    expect(WORKSPACE_BACKUP_CHANNELS.backupSpace).toBe('workspaceBackup:backupSpace')
  })

  it('backupProgress 通道名逐字对齐（防漂移）', () => {
    expect(WORKSPACE_BACKUP_CHANNELS.backupProgress).toBe('workspaceBackup:backupProgress')
  })
})

describe('新增通道与 ipcGate 的 control / workspaceChanges 集合互斥（K8 红线）', () => {
  it('backupSpace 不出现在 ipcGate.ts 里', () => {
    // 读源码文本断言：新通道由 maintenanceMain 用独立 ipcMain 注册，从不经过
    // installWorkspaceIpcGate。若它出现在 ipcGate.ts 里，即意味着被包进控制闸门（可能死锁）。
    const gateSource = readSource('electron/workspaceBackup/ipcGate.ts')
    expect(gateSource).not.toContain('workspaceBackup:backupSpace')
  })

  it('backupProgress 不出现在 ipcGate.ts 里', () => {
    const gateSource = readSource('electron/workspaceBackup/ipcGate.ts')
    expect(gateSource).not.toContain('workspaceBackup:backupProgress')
  })
})

describe('ARCHIVE_DIRECTORY_NAME · 共享常量（单一事实源）', () => {
  it('常量值为 backups', () => {
    expect(ARCHIVE_DIRECTORY_NAME).toBe('backups')
  })

  it('archiveDirectory(home) 等价于 join(home, "backups")', () => {
    // 注意：Windows 上 join 用 `\`，故用 join 对照而非硬编码 `'/'`。
    expect(archiveDirectory('/x')).toBe(join('/x', 'backups'))
    expect(archiveDirectory('/x').endsWith('backups')).toBe(true)
  })
})

describe('三处消费方已收口到共享常量（不再各自写死 backups 字面量）', () => {
  const consumers = [
    'electron/workspaceBackup/maintenanceMain.ts',
    'electron/workspaceBackup/retentionService.ts',
    'electron/workspaceBackup/doctorReport.ts'
  ]

  for (const file of consumers) {
    it(`${file} import 了 directories 共享常量`, () => {
      const src = readSource(file)
      // 文本层面必须能 grep 到共享常量的引用（import 或使用点），证明确实收口了。
      const usesSharedConstant =
        src.includes("from './directories'") ||
        src.includes('ARCHIVE_DIRECTORY_NAME') ||
        src.includes('archiveDirectory')
      expect(usesSharedConstant).toBe(true)
    })
  }

  it('maintenanceMain.ts 不再保留本地 ARCHIVE_DIRECTORY_NAME 字面量定义', () => {
    const src = readSource('electron/workspaceBackup/maintenanceMain.ts')
    // 旧的本地定义 `const ARCHIVE_DIRECTORY_NAME = 'backups'` 必须被删除（改从共享模块 import）。
    expect(src).not.toContain("ARCHIVE_DIRECTORY_NAME = 'backups'")
  })

  it('retentionService.ts 不再保留本地 BACKUPS_DIR_NAME 字面量定义', () => {
    const src = readSource('electron/workspaceBackup/retentionService.ts')
    expect(src).not.toContain("BACKUPS_DIR_NAME = 'backups'")
  })

  it('doctorReport.ts 不再内联 join(home, "backups")', () => {
    const src = readSource('electron/workspaceBackup/doctorReport.ts')
    expect(src).not.toContain("join(home, 'backups')")
  })
})
