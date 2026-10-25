import { afterEach, expect, it, vi } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import yauzl from 'yauzl'
import type { EventEmitter } from 'node:events'
import { createBackup } from '../../../electron/workspaceBackup/packer'
import { openArchive } from '../../../electron/workspaceBackup/archiveReader'
import { MaintenanceTaskManager } from '../../../electron/workspaceBackup/maintenanceTask'
import { captureBackupSource } from '../../../electron/workspaceBackup/backupSource'
import { fingerprintRestoredRoot } from '../../../electron/workspaceBackup/restoreFingerprint'
import { RestoreJournal } from '../../../electron/workspaceBackup/restoreJournal'

const fault = vi.hoisted(() => ({ mode: '' as 'source' | 'fingerprint' | 'journal' | 'abort-read' | '', cancel: undefined as (() => void) | undefined }))
vi.mock('node:fs', async original => {
  const actual = await original<typeof import('node:fs')>()
  return { ...actual, openSync: (...args: Parameters<typeof actual.openSync>) => {
    const fd = actual.openSync(...args)
    if (fault.mode === 'abort-read' && String(args[0]).endsWith('data.txt')) setImmediate(() => { fault.mode = ''; fault.cancel?.() })
    return fd
  }, closeSync: (fd: number) => {
    actual.closeSync(fd)
    if (fault.mode === 'source' || fault.mode === 'journal') { fault.mode = ''; fault.cancel?.(); throw Error('synthetic source close failure') }
  } }
})
vi.mock('node:fs/promises', async original => {
  const actual = await original<typeof import('node:fs/promises')>()
  return { ...actual, open: async (...args: Parameters<typeof actual.open>) => {
    const handle = await actual.open(...args)
    if (fault.mode === 'abort-read' && String(args[0]).endsWith('data.txt')) setImmediate(() => { fault.mode = ''; fault.cancel?.() })
    return new Proxy(handle, { get(target, key) {
      if (key === 'close') return async () => {
        await target.close()
        if (fault.mode === 'fingerprint' || fault.mode === 'source') { fault.mode = ''; fault.cancel?.(); throw Error('synthetic reader close failure') }
      }
      const value = Reflect.get(target, key, target)
      return typeof value === 'function' ? value.bind(target) : value
    } })
  } }
})

let root = ''
afterEach(() => { fault.mode = ''; fault.cancel = undefined; vi.restoreAllMocks(); if (root) rmSync(root, { recursive: true, force: true }) })
it('归档关闭失败不能在取消时被覆盖成已完整取消', async () => {
  root = mkdtempSync(join(tmpdir(), 'g06-archive-close-'))
  const source = join(root, 'source'), archive = join(root, 'archive.zip')
  mkdirSync(source); writeFileSync(join(source, 'data.txt'), 'synthetic')
  await createBackup({ root: source, destination: archive, stagingDir: join(root, 'packing'), assetsDb: null })
  const close = yauzl.ZipFile.prototype.close
  vi.spyOn(yauzl.ZipFile.prototype, 'close').mockImplementation(function (this: yauzl.ZipFile) {
    ;(this as yauzl.ZipFile & { reader: EventEmitter }).reader.emit('error', Error('synthetic close receipt failure'))
    close.call(this)
  })
  const tasks = new MaintenanceTaskManager()
  expect(await tasks.run('doctor', async () => {
    const handle = await openArchive(archive)
    tasks.cancel({ taskId: tasks.current!.taskId })
    await handle.close()
    return { ok: true }
  })).toMatchObject({ ok: false, code: 'TASK_CLEANUP_FAILED' })
  await new Promise(resolve => setImmediate(resolve))
})
it.each(['source', 'fingerprint'] as const)('%s关闭失败必须保留收尾失败状态', async mode => {
  root = mkdtempSync(join(tmpdir(), 'g06-source-close-'))
  writeFileSync(join(root, 'data.txt'), 'synthetic')
  const tasks = new MaintenanceTaskManager()
  fault.mode = mode; fault.cancel = () => { tasks.cancel({ taskId: tasks.current!.taskId }) }
  expect(await tasks.run('doctor', async () => {
    if (mode === 'source') await captureBackupSource(root)
    else await fingerprintRestoredRoot(root)
    return { ok: true }
  })).toMatchObject({ ok: false, code: 'TASK_CLEANUP_FAILED' })
})
it('操作记录文件关闭失败不能被取消码覆盖', async () => {
  root = mkdtempSync(join(tmpdir(), 'g06-journal-close-'))
  const home = join(root, 'home'); mkdirSync(join(home, '.mimir'), { recursive: true })
  const tasks = new MaintenanceTaskManager(), journal = new RestoreJournal(home)
  fault.mode = 'journal'; fault.cancel = () => { tasks.cancel({ taskId: tasks.current!.taskId }) }
  expect(await tasks.run('restore', async () => {
    journal.create(join(root, 'new-space'), '合成')
    return { ok: true }
  })).toMatchObject({ ok: false, code: 'TASK_CLEANUP_FAILED' })
})
it('实际已打开文件后再取消，来源读取只由一个句柄所有者关闭', async () => {
  root = mkdtempSync(join(tmpdir(), 'g06-inflight-reader-'))
  writeFileSync(join(root, 'data.txt'), Buffer.alloc(4 * 1024 * 1024, 71))
  const tasks = new MaintenanceTaskManager()
  fault.mode = 'abort-read'; fault.cancel = () => { tasks.cancel({ taskId: tasks.current!.taskId }) }
  expect(await tasks.run('backup', async () => { await captureBackupSource(root); return { ok: true } })).toMatchObject({ ok: false, code: 'CANCELLED' })
  rmSync(join(root, 'data.txt'))
})
