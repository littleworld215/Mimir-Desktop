import { expect, it } from 'vitest'
import { mkdtempSync, mkdirSync, symlinkSync, unlinkSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve, dirname, basename } from 'node:path'
import { WINDOWS_PIPE_SOURCE } from '../../../electron/assets/mcp/windowsPipeSource'
import { instrumentRelayBundle, assertOutsideApp } from '../../../scripts/prepareAssetsWindowsPipeIsolation.mjs'

const bundle = () => `${WINDOWS_PIPE_SOURCE}\nchild.stderr.resume();\n  const fail = () => {\n  const onClosed = () => {\n  child.on("close", onClosed);\n      try {\n        const message = JSON.parse(line);`

it('退出诊断仅记录阶段、实例序号和数值错误，不泄露异常正文', () => {
  const result = instrumentRelayBundle(bundle(), 'connect-only')
  expect(result).toContain('int nativeError = Marshal.GetLastWin32Error(); handle.Dispose();')
  expect(result).toContain('DIAG nativeError=')
  expect(result).toContain('DIAG exception=')
  expect(result).toContain('error.GetType().Name')
  expect(result).toContain('error.HResult')
  expect(result).toContain('diagnosticStage = 3;')
  expect(result).toContain('diagnosticOrdinal = ordinal;')
  expect(result).toContain('DIAG wrapperFail ordinal=')
  expect(result).toContain('DIAG childClose code=')
  expect(result).not.toContain('error.Message')
  expect(result).not.toContain('error.StackTrace')
  expect(result).toContain('child.stderr.resume();')
})

it('诊断基线保留完整Relay，仅增加非强制GC的自进程观测', () => {
  const result = instrumentRelayBundle(bundle(), 'baseline')
  expect(result).toContain('var up = pipe.CopyToAsync(stream, 65536, linked.Token)')
  expect(result).toContain('var down = stream.CopyToAsync(pipe, 65536, linked.Token)')
  expect(result).toContain('GC.GetTotalMemory(false)')
  expect(result).not.toContain('GC.Collect(')
  expect(result).toContain('child.stderr.resume();')
})

it('纯管道对照去除TCP，连接对照保留TCP建立但移除NetworkStream复制', () => {
  const pipe = instrumentRelayBundle(bundle(), 'pipe-only')
  expect(pipe).not.toContain('new TcpClient()')
  expect(pipe).toContain('await pipe.CopyToAsync(pipe, 65536, stop)')
  const connect = instrumentRelayBundle(bundle(), 'connect-only')
  expect(connect).toContain('tcp.ConnectAsync("127.0.0.1", port)')
  expect(connect).not.toContain('tcp.GetStream()')
  for (const result of [pipe, connect]) {
    expect(result).toContain('CreateNamedPipeW(endpoint, 3u | 0x40000000u')
    expect(result).toContain('await pipe.WaitForConnectionAsync(stop.Token)')
    expect(result).toContain('Task.WhenAll(pending).Wait(3000)')
  }
})

it('未知模式、缺失或重复锚点拒绝生成，不能静默产出未隔离的假对照', () => {
  expect(() => instrumentRelayBundle(bundle(), 'unknown')).toThrow('BAD_MODE')
  expect(() => instrumentRelayBundle('not a relay', 'baseline')).toThrow('BUNDLE_MARKER')
  expect(() => instrumentRelayBundle(bundle() + bundle(), 'baseline')).toThrow('BUNDLE_MARKER')
})

it('拒绝再次改写已有诊断副本，避免重复监控改变观测条件', () => {
  const once = instrumentRelayBundle(bundle(), 'baseline')
  expect(() => instrumentRelayBundle(once, 'baseline')).toThrow('ALREADY_DIAGNOSTIC')
})

it('实际联接指向应用内部时拒绝，真正外部的输出父目录保持可用', () => {
  const owned = mkdtempSync(join(tmpdir(), 'mimir-isolation-path-'))
  const app = join(owned, 'app'), outside = join(owned, 'outside'), link = join(owned, 'alias')
  mkdirSync(app); mkdirSync(outside)
  symlinkSync(app, link, 'junction')
  try {
    expect(() => assertOutsideApp(app, outside)).not.toThrow()
    expect(() => assertOutsideApp(app, link)).toThrow('OUTPUT_INSIDE_APP')
    expect(() => assertOutsideApp(link, app)).toThrow('OUTPUT_INSIDE_APP')
  } finally {
    unlinkSync(link)
    if (dirname(resolve(owned)) !== resolve(tmpdir()) || !basename(owned).startsWith('mimir-isolation-path-')) {
      throw new Error('UNSAFE_TEST_CLEANUP')
    }
    rmSync(owned, { recursive: true, force: true })
  }
})
