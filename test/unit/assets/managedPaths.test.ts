/**
 * 资产库托管目录判定（`electron/assets/managedPaths.ts`）单测。
 *
 * 守护点：资产库的库文件 / 版本 blob / 暂存 / 备份必须被通用文件通道与 Agent 文件工具拒绝，
 * 但**不得**把整个 `<spaceRoot>/.mimir` 当成禁区（那里还有 store 与其它域）。
 */
import { describe, expect, it } from 'vitest'
import { join } from 'node:path'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { isManagedAssetPath, managedAssetRoot } from '../../../electron/assets/managedPaths'

function withSpace(fn: (space: string) => void): void {
  const space = mkdtempSync(join(tmpdir(), 'mimir-managed-'))
  try {
    fn(space)
  } finally {
    rmSync(space, { recursive: true, force: true })
  }
}

describe('isManagedAssetPath —— 托管子树内', () => {
  it('托管子树根自身为 true', () => {
    withSpace((space) => {
      expect(isManagedAssetPath(managedAssetRoot(space), space)).toBe(true)
    })
  })

  it('数据库及其 -wal / -shm 为 true', () => {
    withSpace((space) => {
      const root = managedAssetRoot(space)
      expect(isManagedAssetPath(join(root, 'assets.db'), space)).toBe(true)
      expect(isManagedAssetPath(join(root, 'assets.db-wal'), space)).toBe(true)
      expect(isManagedAssetPath(join(root, 'assets.db-shm'), space)).toBe(true)
    })
  })

  it('files / staging / backups 子树为 true', () => {
    withSpace((space) => {
      const root = managedAssetRoot(space)
      expect(isManagedAssetPath(join(root, 'files', '7', 'abc-note.md'), space)).toBe(true)
      expect(isManagedAssetPath(join(root, 'staging', 'tmp.bin'), space)).toBe(true)
      expect(isManagedAssetPath(join(root, 'backups', 'snap.zip'), space)).toBe(true)
    })
  })
})

describe('isManagedAssetPath —— 非托管路径不得误伤', () => {
  it('空间根本身不是托管路径', () => {
    withSpace((space) => {
      expect(isManagedAssetPath(space, space)).toBe(false)
    })
  })

  it('.mimir 下的非资产内容（store.json）不受影响', () => {
    withSpace((space) => {
      expect(isManagedAssetPath(join(space, '.mimir', 'store.json'), space)).toBe(false)
    })
  })

  it('同前缀兄弟目录（assets-other）不误判', () => {
    withSpace((space) => {
      expect(isManagedAssetPath(join(space, '.mimir', 'assets-other', 'x.txt'), space)).toBe(false)
    })
  })

  it('空间内普通文件不受影响', () => {
    withSpace((space) => {
      expect(isManagedAssetPath(join(space, 'notes', 'idea.md'), space)).toBe(false)
    })
  })

  it('空间外路径不受影响', () => {
    withSpace((space) => {
      expect(isManagedAssetPath(join(space, '..', 'elsewhere', 'x.txt'), space)).toBe(false)
    })
  })
})

describe('isManagedAssetPath —— 边界输入', () => {
  it('空串一律 false', () => {
    withSpace((space) => {
      expect(isManagedAssetPath('', space)).toBe(false)
      expect(isManagedAssetPath(join(space, '.mimir', 'assets', 'assets.db'), '')).toBe(false)
    })
  })

  it('相对路径经 resolve 后仍按绝对位置判定', () => {
    withSpace((space) => {
      const root = managedAssetRoot(space)
      const rel = join(root, 'files', '1', 'a.md')
      expect(isManagedAssetPath(rel, space)).toBe(true)
    })
  })

  it.runIf(process.platform === 'win32')('Windows 下大小写不敏感', () => {
    withSpace((space) => {
      const root = managedAssetRoot(space)
      expect(isManagedAssetPath(join(root.toUpperCase(), 'ASSETS.DB'), space)).toBe(true)
    })
  })
})
