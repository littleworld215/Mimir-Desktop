import { test, expect } from '@playwright/test'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'
import { launchApp } from '../fixtures/launch'
import { attachBackupEvidence } from '../fixtures/backupEvidence'
import { acquireStagingLock } from '../../electron/workspaceBackup/maintenanceRestoreHandler'
import type { WorkspaceBackupMaintenanceApi } from '../../shared/workspaceBackupContracts'

function hashes(root: string): Record<string, string> {
  const result: Record<string, string> = {}
  const visit = (folder: string) => {
    for (const item of readdirSync(folder, { withFileTypes: true })) {
      const file = join(folder, item.name)
      const key = relative(root, file)
      expect(item.isSymbolicLink()).toBe(false)
      if (item.isDirectory()) { result[key + '/'] = 'directory'; visit(file) }
      else result[key] = 'file:' + createHash('sha256').update(readFileSync(file)).digest('hex')
    }
  }
  visit(root); return result
}
for (const scenario of ['source', 'locked-registered'] as const) {
  test(`V15真实维护拒绝嵌套${scenario}，不创建记录/暂存/新空间且原目录不变`, async ({}, info) => {
    test.skip(process.platform !== 'win32' || process.arch !== 'x64', 'I6维护首版限Windows x64')
    let sourceRoot = '', otherRoot = ''
    const ctx = await launchApp({
      executablePath: process.env.MIMIR_E2E_PACKAGED,
      extraArgs: ['--workspace-maintenance'], maintenanceRestoreSuggestions: true, maintenanceRestoreScope: true,
      transformSeed: seed => {
        sourceRoot = seed.workspaces[0]!.path
        otherRoot = join(dirname(sourceRoot), '另一个已登记空间')
        if (scenario === 'locked-registered') seed.workspaces.push({ ...seed.workspaces[0]!, id: 'other-space', name: '另一个空间', path: otherRoot })
        return { ...seed, spaceData: { unknown: { keep: '合成原始资料' } } }
      }
    })
    let foreign: { release(): void } | undefined
    try {
      writeFileSync(join(sourceRoot, 'original.txt'), '合成资料\n')
      if (scenario === 'locked-registered') {
        mkdirSync(join(otherRoot, '.mimir'), { recursive: true })
        writeFileSync(join(otherRoot, '.mimir/store.json'), JSON.stringify({ original: '另一个合成空间' }))
        foreign = acquireStagingLock(otherRoot)
      }
      const backup = await ctx.page.evaluate(async () => {
        const api = (window as unknown as { workspaceBackupMaintenance: WorkspaceBackupMaintenanceApi }).workspaceBackupMaintenance
        return api.backupSpace!({ spaceId: 'e2e-space-0001' })
      })
      expect(backup.ok).toBe(true)
      if (!backup.ok) throw Error('Synthetic backup failed')
      const archivePath = join(ctx.tempHome.home, 'backups', backup.archiveName)
      const registry = join(ctx.tempHome.home, '.mimir/store.json'), before = readFileSync(registry)
      const protectedRoot = scenario === 'source' ? sourceRoot : otherRoot, beforeFiles = hashes(protectedRoot)
      const targetRoot = join(protectedRoot, '嵌套恢复')
      const result = await ctx.page.evaluate(async request => {
        const api = (window as unknown as { workspaceBackupMaintenance: WorkspaceBackupMaintenanceApi }).workspaceBackupMaintenance
        return api.restore!(request)
      }, { archivePath, targetRoot, spaceName: '不应发布的嵌套空间' })
      expect(result, JSON.stringify(result)).toMatchObject({ ok: false, code: 'INVALID_TARGET' })
      expect(existsSync(targetRoot)).toBe(false)
      expect(readFileSync(registry)).toEqual(before)
      expect(hashes(protectedRoot)).toEqual(beforeFiles)
      expect(existsSync(join(ctx.tempHome.home, '.mimir/restore-operations'))).toBe(false)
      await attachBackupEvidence(info, 'target-safety', { scenario, result, originalRootUnchanged: true, registryUnchanged: true, noJournalOrPublication: true, existingOtherLockPreserved: Boolean(foreign) })
    } finally {
      try { foreign?.release() } finally { await ctx.cleanup() }
    }
  })
}
