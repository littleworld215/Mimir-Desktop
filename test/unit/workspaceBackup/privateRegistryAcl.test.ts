import { afterEach, expect, it, vi } from 'vitest'
import { mkdirSync, mkdtempSync, writeFileSync, rmSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { protectNewPrivateDirectory, protectNewPrivateFile, verifyPrivatePath } from '../../../electron/workspaceBackup/privateRegistryAcl'

const probe = vi.hoisted(() => ({ forgedOwner: false }))
vi.mock('node:child_process', async original => {
  const cp = await original<typeof import('node:child_process')>()
  return { ...cp, spawnSync: (...args: Parameters<typeof cp.spawnSync>) => {
    const result = cp.spawnSync(...args)
    if (!probe.forgedOwner || result.status !== 0) return result
    const parsed = JSON.parse(String(result.stdout))
    return { ...result, stdout: JSON.stringify({ ...parsed, owner: 'S-1-5-21-999-999-999-999' }) }
  } }
})
const roots: string[] = []
afterEach(() => { probe.forgedOwner = false; for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })
function fixture() { const root = mkdtempSync(join(tmpdir(), 'mimir-acl-')); roots.push(root); return root }

it('真实Unicode私有目录和文件完成设置及独立回读，内容原样', () => {
  const root = fixture(), directory = join(root, '恢复 快照'), file = join(directory, '注册资料.json')
  mkdirSync(directory)
  protectNewPrivateDirectory(directory)
  verifyPrivatePath(directory, 'directory')
  writeFileSync(file, 'SYNTHETIC')
  protectNewPrivateFile(file)
  verifyPrivatePath(file, 'file')
  expect(readFileSync(file, 'utf8')).toBe('SYNTHETIC')
})
it('过期的共享截止点不能重新获得10秒预算', () => {
  const root = fixture()
  if (process.platform !== 'win32') return
  expect(() => protectNewPrivateDirectory(root, performance.now() - 1)).toThrowError(expect.objectContaining({ code: 'REGISTRY_PROTECTION_FAILED' }))
})
it('受控错误SID回读拒绝，不改变真实目录属主', () => {
  if (process.platform !== 'win32') return
  const root = fixture()
  protectNewPrivateDirectory(root)
  probe.forgedOwner = true
  expect(() => verifyPrivatePath(root, 'directory')).toThrowError(expect.objectContaining({ code: 'REGISTRY_PROTECTION_FAILED' }))
  probe.forgedOwner = false
  verifyPrivatePath(root, 'directory')
})
