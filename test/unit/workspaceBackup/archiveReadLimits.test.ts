import { afterEach, expect, it, vi } from 'vitest'
import { createHash } from 'node:crypto'
import { createWriteStream, mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pipeline } from 'node:stream/promises'
import yazl from 'yazl'
import yauzl from 'yauzl'
import { verifyBackup as verify } from '../../../electron/workspaceBackup/verify'
import { readArchiveManifest as preview } from '../../../electron/workspaceBackup/restoreArchive'
import { extractToStaging } from '../../../electron/workspaceBackup/extract'

interface Limits { maxEntries?: number; maxManifestBytes?: number; maxTotalBytes?: number }
const roots: string[] = []
const root = () => { const dir = mkdtempSync(join(tmpdir(), 'mimir-read-limit-')); roots.push(dir); return dir }
const digest = (value: string) => createHash('sha256').update(value).digest('hex')
const manifest = () => ({ version: 1, generatedAt: '2026-10-24T00:00:00.000Z', entries: [
  { path: 'a.txt', kind: 'file', size: 5, sha256: digest('hello') }
] })
afterEach(() => {
  vi.restoreAllMocks()
  for (const dir of roots.splice(0)) rmSync(dir, { recursive: true, force: true })
})

async function archive(dir: string, value: unknown = manifest(), files = [{ path: 'a.txt', content: 'hello' }]) {
  const file = join(dir, 'input.zip')
  const zip = new yazl.ZipFile()
  const done = pipeline(zip.outputStream, createWriteStream(file))
  for (const item of files) {
    if (item.path.endsWith('/')) zip.addEmptyDirectory(item.path)
    else zip.addBuffer(Buffer.from(item.content), item.path)
  }
  zip.addBuffer(Buffer.from(JSON.stringify(value)), 'mimir-manifest.json')
  zip.end()
  await done
  return file
}

type Mode = 'verify' | 'preview' | 'extract'
async function consume(mode: Mode, file: string, limits?: Limits) {
  if (mode === 'verify') return verify(file, limits)
  if (mode === 'preview') return preview(file, limits)
  const stagingRoot = join(root(), 'staging')
  mkdirSync(stagingRoot)
  const options = { archivePath: file, stagingRoot, limits }
  return extractToStaging(options)
}

// 只篡改独立ZIP中央目录字段，真实压缩流仍由yauzl解码。
function central(file: string, name: string, mutate: (bytes: Buffer, offset: number) => void) {
  const bytes = readFileSync(file)
  for (let offset = 0; offset < bytes.length - 46; offset++) {
    if (bytes.readUInt32LE(offset) !== 0x02014b50) continue
    const length = bytes.readUInt16LE(offset + 28)
    if (bytes.subarray(offset + 46, offset + 46 + length).toString('utf8') !== name) continue
    mutate(bytes, offset)
    writeFileSync(file, bytes)
    return
  }
  throw Error(`Fixture entry missing: ${name}`)
}

async function hiddenEntry(dir: string, zip64: boolean, duplicateManifest: boolean) {
  const file = join(dir, 'hidden.zip')
  const zip = new yazl.ZipFile()
  const done = pipeline(zip.outputStream, createWriteStream(file))
  zip.addBuffer(Buffer.from(JSON.stringify(manifest())), 'mimir-manifest.json')
  zip.addBuffer(Buffer.from('hello'), 'a.txt')
  zip.addBuffer(Buffer.from(duplicateManifest ? JSON.stringify(manifest()) : 'hidden'), duplicateManifest ? 'mimir-manifest.json' : 'extra.txt')
  zip.end({ forceZip64Format: zip64, comment: 'valid-comment' })
  await done
  const bytes = readFileSync(file)
  const end = bytes.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]))
  if (zip64) {
    const record = bytes.lastIndexOf(Buffer.from([0x50, 0x4b, 0x06, 0x06]))
    bytes.writeBigUInt64LE(2n, record + 24)
    bytes.writeBigUInt64LE(2n, record + 32)
  } else { bytes.writeUInt16LE(2, end + 8); bytes.writeUInt16LE(2, end + 10) }
  writeFileSync(file, bytes)
  return file
}

