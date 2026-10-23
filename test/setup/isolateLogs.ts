/**
 * electron-log 的 CJS 依赖不会经过 Vitest 的 electron alias，可能回退到真实用户日志目录。
 * 保留实际文件写入及控制台输出，只在测试加载业务模块前固定独立临时出口。
 */
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import log from 'electron-log/main'

const directory = mkdtempSync(join(tmpdir(), 'mimir-test-logs-'))
const path = join(directory, 'main.log')
log.transports.file.resolvePathFn = () => path
