/** 本机用户凭据；不进入科研空间、同步目录或Git。错误不携带路径/凭据。 */
import { randomBytes } from 'node:crypto'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { chmodSync, lstatSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs'
import { dirname, isAbsolute, join, parse, resolve } from 'node:path'
import { assertLocalEndpoint, BrokerError } from './localTransport'

const run = promisify(execFile)
export interface DiscoveryInfo { version: 1; endpoint: string; token: string; session: string; pid: number }
// 固定.NET脚本；路径仅作为环境数据传入，不拼接用户输入到命令。
const aclScript = `
$ErrorActionPreference='Stop'
$p=$env:MIMIR_MCP_ACL_PATH
$sid=[System.Security.Principal.WindowsIdentity]::GetCurrent().User
$network=New-Object System.Security.Principal.SecurityIdentifier('S-1-5-2')
$isdir=[IO.Directory]::Exists($p)
if ($env:MIMIR_MCP_ACL_ACTION -eq 'protect') {
  if (!$isdir) { throw 'directory required' }
  $acl=New-Object System.Security.AccessControl.DirectorySecurity
  $acl.SetOwner($sid); $acl.SetAccessRuleProtection($true,$false)
  $flags=[System.Security.AccessControl.InheritanceFlags]'ContainerInherit,ObjectInherit'
  $acl.AddAccessRule((New-Object System.Security.AccessControl.FileSystemAccessRule($network,'FullControl',$flags,'None','Deny')))
  $acl.AddAccessRule((New-Object System.Security.AccessControl.FileSystemAccessRule($sid,'FullControl',$flags,'None','Allow')))
  [IO.Directory]::SetAccessControl($p,$acl)
}
$acl=if($isdir){[IO.Directory]::GetAccessControl($p)}else{[IO.File]::GetAccessControl($p)}
if($acl.GetOwner([System.Security.Principal.SecurityIdentifier]).Value -ne $sid.Value){throw 'owner'}
if($isdir -and !$acl.AreAccessRulesProtected){throw 'inheritance'}
$rules=@($acl.GetAccessRules($true,$true,[System.Security.Principal.SecurityIdentifier]))
if($rules.Count -ne 2){throw 'rules'}
$allow=$false; $deny=$false
foreach($rule in $rules){
  if($rule.FileSystemRights -ne [System.Security.AccessControl.FileSystemRights]::FullControl){throw 'rights'}
  if($rule.IdentityReference.Value -eq $sid.Value -and $rule.AccessControlType -eq 'Allow'){$allow=$true}
  elseif($rule.IdentityReference.Value -eq $network.Value -and $rule.AccessControlType -eq 'Deny'){$deny=$true}
  else{throw 'identity'}
  if($isdir -and ($rule.InheritanceFlags -ne [System.Security.AccessControl.InheritanceFlags]'ContainerInherit,ObjectInherit' -or $rule.PropagationFlags -ne 'None')){throw 'propagation'}
}
if(!$allow -or !$deny){throw 'missing'}
`
function assertPlainPath(path: string): void {
  if (!isAbsolute(path) || path.startsWith('\\\\') || path.includes('\u0000')) throw new BrokerError('BAD_ENDPOINT')
  // 拒绝路径上所有junction/symlink（包括父目录），不能重定向凭据到共享目录。
  for (let p = resolve(path); ; p = dirname(p)) {
    try { if (lstatSync(p).isSymbolicLink()) throw new BrokerError('BAD_ENDPOINT') } catch (error) {
      if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error
    }
    if (p === parse(p).root) break
  }
}
export async function assertPrivatePath(path: string, protect = false): Promise<void> {
  try {
    assertPlainPath(path)
    const stat = lstatSync(path)
    if (!stat.isDirectory() && !stat.isFile()) throw new BrokerError('BAD_ENDPOINT')
    if (process.platform === 'win32') {
      const systemRoot = process.env.SystemRoot ?? 'C:\\Windows'
      await run(join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'), ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(aclScript, 'utf16le').toString('base64')], {
        windowsHide: true, timeout: 10_000, maxBuffer: 4096,
        env: { SystemRoot: systemRoot, WINDIR: systemRoot, MIMIR_MCP_ACL_PATH: path, MIMIR_MCP_ACL_ACTION: protect ? 'protect' : 'verify' }
      })
    } else {
      if (protect) chmodSync(path, stat.isDirectory() ? 0o700 : 0o600)
      const checked = lstatSync(path)
      if (checked.uid !== process.getuid?.() || (checked.mode & 0o077) !== 0) throw new BrokerError('BAD_ENDPOINT')
    }
  } catch { throw new BrokerError('BAD_ENDPOINT') }
}
function validate(value: unknown): DiscoveryInfo {
  const v = value as DiscoveryInfo
  if (!v || typeof v !== 'object' || Array.isArray(v) || Object.keys(v).some(k => !['version', 'endpoint', 'token', 'session', 'pid'].includes(k)) ||
      v.version !== 1 || typeof v.endpoint !== 'string' || typeof v.token !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(v.token) ||
      typeof v.session !== 'string' || !/^[a-f0-9]{32}$/.test(v.session) || !Number.isSafeInteger(v.pid) || v.pid < 1) throw new BrokerError('BAD_ENDPOINT')
  assertLocalEndpoint(v.endpoint)
  return v
}
export async function readDiscovery(path: string): Promise<DiscoveryInfo> {
  try {
    assertPlainPath(path)
    if (lstatSync(path).size > 4096) throw new BrokerError('BAD_ENDPOINT')
    await assertPrivatePath(dirname(path)); await assertPrivatePath(path)
    return validate(JSON.parse(readFileSync(path, 'utf8')))
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') throw new BrokerError('APP_NOT_RUNNING')
    throw new BrokerError('BAD_ENDPOINT')
  }
}
/** 独占发布，不覆盖旧实例/崩溃残留。残留须确认桌面退出后手动删除。 */
export async function prepareDiscoveryDirectory(userData: string): Promise<string> {
  const directory = join(userData, 'assets-mcp')
  try {
    assertPlainPath(directory)
    let created = false
    try { mkdirSync(directory, { mode: 0o700 }); created = true } catch (error) { if (!(error instanceof Error && 'code' in error && error.code === 'EEXIST')) throw error }
    await assertPrivatePath(directory, created)
    return directory
  } catch { throw new BrokerError('BAD_ENDPOINT') }
}
export async function publishDiscovery(userData: string, credentials: { endpoint: string; token: string }): Promise<{ path: string; info: DiscoveryInfo; close(): Promise<void> }> {
  const directory = await prepareDiscoveryDirectory(userData), path = join(directory, 'session.json')
  const info = validate({ version: 1, ...credentials, session: randomBytes(16).toString('hex'), pid: process.pid })
  try {
    try { writeFileSync(path, JSON.stringify(info), { flag: 'wx', mode: 0o600 }) } catch (error) {
      if (error instanceof Error && 'code' in error && error.code === 'EEXIST') throw new BrokerError('BUSY')
      throw error
    }
    try { await assertPrivatePath(path) } catch (error) { unlinkSync(path); throw error }
    return { path, info, close: async () => {
      try { const current = await readDiscovery(path); if (current.session === info.session && current.token === info.token) unlinkSync(path) } catch { /* 不删非本次发布/不可验证文件 */ }
    } }
  } catch (error) { if (error instanceof BrokerError) throw error; throw new BrokerError('BAD_ENDPOINT') }
}