async function deflatedDirectory(dir: string, content: string) {
  const file = await archive(dir, { ...manifest(), entries: [{ path: 'folder', kind: 'directory', size: 0, sha256: '' }] }, [{ path: 'folder_', content }])
  central(file, 'folder_', (bytes, offset) => {
    bytes.writeUInt16LE(0x0314, offset + 4)
    bytes.writeUInt32LE(0x41ed0010, offset + 38)
    bytes.writeUInt32LE(0, offset + 24)
  })
  const bytes = readFileSync(file)
  const alias = Buffer.from('folder_')
  for (let offset = bytes.indexOf(alias); offset !== -1; offset = bytes.indexOf(alias, offset + alias.length)) bytes[offset + alias.length - 1] = 0x2f
  writeFileSync(file, bytes)
  return file
}

for (const mode of ['verify', 'preview', 'extract'] as const) {
  it.each([false, true])(`${mode}：合法ZIP64=%s含注释及ZIP64条目仍兼容`, async zip64 => {
    const file = join(root(), 'valid-footer.zip')
    const zip = new yazl.ZipFile()
    const done = pipeline(zip.outputStream, createWriteStream(file))
    zip.addBuffer(Buffer.from('hello'), 'a.txt', { forceZip64Format: zip64 })
    zip.addBuffer(Buffer.from(JSON.stringify(manifest())), 'mimir-manifest.json')
    zip.end({ forceZip64Format: zip64, comment: 'valid-comment' })
    await done
    await expect(consume(mode, file)).resolves.toBeDefined()
  })

  it.each([[false, false], [false, true], [true, false], [true, true]])(
    `${mode}：ZIP64=%s、隐藏重复清单=%s时EOCD少报条目不能借end放行`, async (zip64, duplicate) => {
      const file = await hiddenEntry(root(), zip64, duplicate)
      await expect(consume(mode, file, { maxEntries: 2 })).rejects.toThrow()
    })

  it(`${mode}：目录自报0字节但deflate实际含内容，必须拒绝`, async () => {
    await expect(consume(mode, await deflatedDirectory(root(), 'hidden-directory-content'))).rejects.toThrow()
  })

  it(`${mode}：合法deflate空目录可读，不能用压缩长度非零误拒`, async () => {
    await expect(consume(mode, await deflatedDirectory(root(), ''))).resolves.toBeDefined()
  })

  it(`${mode}：清单超过小预算即拒绝，不把压缩后的长度当清单长度`, async () => {
    const file = await archive(root(), { ...manifest(), padding: 'x'.repeat(8192) })
    await expect(consume(mode, file, { maxManifestBytes: 1024 })).rejects.toMatchObject({ code: 'MANIFEST_LIMIT' })
  })

  it(`${mode}：多个文件合计展开超限即拒绝`, async () => {
    const value = manifest()
    value.entries.push({ path: 'b.txt', kind: 'file', size: 5, sha256: digest('world') })
    const file = await archive(root(), value, [{ path: 'a.txt', content: 'hello' }, { path: 'b.txt', content: 'world' }])
    await expect(consume(mode, file, { maxTotalBytes: 9 })).rejects.toMatchObject({ code: 'TOTAL_LIMIT' })
  })

  it(`${mode}：默认1TiB限制不能只依赖调用方传入预算`, async () => {
    const value = { ...manifest(), entries: [{ ...manifest().entries[0], size: 1099511627777 }] }
    const file = await archive(root(), value)
    await expect(consume(mode, file)).rejects.toMatchObject({ code: 'TOTAL_LIMIT' })
  })

  it(`${mode}：ZIP实际条目上限包括清单`, async () => {
    const file = await archive(root())
    await expect(consume(mode, file, { maxEntries: 1 })).rejects.toMatchObject({ code: 'ENTRY_LIMIT' })
  })

  it(`${mode}：正好达到三种小上限仍可读，早期缺sourceRoot及未知键保留`, async () => {
    const value = { ...manifest(), legacyNote: '保留未知字段' }
    const file = await archive(root(), value)
    const result = await consume(mode, file, { maxEntries: 2, maxManifestBytes: Buffer.byteLength(JSON.stringify(value)), maxTotalBytes: 5 })
    expect(result).toBeDefined()
    const read = await preview(file) as unknown as Record<string, unknown>
    expect(read.sourceRoot).toBeUndefined()
    expect(read.legacyNote).toBe('保留未知字段')
  })

  it(`${mode}：空空间允许业务总量0`, async () => {
    const file = await archive(root(), { ...manifest(), entries: [] }, [])
    await expect(consume(mode, file, { maxTotalBytes: 0, maxEntries: 1 })).resolves.toBeDefined()
  })

  it(`${mode}：拒绝目录非零size，不能仅跳过目录内容检查`, async () => {
    const file = await archive(root(), { ...manifest(), entries: [
      { path: 'folder', kind: 'directory', size: 1, sha256: '' }
    ] }, [{ path: 'folder/', content: '' }])
    await expect(consume(mode, file)).rejects.toMatchObject({ code: 'MANIFEST_INVALID' })
  })

  it(`${mode}：拒绝ZIP链接元数据，不能默默转成普通文件`, async () => {
    const file = await archive(root())
    central(file, 'a.txt', (bytes, offset) => { bytes.writeUInt16LE(0x0314, offset + 4); bytes.writeUInt32LE(0xa1ff0000, offset + 38) })
    await expect(consume(mode, file)).rejects.toMatchObject({ code: 'UNSAFE_ENTRY' })
  })

  it(`${mode}：清单声明的目录缺失也拒绝`, async () => {
    const file = await archive(root(), { ...manifest(), entries: [
      ...manifest().entries, { path: 'missing', kind: 'directory', size: 0, sha256: '' }
    ] })
    await expect(consume(mode, file)).rejects.toMatchObject({ code: 'MISSING_ENTRY' })
  })

  const invalid = [
    ['null根', () => null],
    ['数组根', () => []],
    ['非法来源字段', () => ({ ...manifest(), sourceRoot: 123 })],
    ['非法生成时间类型', () => ({ ...manifest(), generatedAt: {} })],
    ['null条目', () => ({ ...manifest(), entries: [null] })],
    ['非法kind', () => ({ ...manifest(), entries: [{ ...manifest().entries[0], kind: 'link' }] })],
    ['负数size', () => ({ ...manifest(), entries: [{ ...manifest().entries[0], size: -1 }] })],
    ['小数size', () => ({ ...manifest(), entries: [{ ...manifest().entries[0], size: 0.5 }] })],
    ['不安全整数size', () => ({ ...manifest(), entries: [{ ...manifest().entries[0], size: 9007199254740992 }] })],
    ['缺size', () => ({ ...manifest(), entries: [{ path: 'a.txt', kind: 'file', sha256: digest('hello') }] })],
    ['非法SHA256', () => ({ ...manifest(), entries: [{ ...manifest().entries[0], sha256: 'not-a-digest' }] })]
  ] as const
  it.each(invalid)(`${mode}：%s返回明确清单错误`, async (_name, value) => {
    const file = await archive(root(), value())
    await expect(consume(mode, file)).rejects.toMatchObject({ code: 'MANIFEST_INVALID' })
  })

  it.each([{ maxEntries: 0 }, { maxManifestBytes: -1 }, { maxTotalBytes: NaN }, { maxTotalBytes: 1099511627777 }])(
    `${mode}：非法或提升生产上限的覆盖值拒绝`, async limits => {
      const file = await archive(root())
      await expect(consume(mode, file, limits)).rejects.toMatchObject({ code: 'LIMIT_INVALID' })
    })

  it(`${mode}：清单实际解压超过预算，即使ZIP自报偏小也停止`, async () => {
    const file = await archive(root(), { ...manifest(), padding: 'x'.repeat(128 * 1024) })
    central(file, 'mimir-manifest.json', (bytes, offset) => bytes.writeUInt32LE(12, offset + 24))
    // 仅关闭依赖库的自报大小检查，证明本项目自己的流式预算实际生效。
    const fromFd = yauzl.fromFd.bind(yauzl)
    vi.spyOn(yauzl, 'fromFd').mockImplementation((fd, options, callback) => fromFd(fd, { ...options, validateEntrySizes: false }, callback))
    await expect(consume(mode, file, { maxManifestBytes: 1024 })).rejects.toMatchObject({ code: 'MANIFEST_LIMIT' })
  })
}

