import Database from 'better-sqlite3'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeEach, afterEach, it, expect, vi } from 'vitest'
// Exercise the real serializer at a small budget, without allocating a 200MiB CI fixture.
vi.mock('../../../shared/assetsContracts', async original => ({ ...await original<object>(), ASSET_TRANSFER_MAX_BYTES: 2048 }))
import { AssetsStoreManager } from '../../../electron/assets/store'
import type { AssetsContext } from '../../../electron/assets/types'
import { createAsset } from '../../../electron/assets/assetService'
import { exportAssets } from '../../../electron/assets/exchangeExport'
let root: string, manager: AssetsStoreManager, ctx: AssetsContext
beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), 'assets-export-budget-'))
  manager = new AssetsStoreManager({ active: () => ({ id: 'A', path: root }), epoch: () => 'A#1' }, (p, o) => new Database(p, o))
  ctx = await manager.getForRequest(manager.context())
})
afterEach(async () => { await manager.close(); rmSync(root, { recursive: true, force: true }) })
it('Markdown按自身UTF8预算而不是JSON转义预算，换行正文不误拒绝', () => {
  createAsset(ctx, { name: 'A', category: 'inbox', storageType: 'inline_text', content: '\n'.repeat(1250) })
  expect(Buffer.byteLength(exportAssets(ctx, { format: 'markdown' }).content, 'utf8')).toBeLessThan(2048)
  expect(() => exportAssets(ctx, { format: 'json' })).toThrowError(expect.objectContaining({ code: 'BAD_REQUEST' }))
})
it('最终UTF8产物超限明确失败，非ASCII不能按字符串长度绕过', () => {
  createAsset(ctx, { name: 'A', category: 'inbox', storageType: 'inline_text', content: '科研'.repeat(350) })
  expect(() => exportAssets(ctx, { format: 'markdown' })).toThrowError(expect.objectContaining({ code: 'BAD_REQUEST' }))
  expect(() => exportAssets(ctx, { format: 'json' })).toThrowError(expect.objectContaining({ code: 'BAD_REQUEST' }))
})
it('正文未超过提前预算，但标题备注与格式开销超限时最终序列化仍拒绝', () => {
  createAsset(ctx, { name: 'A', category: 'inbox', storageType: 'inline_text', content: 'x'.repeat(1500), notes: 'n'.repeat(800) })
  expect(() => exportAssets(ctx, { format: 'markdown' })).toThrowError(expect.objectContaining({ code: 'BAD_REQUEST' }))
})
