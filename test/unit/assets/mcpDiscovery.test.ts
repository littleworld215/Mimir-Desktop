import { chmodSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { publishDiscovery, readDiscovery } from '../../../electron/assets/mcp/discovery'
import { localEndpoint } from '../../../electron/assets/mcp/localTransport'
const roots: string[] = []
const root = () => { const p = mkdtempSync(join(tmpdir(), 'assets-discovery-')); roots.push(p); return p }
afterEach(() => { for (const p of roots.splice(0)) rmSync(p, { recursive: true, force: true }) })
const info = () => ({ endpoint: localEndpoint(tmpdir()), token: 'a'.repeat(43) })
it('保护目录后发布；真实平台权限检查，发现凭据读取和退出删除', async () => {
  const published = await publishDiscovery(root(), info())
  const found = await readDiscovery(published.path)
  expect(found).toMatchObject({ ...published.info, pid: process.pid, version: 1 })
  await published.close()
  await expect(readDiscovery(published.path)).rejects.toMatchObject({ code: 'APP_NOT_RUNNING' })
})
it('拒绝已有发现文件和错误schema；失败不覆盖凭据', async () => {
  const r = root(), published = await publishDiscovery(r, info())
  const original = readFileSync(published.path, 'utf8')
  await expect(publishDiscovery(r, info())).rejects.toMatchObject({ code: 'BUSY' })
  expect(readFileSync(published.path, 'utf8')).toBe(original)
  writeFileSync(published.path, JSON.stringify({ ...published.info, endpoint: 'http://evil', apiKey: 'hidden' }))
  await expect(readDiscovery(published.path)).rejects.toMatchObject({ code: 'BAD_ENDPOINT' })
  await published.close()
  expect(readFileSync(published.path, 'utf8')).toContain('hidden') // 不是本次发布的文件，禁止误删
})
it('拒绝junction/符号链接发现目录，不写目标目录', async () => {
  const r = root(), other = root()
  symlinkSync(other, join(r, 'assets-mcp'), process.platform === 'win32' ? 'junction' : 'dir')
  await expect(publishDiscovery(r, info())).rejects.toMatchObject({ code: 'BAD_ENDPOINT' })
})
it('实际放宽ACL/权限后读取拒绝；超长文件也拒绝', async () => {
  const r = root(), published = await publishDiscovery(r, info())
  writeFileSync(published.path, 'x'.repeat(4097))
  await expect(readDiscovery(published.path)).rejects.toMatchObject({ code: 'BAD_ENDPOINT' })
  writeFileSync(published.path, JSON.stringify(published.info))
  if (process.platform === 'win32') {
    const script = `$p=$env:MIMIR_TEST_ACL_PATH; $a=[IO.Directory]::GetAccessControl($p); $s=New-Object System.Security.Principal.SecurityIdentifier('S-1-1-0'); $a.AddAccessRule((New-Object System.Security.AccessControl.FileSystemAccessRule($s,'ReadAndExecute','ContainerInherit,ObjectInherit','None','Allow'))); [IO.Directory]::SetAccessControl($p,$a)`
    await promisify(execFile)(join(process.env.SystemRoot!, 'System32/WindowsPowerShell/v1.0/powershell.exe'), ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')], { windowsHide: true, env: { ...process.env, MIMIR_TEST_ACL_PATH: join(r, 'assets-mcp') } })
  } else chmodSync(join(r, 'assets-mcp'), 0o755)
  await expect(readDiscovery(published.path)).rejects.toMatchObject({ code: 'BAD_ENDPOINT' })
  await expect(publishDiscovery(r, info())).rejects.toMatchObject({ code: 'BAD_ENDPOINT' })
})
