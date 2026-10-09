import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'

const VOLUME_PROBE = `
$ErrorActionPreference = 'Stop'
try {
  Add-Type -TypeDefinition @'
using System;
using System.Text;
using System.Runtime.InteropServices;
public static class MimirVolumeProbe {
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)]
  public static extern bool GetVolumePathNameW(string path, StringBuilder volume, uint length);
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode)]
  public static extern uint GetDriveTypeW(string volume);
}
'@
  $request = [Console]::In.ReadToEnd() | ConvertFrom-Json
  $volume = New-Object System.Text.StringBuilder 32768
  if (-not [MimirVolumeProbe]::GetVolumePathNameW($request.root, $volume, 32768)) { throw 'PROBE_FAILED' }
  @{driveType=[MimirVolumeProbe]::GetDriveTypeW($volume.ToString())} | ConvertTo-Json -Compress
} catch { [Console]::Out.WriteLine('PROBE_FAILED'); exit 1 }
`

/** 原生卷类型识别映射网络盘与挂载点；不靠盘符或路径形式宣称本机一致性。 */
function inspectWindowsVolume(root: string): number {
  if (process.platform !== 'win32' || !process.env.SystemRoot) throw Error('NATIVE_PROBE_UNAVAILABLE')
  const executable = join(process.env.SystemRoot, 'System32/WindowsPowerShell/v1.0/powershell.exe')
  if (!existsSync(executable)) throw Error('NATIVE_PROBE_UNAVAILABLE')
  let output: string
  try {
    output = execFileSync(executable, ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', VOLUME_PROBE], {
      input: JSON.stringify({ root }), encoding: 'utf8', timeout: 15_000, maxBuffer: 4096, windowsHide: true
    })
  } catch { throw Error('NATIVE_VOLUME_PROBE_FAILED') }
  try {
    const result = JSON.parse(output.replace(/^\uFEFF/, '')) as { driveType?: unknown }
    if (typeof result.driveType !== 'number' || !Number.isInteger(result.driveType)) throw Error()
    return result.driveType
  } catch { throw Error('NATIVE_VOLUME_PROBE_FAILED') }
}

export function assertWindowsLocalDisk(root: string, probe: (root: string) => number = inspectWindowsVolume) {
  if (!/^[a-z]:[\\/]/i.test(root) || /[\u0000-\u001f]/.test(root) || root.length > 32700) throw Error('NOT_LOCAL_DISK')
  const driveType = probe(root)
  if (driveType !== 2 && driveType !== 3) throw Error('NOT_LOCAL_DISK')
}
