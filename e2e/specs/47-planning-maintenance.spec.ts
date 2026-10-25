import { test, expect } from '@playwright/test'
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { join, relative } from 'node:path'
import { launchApp } from '../fixtures/launch'
import { archiveDirectory } from '../../electron/workspaceBackup/directories'
import { emptyPlanningDocument, emptyPlanningInput } from '../../shared/researchPlanningDefaults'

function fingerprint(root: string): string[] {
  const result: string[] = []
  const visit = (path: string) => { for (const entry of readdirSync(path, { withFileTypes: true })) { const file = join(path, entry.name); if (entry.isDirectory()) visit(file); else result.push(`${relative(root, file)}:${createHash('sha256').update(readFileSync(file)).digest('hex')}`) } }
  visit(root); return result.sort()
}
for (const newer of [false, true]) {
  test(`科研计划维护：${newer ? '较新格式拒绝发布/注册' : '自检、整空间备份与新空间恢复'}，原空间逐文件不变`, async () => {
    test.setTimeout(180_000)
    let source = ''
    const ctx = await launchApp({ executablePath: process.env.MIMIR_E2E_PACKAGED, maintenanceRestoreSuggestions: true, extraArgs: ['--workspace-maintenance'], transformSeed: seed => {
      source = seed.workspaces[0]!.path
      const dir = join(source, '.mimir/planning'); mkdirSync(dir, { recursive: true })
      const stamp = '2026-10-21T00:00:00.000Z', doc = emptyPlanningDocument(); doc.revision = 1
      doc.items.push({ ...emptyPlanningInput('project'), id: 'project', title: '恢复项目', content: '科研资料原文\n\n', createdAt: stamp, updatedAt: stamp }, { ...emptyPlanningInput('todo'), id: 'todo', title: '恢复待办', projectId: 'project', dueDate: '2026-10-21', createdAt: stamp, updatedAt: stamp })
      writeFileSync(join(dir, 'planning.json'), JSON.stringify(newer ? { schemaVersion: 99 } : doc))
      writeFileSync(join(dir, 'drafts.json'), JSON.stringify({ schemaVersion: 1, revision: 1, drafts: [{ id: 'draft', itemId: null, baseRevision: 1, input: { ...emptyPlanningInput('generic'), content: '\n未命名的恢复草稿\n' }, updatedAt: stamp }] }))
      writeFileSync(join(dir, 'deliveries.json'), JSON.stringify({ schemaVersion: 1, revision: 1, deliveries: [{ itemId: 'todo', dueDate: '2026-10-21', deliveredAt: stamp }] }))
      writeFileSync(join(source, '.hidden-planning'), '未知资料完整保留')
      return seed
    } })
    try {
      await expect(ctx.page.getByRole('heading', { name: '备份与恢复维护窗口', exact: true })).toBeVisible()
      const before = fingerprint(source), registryPath = join(ctx.tempHome.home, '.mimir/store.json'), registryBytes = readFileSync(registryPath)
      const health = await ctx.page.evaluate(() => window.workspaceBackupMaintenance!.doctor!())
      expect(health.ok).toBe(true)
      if (!health.ok) throw Error('doctor')
      expect(health.checks.find(c => c.id === 'PLANNING_INTEGRITY')).toMatchObject({ severity: newer ? 'error' : 'ok' })
      const backup = await ctx.page.evaluate(async () => { const api = window.workspaceBackupMaintenance!, overview = await api.overview(); if (!overview.ok) throw Error('overview'); return api.backupSpace!({ spaceId: overview.spaces[0]!.id }) })
      expect(backup.ok).toBe(true); if (!backup.ok) throw Error('backup')
      const target = join(ctx.tempHome.home, 'Mimir', '合成恢复计划')
      const restored = await ctx.page.evaluate(request => window.workspaceBackupMaintenance!.restore(request), { archivePath: join(archiveDirectory(ctx.tempHome.home), backup.archiveName), targetRoot: target, spaceName: '合成恢复计划' })
      if (newer) {
        expect(restored).toMatchObject({ ok: false, code: 'RECHECK_FAILED' })
        expect(existsSync(target)).toBe(false); expect(readFileSync(registryPath)).toEqual(registryBytes)
      } else {
        expect(restored.ok).toBe(true)
        for (const name of ['planning.json', 'drafts.json', 'deliveries.json']) expect(readFileSync(join(target, '.mimir/planning', name))).toEqual(readFileSync(join(source, '.mimir/planning', name)))
        expect(readFileSync(join(target, '.hidden-planning'), 'utf8')).toBe('未知资料完整保留')
        const registry = JSON.parse(readFileSync(registryPath, 'utf8')), previous = JSON.parse(registryBytes.toString())
        expect(registry['workspaces:list']).toHaveLength(2); expect(registry.activeWorkspaceId).toBe(previous.activeWorkspaceId); expect(registry.defaultWorkspaceId).toBe(previous.defaultWorkspaceId); expect(registry.settings).toEqual(previous.settings)
      }
      expect(fingerprint(source)).toEqual(before)
    } finally { await ctx.cleanup() }
  })
}
