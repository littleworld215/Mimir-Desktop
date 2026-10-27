import type { WorkspaceBackupMaintenanceApi } from '../../shared/workspaceBackupContracts'
import { expect, test } from '@playwright/test'
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { launchApp } from '../fixtures/launch'
import { attachBackupEvidence } from '../fixtures/backupEvidence'

/** 只持有本轮合成资料，进程标准输入关闭即释放，不结束任何既有进程。 */
async function exclusivelyHold(path: string) {
  const script = "$ErrorActionPreference='Stop'; $f=[IO.File]::Open($env:MIMIR_G08_FILE,[IO.FileMode]::Open,[IO.FileAccess]::Read,[IO.FileShare]::None); try { [Console]::WriteLine('G08-READY'); [Console]::Out.Flush(); [void][Console]::ReadLine() } finally { $f.Dispose() }"
  const child = spawn(join(process.env.SystemRoot!, 'System32/WindowsPowerShell/v1.0/powershell.exe'), [
    '-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')
  ], { windowsHide: true, env: { ...process.env, MIMIR_G08_FILE: path }, stdio: ['pipe', 'pipe', 'pipe'] })
  const ended = new Promise<number | null>((resolve, reject) => { child.once('close', resolve); child.once('error', reject) })
  void ended.catch(() => {})
  const release = async () => {
    child.stdin.end('release\n')
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      const code = await Promise.race([ended, new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => { child.kill(); reject(Error('Synthetic file holder did not exit')) }, 5000)
      })])
      expect(code).toBe(0)
    } finally { clearTimeout(timer) }
  }
  try {
    await new Promise<void>((resolve, reject) => {
      let output = ''
      const timer = setTimeout(() => reject(Error('Synthetic file holder not ready')), 10000)
      child.stdout.on('data', chunk => {
        output = (output + chunk.toString()).slice(-1024)
        if (output.includes('G08-READY')) { clearTimeout(timer); resolve() }
      })
      ended.then(() => { clearTimeout(timer); reject(Error('Synthetic file holder exited before readiness')) }, error => { clearTimeout(timer); reject(error) })
    })
    return release
  } catch (error) { await release(); throw error }
}

test('G08真实Windows独占文件：备份失败不发布，句柄释放后原资料可再次备份', async () => {
  test.setTimeout(120_000)
  test.skip(process.platform !== 'win32' || process.arch !== 'x64', 'G08首版实际系统验收限Windows x64')
  let source = ''
  const ctx = await launchApp({ executablePath: process.env.MIMIR_E2E_PACKAGED, extraArgs: ['--workspace-maintenance'],
    transformSeed: seed => { source = seed.workspaces[0]!.path; return seed } })
  let release: (() => Promise<void>) | undefined
  try {
    const file = join(source, '合成独占资料.txt'), original = Buffer.from('G08真实共享拒绝，保留原资料\n')
    writeFileSync(file, original)
    const registry = join(ctx.tempHome.home, '.mimir/store.json'), before = readFileSync(registry)
    const backups = join(ctx.tempHome.home, 'backups'); mkdirSync(join(backups, '.staging'), { recursive: true })
    const names = readdirSync(backups)
    release = await exclusivelyHold(file)
    const backup = () => ctx.page.evaluate(async () => {
      const api = (window as unknown as { workspaceBackupMaintenance: WorkspaceBackupMaintenanceApi }).workspaceBackupMaintenance, overview = await api.overview()
      if (!overview.ok || !api.backupSpace) throw Error('Maintenance unavailable')
      return api.backupSpace({ spaceId: overview.spaces[0]!.id })
    })
    const failed = await backup()
    expect(failed.ok).toBe(false)
    expect(readFileSync(registry)).toEqual(before)
    expect(readdirSync(backups)).toEqual(names)
    expect(readdirSync(join(backups, '.staging'))).toEqual([])
    await release(); release = undefined
    expect(readFileSync(file)).toEqual(original)
    expect(existsSync(join(source, '.mimir/workspace.writer-lock'))).toBe(false)
    const recovered = await backup()
    expect(recovered, JSON.stringify(recovered)).toMatchObject({ ok: true, excluded: 0 })
    expect(readFileSync(file)).toEqual(original); expect(readFileSync(registry)).toEqual(before)
    await attachBackupEvidence(test.info(), 'actual-sharing-failure', {
      blockedResult: failed, afterRelease: { ok: recovered.ok }, sourceUnchanged: true, registryUnchanged: true,
      evidence: 'actual Windows FileShare.None handle, no ENOSPC injection or user process termination'
    })
  } finally { try { await release?.() } finally { await ctx.cleanup() } }
})