it.each(['verify', 'extract'] as const)('%s：业务内容按实际流量计数，ZIP自报偏小不能绕过总量', async mode => {
  const content = 'x'.repeat(256 * 1024)
  const value = { ...manifest(), entries: [{ path: 'a.txt', kind: 'file', size: 1, sha256: digest(content) }] }
  const file = await archive(root(), value, [{ path: 'a.txt', content }])
  central(file, 'a.txt', (bytes, offset) => bytes.writeUInt32LE(1, offset + 24))
  const fromFd = yauzl.fromFd.bind(yauzl)
  vi.spyOn(yauzl, 'fromFd').mockImplementation((fd, options, callback) => fromFd(fd, { ...options, validateEntrySizes: false }, callback))
  await expect(consume(mode, file, { maxTotalBytes: 1024 })).rejects.toMatchObject({ code: 'TOTAL_LIMIT' })
})

it.each(['verify', 'extract'] as const)('%s：真实deflate损坏保留READ_FAILED，不降级INTERNAL', async mode => {
  const file = await archive(root())
  const bytes = readFileSync(file)
  const local = bytes.indexOf(Buffer.from([0x50, 0x4b, 0x03, 0x04]))
  const start = local + 30 + bytes.readUInt16LE(local + 26) + bytes.readUInt16LE(local + 28)
  bytes[start] = 0xff
  writeFileSync(file, bytes)
  await expect(consume(mode, file)).rejects.toMatchObject({ code: 'READ_FAILED' })
})

