/** 固定系统程序设置并回读权限；原生进程真正结束后才返回，不传入凭据内容。 */
import { spawnSync } from 'node:child_process'
import { chmodSync, lstatSync, readdirSync } from 'node:fs'
import { dirname, isAbsolute, join, parse, resolve } from 'node:path'
import { RestoreError } from './restoreContracts'

const ACL_SCRIPT = `
$ErrorActionPreference='Stop'
try {
  $p=$env:MIMIR_REGISTRY_ACL_PATH
  $kind=$env:MIMIR_REGISTRY_ACL_KIND
  $sid=[System.Security.Principal.WindowsIdentity]::GetCurrent().User
  $network=New-Object System.Security.Principal.SecurityIdentifier('S-1-5-2')
  $dir=$kind -eq 'directory'
  if(([IO.File]::GetAttributes($p) -band [IO.FileAttributes]::ReparsePoint) -ne 0){throw 'reparse'}
  if($env:MIMIR_REGISTRY_ACL_ACTION -eq 'protect'){
    $acl=if($dir){New-Object System.Security.AccessControl.DirectorySecurity}else{New-Object System.Security.AccessControl.FileSecurity}
    $acl.SetOwner($sid); $acl.SetAccessRuleProtection($true,$false)
    $flags=if($dir){[System.Security.AccessControl.InheritanceFlags]'ContainerInherit,ObjectInherit'}else{[System.Security.AccessControl.InheritanceFlags]::None}
    $acl.AddAccessRule((New-Object System.Security.AccessControl.FileSystemAccessRule($network,'FullControl',$flags,'None','Deny')))
    $acl.AddAccessRule((New-Object System.Security.AccessControl.FileSystemAccessRule($sid,'FullControl',$flags,'None','Allow')))
    if($dir){[IO.Directory]::SetAccessControl($p,$acl)}else{[IO.File]::SetAccessControl($p,$acl)}
  }
  $acl=if($dir){[IO.Directory]::GetAccessControl($p)}else{[IO.File]::GetAccessControl($p)}
  $rules=@($acl.GetAccessRules($true,$true,[System.Security.Principal.SecurityIdentifier]) | ForEach-Object {
    @{sid=$_.IdentityReference.Value;rights=[int]$_.FileSystemRights;type=[string]$_.AccessControlType;inheritance=[int]$_.InheritanceFlags;propagation=[int]$_.PropagationFlags;inherited=$_.IsInherited}
  })
  @{owner=$acl.GetOwner([System.Security.Principal.SecurityIdentifier]).Value;current=$sid.Value;protected=$acl.AreAccessRulesProtected;rules=$rules} | ConvertTo-Json -Depth 4 -Compress
} catch { exit 1 }
`
const protectionError = () => new RestoreError('REGISTRY_PROTECTION_FAILED', '本机注册快照权限未通过验证，未继续登记；原资料保留。')

/** 不跟随路径中任何链接；用于同一专用凭据流程的身份核对。 */
export function assertPlainRegistryPath(path: string, kind: 'file' | 'directory') {
  if (!isAbsolute(path) || path.startsWith('\\\\') || path.includes('\0')) throw protectionError()
  const stat = lstatSync(path, { bigint: true })
  if (stat.isSymbolicLink() || (kind === 'directory' ? !stat.isDirectory() : !stat.isFile() || stat.nlink !== 1n)) throw protectionError()
  for (let parent = dirname(resolve(path)); ; parent = dirname(parent)) {
    const item = lstatSync(parent)
    if (item.isSymbolicLink() || !item.isDirectory()) throw protectionError()
    if (parent === parse(parent).root) break
  }
  return stat
}

function assertAcl(value: unknown, kind: 'file' | 'directory'): void {
  if (!value || typeof value !== 'object') throw protectionError()
  const v = value as Record<string, unknown>
  if (typeof v.current !== 'string' || !/^S-1(-\d+)+$/.test(v.current) || v.current === 'S-1-5-2'
    || v.owner !== v.current || v.protected !== true || !Array.isArray(v.rules) || v.rules.length !== 2) throw protectionError()
  const identities = new Set<string>()
  for (const value of v.rules) {
    if (!value || typeof value !== 'object') throw protectionError()
    const rule = value as Record<string, unknown>
    if (rule.rights !== 2032127 || rule.inherited !== false || rule.propagation !== 0 || rule.inheritance !== (kind === 'directory' ? 3 : 0)
      || !((rule.sid === v.current && rule.type === 'Allow') || (rule.sid === 'S-1-5-2' && rule.type === 'Deny'))
      || typeof rule.sid !== 'string' || identities.has(rule.sid)) throw protectionError()
    identities.add(rule.sid)
  }
}

function apply(path: string, kind: 'file' | 'directory', protect: boolean, deadline = performance.now() + 10_000): void {
  try {
    const before = assertPlainRegistryPath(path, kind)
    if (process.platform === 'win32') {
      const remaining = Math.min(10_000, Math.floor(deadline - performance.now()))
      if (remaining < 1) throw protectionError()
      const systemRoot = process.env.SystemRoot ?? 'C:\\Windows'
      const result = spawnSync(join(systemRoot, 'System32/WindowsPowerShell/v1.0/powershell.exe'),
        ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(ACL_SCRIPT, 'utf16le').toString('base64')], {
          windowsHide: true, encoding: 'utf8', timeout: remaining, maxBuffer: 4096,
          env: { SystemRoot: systemRoot, WINDIR: systemRoot, MIMIR_REGISTRY_ACL_PATH: path, MIMIR_REGISTRY_ACL_KIND: kind, MIMIR_REGISTRY_ACL_ACTION: protect ? 'protect' : 'verify' }
        })
      if (result.error || result.signal || result.status !== 0 || performance.now() >= deadline) throw protectionError()
      assertAcl(JSON.parse(result.stdout), kind)
    } else {
      if (before.uid !== BigInt(process.getuid!())) throw protectionError()
      if (protect) chmodSync(path, kind === 'directory' ? 0o700 : 0o600)
      const checked = lstatSync(path)
      if (checked.uid !== process.getuid!() || (checked.mode & 0o777) !== (kind === 'directory' ? 0o700 : 0o600)) throw protectionError()
    }
    const after = assertPlainRegistryPath(path, kind)
    if (before.dev !== after.dev || before.ino !== after.ino || before.birthtimeNs !== after.birthtimeNs) throw protectionError()
  } catch { throw protectionError() }
}

export function protectNewPrivateDirectory(path: string, deadline?: number): void {
  assertPlainRegistryPath(path, 'directory')
  if (readdirSync(path).length !== 0) throw protectionError()
  apply(path, 'directory', true, deadline)
}
export function protectNewPrivateFile(path: string, deadline?: number): void { apply(path, 'file', true, deadline) }
export function verifyPrivatePath(path: string, kind: 'file' | 'directory', deadline?: number): void { apply(path, kind, false, deadline) }
