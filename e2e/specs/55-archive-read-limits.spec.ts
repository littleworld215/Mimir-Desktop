import { test, expect } from '@playwright/test'
import { createHash } from 'node:crypto'
import { createWriteStream, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'
import { pipeline } from 'node:stream/promises'
import yazl from 'yazl'
import { launchApp } from '../fixtures/launch'
import type { WorkspaceBackupMaintenanceApi } from '../../shared/workspaceBackupContracts'

function hashes(root: string) {
  const result: Record<string, string> = {}
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const file = join(dir, entry.name)
      if (entry.isDirectory()) walk(file)
      else result[relative(root, file)] = createHash('sha256').update(readFileSync(file)).digest('hex')
    }
  }
  walk(root)
  return result
}

for (const scenario of ['manifest-limit', 'invalid-metadata'] as const) {
  test(`真实维护恢复拒绝${scenario}，不发布或注册且原资料不变`, async () => {
    let sourceRoot = ''
    const ctx = await launchApp({ executablePath: process.env.MIMIR_E2E_PACKAGED,
      extraArgs: ['--workspace-maintenance'], transformSeed: seed => { sourceRoot = seed.workspaces[0].path; return seed }
    })
    try {
      const before = hashes(sourceRoot)
      const registry = join(ctx.tempHome.home, '.mimir/store.json')
      const registryBefore = readFileSync(registry)
      const backups = join(ctx.tempHome.home, 'backups')
      mkdirSync(backups, { recursive: true })
      const archivePath = join(backups, 'mimir-backup-read-limits-20261024-000001.zip')
      const zip = new yazl.ZipFile()
      const done = pipeline(zip.outputStream, createWriteStream(archivePath))
      const content = Buffer.from('{}')
      const manifest = { version: 1, generatedAt: scenario === 'invalid-metadata' ? {} : '2026-10-24T00:00:00.000Z', entries: [
        { path: '.mimir', kind: 'directory', size: 0, sha256: '' },
        { path: '.mimir/store.json', kind: 'file', size: 2, sha256: createHash('sha256').update(content).digest('hex') }
      ] }
      zip.addEmptyDirectory('.mimir')
      zip.addBuffer(content, '.mimir/store.json')
      zip.addBuffer(Buffer.from(JSON.stringify(manifest)), 'mimir-manifest.json')
      zip.end()
      await done
      if (scenario === 'manifest-limit') {
        const bytes = readFileSync(archivePath)
        let changed = false
        for (let offset = 0; offset < bytes.length - 46; offset++) {
          if (bytes.readUInt32LE(offset) !== 0x02014b50) continue
          const length = bytes.readUInt16LE(offset + 28)
          if (bytes.subarray(offset + 46, offset + 46 + length).toString() !== 'mimir-manifest.json') continue
          bytes.writeUInt32LE(64 * 1024 * 1024 + 1, offset + 24)
          changed = true
          break
        }
        expect(changed).toBe(true)
        writeFileSync(archivePath, bytes)
      }
      const targetRoot = join(dirname(sourceRoot), '不应发布的空间')
      const result = await ctx.page.evaluate(async request => {
        const api = (window as unknown as { workspaceBackupMaintenance: WorkspaceBackupMaintenanceApi }).workspaceBackupMaintenance
        if (!api.restore) throw Error('No restore entry')
        return api.restore(request)
      }, { archivePath, targetRoot, spaceName: '不应发布的空间' })
      expect(result, JSON.stringify(result)).toMatchObject({ ok: false, code: scenario === 'manifest-limit' ? 'MANIFEST_LIMIT' : 'MANIFEST_INVALID' })
      expect(existsSync(targetRoot)).toBe(false)
      expect(readFileSync(registry)).toEqual(registryBefore)
      expect(hashes(sourceRoot)).toEqual(before)
    } finally { await ctx.cleanup() }
  })
}