it('旧数字条目参数保留，超限报ENTRY_LIMIT', async () => {
  const file = await archive(root())
  await expect(verify(file, 1)).rejects.toMatchObject({ code: 'ENTRY_LIMIT' })
})

it.each(['verify', 'extract'] as const)('%s：第二遍归档被替换为缺清单，不能借用首遍清单放行', async mode => {
  const file = await archive(root())
  const other = join(root(), 'without-manifest.zip')
  const zip = new yazl.ZipFile()
  const done = pipeline(zip.outputStream, createWriteStream(other))
  zip.addBuffer(Buffer.from('hello'), 'a.txt')
  zip.end()
  await done
  const fromFd = yauzl.fromFd.bind(yauzl)
  let opened = 0
  vi.spyOn(yauzl, 'fromFd').mockImplementation((fd, options, callback) => fromFd(fd, options, (error, real) => {
    if (real && ++opened === 1) real.once('close', () => writeFileSync(file, readFileSync(other)))
    callback(error, real)
  }))
  await expect(consume(mode, file)).rejects.toMatchObject({ code: 'MANIFEST_MISSING' })
})

it('解压总量超限不将后续大块写入暂存，原资料保持', async () => {
  const dir = root()
  const original = join(dir, 'original.txt')
  writeFileSync(original, '原资料')
  const stagingRoot = join(dir, 'staging')
  mkdirSync(stagingRoot)
  const file = await archive(dir)
  const options = { archivePath: file, stagingRoot, limits: { maxTotalBytes: 4 } }
  await expect(extractToStaging(options)).rejects.toMatchObject({ code: 'TOTAL_LIMIT' })
  expect(readdirSync(stagingRoot)).toEqual([])
  expect(readFileSync(original, 'utf8')).toBe('原资料')
})

it('源流延迟打开时，写盘冲突仍是EXTRACT_FAILED且没有未处理错误', async () => {
  const file = await archive(root())
  const stagingRoot = root()
  mkdirSync(join(stagingRoot, 'a.txt'))
  const fromFd = yauzl.fromFd.bind(yauzl)
  vi.spyOn(yauzl, 'fromFd').mockImplementation((fd, options, callback) => fromFd(fd, options, (error, real) => {
    if (real) {
      const openRead = real.openReadStream.bind(real)
      vi.spyOn(real, 'openReadStream').mockImplementation((...args) => {
        if (args[0].fileName === 'a.txt') setTimeout(() => openRead(...args), 50)
        else openRead(...args)
      })
    }
    callback(error, real)
  }))
  await expect(extractToStaging({ archivePath: file, stagingRoot })).rejects.toMatchObject({ code: 'EXTRACT_FAILED' })
  expect(readdirSync(stagingRoot)).toEqual(['a.txt'])
})
