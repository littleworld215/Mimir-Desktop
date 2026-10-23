import { readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, isAbsolute, join, relative, sep } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import rawLog from 'electron-log/main'
import log, { agentLog, ipcLog, streamLog } from '../../electron/logger'

function isolatedLogPath(): string {
  const synthetic = join(tmpdir(), 'unconfigured-log-profile')
  // Resolving is pure; getFile() itself may create the file and must follow the guard.
  const path = rawLog.transports.file.resolvePathFn({
    appData: synthetic,
    appName: 'synthetic-log-guard',
    appVersion: '0',
    electronDefaultDir: join(synthetic, 'logs'),
    home: synthetic,
    libraryDefaultDir: join(synthetic, 'logs'),
    libraryTemplate: join(synthetic, '{appName}'),
    temp: tmpdir(),
    userData: synthetic
  })
  const rel = relative(tmpdir(), path)
  // Fail before writing if a future configuration regression points at a real profile.
  expect(isAbsolute(path)).toBe(true)
  expect(isAbsolute(rel) || rel === '..' || rel.startsWith(`..${sep}`)).toBe(false)
  expect(basename(dirname(path))).toMatch(/^mimir-test-logs-/)
  expect(rawLog.transports.file.getFile().path).toBe(path)
  return path
}

describe('Vitest 日志文件隔离', () => {
  it('出口异常时在请求真实日志文件之前失败', () => {
    const resolver = vi.spyOn(rawLog.transports.file, 'resolvePathFn').mockReturnValue('unconfigured-profile/logs/main.log')
    const access = vi.spyOn(rawLog.transports.file, 'getFile').mockImplementation(() => { throw new Error('unexpected-file-access') })
    try {
      expect(() => isolatedLogPath()).toThrow()
      expect(access).not.toHaveBeenCalled()
    } finally {
      access.mockRestore()
      resolver.mockRestore()
    }
  })

  it('导入生产日志模块前已将真实文件出口固定到独立临时目录', () => {
    expect(log).toBe(rawLog)
    expect(basename(isolatedLogPath())).toBe('main.log')
  })

  it('普通及作用域日志仍实际落盘，不通过禁用或模拟日志隐藏副作用', () => {
    const path = isolatedLogPath()
    log.info('synthetic-unit-log-default')
    agentLog.info('synthetic-unit-log-agent')
    streamLog.warn('synthetic-unit-log-stream')
    ipcLog.error('synthetic-unit-log-ipc')
    const body = readFileSync(path, 'utf8')
    for (const marker of ['default', 'agent', 'stream', 'ipc']) expect(body).toContain(`synthetic-unit-log-${marker}`)
    expect(body).toContain('(agent)')
    expect(body).toContain('(stream)')
    expect(body).toContain('(ipc)')
  })
})
