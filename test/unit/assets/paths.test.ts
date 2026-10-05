/**
 * 资产文件路径工具回归（`electron/assets/paths.ts`）。
 *
 * 重点：
 * - `safeFileName` 必须清洗 Windows 非法字符 / 结尾点空格，否则写入失败或产生路径歧义；
 * - `resolveWithinFiles` 不能只做字符串前缀检查 —— `files/` 内的 junction / symlink
 *   仍可指向库外，必须用 realpath 断言真实目标仍在可信 files 根之内。
 */
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  assetsLayout,
  resolveWithinFiles,
  safeFileName,
  versionBlobRelPath
} from '../../../electron/assets/paths'
import type { AssetsLayout } from '../../../electron/assets/paths'

describe('safeFileName：Windows 文件名清洗', () => {
  it('清洗 Windows 非法字符（: ? * < > " |）', () => {
    expect(safeFileName('result:raw.txt')).toBe('result_raw.txt')
    expect(safeFileName('x?.txt')).toBe('x_.txt')
    expect(safeFileName('a*b.txt')).toBe('a_b.txt')
    expect(safeFileName('a<b>c.txt')).toBe('a_b_c.txt')
    expect(safeFileName('a|b.txt')).toBe('a_b.txt')
    expect(safeFileName('a"b.txt')).toBe('a_b.txt')
  })

  it('清洗路径分隔符 / 并移除控制字符', () => {
    expect(safeFileName('a/b\\c')).toBe('a_b_c')
    expect(safeFileName('a\u0000b\u0001c')).toBe('abc')
  })

  it('去掉结尾的点与空格', () => {
    expect(safeFileName('CON.')).toBe('CON')
    expect(safeFileName('abc.')).toBe('abc')
    expect(safeFileName('abc ')).toBe('abc')
    expect(safeFileName('abc. .')).toBe('abc')
    expect(safeFileName('  spaced  ')).toBe('spaced')
  })

  it('清洗后为空 / 纯非法字符 → file', () => {
    expect(safeFileName('')).toBe('file')
    expect(safeFileName('   ')).toBe('file')
    expect(safeFileName('...')).toBe('file')
    expect(safeFileName('..')).toBe('file')
    expect(safeFileName('\u0000\u0001')).toBe('file')
  })

  it('保留长度上限并尽量保留扩展名', () => {
    expect(safeFileName('a'.repeat(200))).toHaveLength(120)
    expect(safeFileName(`${'a'.repeat(200)}.md`)).toBe(`${'a'.repeat(100)}.md`)
  })

  it('versionBlobRelPath 使用清洗后的磁盘名', () => {
    expect(versionBlobRelPath(7, 'blob1', 'result:raw.txt')).toBe('files/7/blob1-result_raw.txt')
  })
})

describe('resolveWithinFiles：realpath 级越界防护', () => {
  let root: string
  let layout: AssetsLayout

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'mimir-assets-'))
    layout = assetsLayout(root)
    mkdirSync(join(layout.filesDir, '7'), { recursive: true })
    writeFileSync(join(layout.filesDir, '7', 'blob-a.txt'), 'hello')
  })

  afterEach(() => {
    rmSync(root, { recursive: true, force: true })
  })

  it('正常相对路径通过（已存在文件）', () => {
    const abs = resolveWithinFiles(layout, 'files/7/blob-a.txt')
    expect(abs).toBe(join(layout.root, 'files', '7', 'blob-a.txt'))
  })

  it('写入前目标尚不存在时也通过（最近已存在祖先在 files 内）', () => {
    const abs = resolveWithinFiles(layout, 'files/7/blob-new.txt')
    expect(abs).toBe(join(layout.root, 'files', '7', 'blob-new.txt'))
  })

  it('拒绝绝对路径（POSIX / 盘符 / UNC）', () => {
    expect(() => resolveWithinFiles(layout, '/etc/passwd')).toThrow()
    expect(() => resolveWithinFiles(layout, 'C:/Windows/system32/config')).toThrow()
    expect(() => resolveWithinFiles(layout, '\\\\server\\share\\x')).toThrow()
  })

  it('拒绝含 .. 的路径', () => {
    expect(() => resolveWithinFiles(layout, 'files/../assets.db')).toThrow()
    expect(() => resolveWithinFiles(layout, '../outside.txt')).toThrow()
    expect(() => resolveWithinFiles(layout, 'files/7/../../x')).toThrow()
  })

  it('拒绝目录本身（files 根 / 子目录 / 尾斜杠）', () => {
    expect(() => resolveWithinFiles(layout, 'files')).toThrow()
    expect(() => resolveWithinFiles(layout, 'files/7')).toThrow()
    expect(() => resolveWithinFiles(layout, 'files/7/')).toThrow()
    expect(() => resolveWithinFiles(layout, '.')).toThrow()
  })

  it('拒绝 realpath 后越出 files 根的 junction/symlink', () => {
    const outside = mkdtempSync(join(tmpdir(), 'mimir-outside-'))
    writeFileSync(join(outside, 'secret.txt'), 'top-secret')
    // 在 files 内建一个指向库外的 junction（Windows 无需管理员权限）
    symlinkSync(outside, join(layout.filesDir, 'evil'), 'junction')

    // 目标文件不存在：应通过「最近已存在祖先」realpath 识别越界
    expect(() => resolveWithinFiles(layout, 'files/evil/x.txt')).toThrow()
    // 链接本身（已存在）也越界
    expect(() => resolveWithinFiles(layout, 'files/evil')).toThrow()

    rmSync(outside, { recursive: true, force: true })
  })
})
