/**
 * 路径包含判定（`electron/ipc/pathGuards.ts`）单测。
 *
 * 守护点：原先 `ipc/index.ts` 手拼 `'/'` 前缀的 `isWithin` 在下面这些形态下会误判——
 * 同前缀兄弟目录、`..`、软链 / junction 指向根外。本测试把它们钉死。
 */
import { describe, expect, it } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { isPathWithin, realpathOrNearest } from '../../electron/ipc/pathGuards'

function withTempDir(fn: (dir: string) => void): void {
  const dir = mkdtempSync(join(tmpdir(), 'mimir-pathguards-'))
  try {
    fn(dir)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

describe('isPathWithin —— 基本包含关系', () => {
  it('根自身视为包含', () => {
    expect(isPathWithin('/a/b', '/a/b')).toBe(true)
  })

  it('子路径视为包含', () => {
    expect(isPathWithin('/a/b/c.txt', '/a/b')).toBe(true)
  })

  it('父路径不视为包含', () => {
    expect(isPathWithin('/a', '/a/b')).toBe(false)
  })

  it('空串一律不包含', () => {
    expect(isPathWithin('', '/a')).toBe(false)
    expect(isPathWithin('/a', '')).toBe(false)
  })

  it('同前缀兄弟目录不误判（/a/b 与 /a/bc）', () => {
    expect(isPathWithin('/a/bc', '/a/b')).toBe(false)
    expect(isPathWithin('/a/bc/d.txt', '/a/b')).toBe(false)
  })

  it('含 `..` 的越界路径不误判', () => {
    expect(isPathWithin('/a/b/../c', '/a/b')).toBe(false)
    expect(isPathWithin('/a/b/../../etc/passwd', '/a/b')).toBe(false)
  })

  it('归一化后相等的路径视为包含（/a/b 与 /a/./b）', () => {
    expect(isPathWithin('/a/./b', '/a/b')).toBe(true)
  })
})

describe('isPathWithin —— 磁盘实体（软链 / junction）', () => {
  it('真实子目录通过、库外目录被拒', () => {
    withTempDir((dir) => {
      const inside = join(dir, 'inside')
      const outside = join(dir, 'outside')
      mkdirSync(join(inside, 'sub'), { recursive: true })
      mkdirSync(outside, { recursive: true })
      writeFileSync(join(outside, 'x.txt'), 'x')
      expect(isPathWithin(join(inside, 'sub', 'a.txt'), inside)).toBe(true)
      expect(isPathWithin(join(outside, 'x.txt'), inside)).toBe(false)
    })
  })

  it('inside 内指向库外的 junction/symlink 被 realpath 拦下', () => {
    withTempDir((dir) => {
      const inside = join(dir, 'inside')
      const outside = join(dir, 'outside')
      mkdirSync(inside, { recursive: true })
      mkdirSync(outside, { recursive: true })
      writeFileSync(join(outside, 'secret.txt'), 'secret')
      const link = join(inside, 'link')
      try {
        symlinkSync(outside, link, 'junction')
      } catch {
        return // 平台不支持创建链接（如无权限），跳过
      }
      // 纯字符串前缀会认为 link/secret.txt 在 inside 内；realpath 后其实在 outside。
      expect(isPathWithin(join(link, 'secret.txt'), inside)).toBe(false)
      // 链接自身的 realpath 也在库外
      expect(isPathWithin(link, inside)).toBe(false)
    })
  })
})

describe('realpathOrNearest', () => {
  it('对不存在的目标返回「最近已存在祖先 + 剩余段」', () => {
    withTempDir((dir) => {
      const missing = join(dir, 'nope', 'deep', 'file.txt')
      const resolved = realpathOrNearest(missing)
      expect(resolved.endsWith(join('nope', 'deep', 'file.txt'))).toBe(true)
    })
  })

  it('对已存在目标返回其真实路径', () => {
    withTempDir((dir) => {
      expect(realpathOrNearest(dir)).toBe(realpathOrNearest(dir))
    })
  })
})

describe('fail-closed —— 失效链接不得被当作「不存在」放行', () => {
  it('指向库外不存在目标的失效链接：isPathWithin 抛错（而非按字面路径放行）', () => {
    withTempDir((dir) => {
      const space = join(dir, 'space')
      mkdirSync(space, { recursive: true })
      const broken = join(space, 'broken')
      try {
        symlinkSync(join(dir, 'outside', 'missing'), broken, 'junction')
      } catch {
        return // 平台不支持创建链接，跳过
      }
      // 修复前：catch 吞掉 realpath 异常 → 退回字面路径 → 误判为「在 space 内」= true
      expect(() => isPathWithin(broken, space)).toThrow()
      expect(() => isPathWithin(join(broken, 'x.txt'), space)).toThrow()
    })
  })

  it('失效链接下的 realpathOrNearest 也抛错', () => {
    withTempDir((dir) => {
      const broken = join(dir, 'broken')
      try {
        symlinkSync(join(dir, 'nope'), broken, 'junction')
      } catch {
        return
      }
      expect(() => realpathOrNearest(broken)).toThrow()
    })
  })
})
