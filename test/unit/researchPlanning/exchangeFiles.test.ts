import { afterEach, expect, it } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readSelectedPlanningFile, writeSelectedPlanningExport } from '../../../electron/researchPlanning/exchangeFiles'

const roots: string[] = []
afterEach(() => roots.splice(0).forEach(root => rmSync(root, { recursive: true, force: true })))
it('原生选入仅接受有界普通UTF8文件，拒绝链接和目录', () => {
  const root = mkdtempSync(join(tmpdir(), 'mimir-planning-io-')); roots.push(root)
  const file = join(root, '科研.json'); writeFileSync(file, '{"合成":true}')
  expect(readSelectedPlanningFile(file).toString()).toBe('{"合成":true}')
  expect(() => readSelectedPlanningFile(root)).toThrow()
  const folder = join(root, 'link'); symlinkSync(root, folder, 'junction')
  expect(() => readSelectedPlanningFile(folder)).toThrow()
})
it('保存为新文件拒绝覆盖、内部元数据与链接别名，失败保留原内容', () => {
  const root = mkdtempSync(join(tmpdir(), 'mimir-planning-export-')); roots.push(root)
  const ctx = { scope: { id: 'space', epoch: 'epoch', root }, assertCurrent() {} }, file = join(root, 'result.json')
  writeSelectedPlanningExport(ctx, file, Buffer.from('原文\n'))
  expect(() => writeSelectedPlanningExport(ctx, file, Buffer.from('覆盖'))).toThrow()
  expect(readFileSync(file, 'utf8')).toBe('原文\n')
  const meta = join(root, '.mimir'); mkdirSync(meta)
  expect(() => writeSelectedPlanningExport(ctx, join(meta, 'export.json'), Buffer.from('wrong'))).toThrow()
  expect(existsSync(join(meta, 'export.json'))).toBe(false)
  const alias = join(root, 'alias'); symlinkSync(meta, alias, 'junction')
  expect(() => writeSelectedPlanningExport(ctx, join(alias, 'export.json'), Buffer.from('wrong'))).toThrow()
})
