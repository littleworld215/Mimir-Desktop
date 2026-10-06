import { it, expect } from 'vitest'
import { join } from 'path'
import { isInside } from '../../e2e/helpers/isolationPaths'
it('原生路径隔离允许子目录，拒绝同前缀目录和父目录', () => {
  const parent = join(process.cwd(), 'temp-home')
  expect(isInside(join(parent, 'home'), parent)).toBe(true)
  expect(isInside(parent, parent)).toBe(true)
  expect(isInside(`${parent}-other`, parent)).toBe(false)
  expect(isInside(join(parent, '..'), parent)).toBe(false)
})
