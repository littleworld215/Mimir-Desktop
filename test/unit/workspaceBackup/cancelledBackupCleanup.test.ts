import { afterEach, expect, it, vi } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { MaintenanceTaskManager } from '../../../electron/workspaceBackup/maintenanceTask'
import { createBackup } from '../../../electron/workspaceBackup/packer'

const fault = vi.hoisted(() => ({ cancel: undefined as (() => void) | undefined, failRemoval: false }))
vi.mock('node:fs', async importOriginal => {
  const fs = await importOriginal<typeof import('node:fs')>()
  return { ...fs, createWriteStream: (...args: Parameters<typeof fs.createWriteStream>) => {
    const stream = fs.createWriteStream(...args)
    if (String(args[0]).endsWith('.zip.partial')) stream.once('open', () => { const cancel = fault.cancel; fault.cancel = undefined; cancel?.() })
    return stream
  }, unlinkSync: (...args: Parameters<typeof fs.unlinkSync>) => {
    if (fault.failRemoval && String(args[0]).endsWith('.zip.partial')) throw Object.assign(Error('synthetic deletion denial'), { code: 'EACCES' })
    return fs.unlinkSync(...args)
  } }
})
let root = ''
afterEach(() => { fault.cancel = undefined; fault.failRemoval = false; if (root) rmSync(root, { recursive: true, force: true }) })
it('real partial-file cleanup denial is reported as failure and preserves the owned artifact', async () => {
  root = mkdtempSync(join(tmpdir(), 'g06-cleanup-failure-'))
  const source = join(root, 'source'), stagingDir = join(root, 'packing'), destination = join(root, 'backup.zip')
  mkdirSync(source); writeFileSync(join(source, 'synthetic.txt'), Buffer.alloc(1024 * 1024, 71))
  const tasks = new MaintenanceTaskManager()
  fault.failRemoval = true
  fault.cancel = () => { tasks.cancel({ taskId: tasks.current!.taskId }) }
  const result = await tasks.run('backup', async () => { await createBackup({ root: source, destination, stagingDir, assetsDb: null }); return { ok: true } })
  expect(result).toMatchObject({ ok: false, code: 'TASK_CLEANUP_FAILED' })
  expect(existsSync(destination)).toBe(false)
  expect(readdirSync(stagingDir).filter(name => name.endsWith('.partial'))).toHaveLength(1)
})
