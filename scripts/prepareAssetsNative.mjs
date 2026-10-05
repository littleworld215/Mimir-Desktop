#!/usr/bin/env node
/**
 * 准备资产库 better-sqlite3 的**双 ABI** 原生绑定（I0-02）。
 *
 * 背景：Node 与 Electron 使用不同 ABI。本项目：
 * - 测试（vitest，Node）用 `node_modules/better-sqlite3/build/Release/better_sqlite3.node`（Node ABI，默认）。
 * - 应用（Electron）用 `.native/electron-<ver>/<platform>-<arch>/better_sqlite3.node`（Electron ABI）。
 *
 * 本脚本只用成熟工具 `prebuild-install`（better-sqlite3 自带依赖）下载**预编译**绑定，
 * 不自研 C++ 构建、不 spawn node.exe（规避本机 Windows Defender 锁 node.exe 的 EBUSY）。
 *
 * 用法：`node scripts/prepareAssetsNative.mjs`
 * 幂等：已存在且非空则跳过下载（`--force` 强制重下）。
 */
import { existsSync, mkdirSync, copyFileSync, statSync, readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'
import { execFileSync } from 'node:child_process'

const require = createRequire(import.meta.url)
const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const force = process.argv.includes('--force')

const electronVersion = JSON.parse(
  readFileSync(join(root, 'node_modules/electron/package.json'), 'utf8')
).version

const bsDir = dirname(require.resolve('better-sqlite3/package.json'))
const prebuildBin = join(bsDir, 'node_modules/prebuild-install/bin.js')
if (!existsSync(prebuildBin)) {
  console.error(`[assets-native] 未找到 prebuild-install：${prebuildBin}`)
  process.exit(1)
}

const platform = process.platform
const arch = process.arch
const outDir = join(root, '.native', `electron-${electronVersion}`, `${platform}-${arch}`)
const outFile = join(outDir, 'better_sqlite3.node')

const run = (args) =>
  execFileSync(process.execPath, [prebuildBin, ...args], { stdio: 'inherit', cwd: bsDir })

if (existsSync(outFile) && statSync(outFile).size > 0 && !force) {
  console.log(`[assets-native] 已存在，跳过：${outFile}`)
  process.exit(0)
}

mkdirSync(outDir, { recursive: true })
const buildFile = join(bsDir, 'build/Release/better_sqlite3.node')

console.log(`[assets-native] 下载 Electron ${electronVersion} ABI 绑定 …`)
run(['--runtime', 'electron', '--target', electronVersion, '--arch', arch, '--platform', platform, '--verbose'])
copyFileSync(buildFile, outFile)
console.log(`[assets-native] 已写入 ${outFile}`)

console.log('[assets-native] 恢复 Node ABI 绑定（供 vitest）…')
run(['--runtime', 'node', '--target', process.versions.node, '--arch', arch, '--platform', platform])

console.log('[assets-native] 完成。可用 `npm run assets:native:check`（Node）与 Electron 冒烟验证。')
