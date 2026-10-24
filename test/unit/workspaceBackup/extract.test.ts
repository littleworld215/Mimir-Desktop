import { expect, it, afterEach } from 'vitest'
import { createHash } from 'node:crypto'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, statSync, createWriteStream } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import yazl from 'yazl'

const roots: string[] = []
function workDir(prefix = 'mimir-extract-') {
  const root = mkdtempSync(join(tmpdir(), prefix))
  roots.push(root)
  return root
}
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })

async function extractModule() {
  const mod = await import(/* @vite-ignore */ join(process.cwd(), 'electron/workspaceBackup/extract.ts')).catch(() => ({} as any))
  expect(mod.extractToStaging).toBeTypeOf('function')
  return mod
}
async function contracts() {
  const mod = await import(/* @vite-ignore */ join(process.cwd(), 'electron/workspaceBackup/restoreContracts.ts')).catch(() => ({} as any))
  expect(mod.RestoreError).toBeTypeOf('function')
  return mod
}

/** 独立构造 ZIP：条目内容由调用方给出（含 manifest），不复用被测代码。 */
async function buildZip(destination: string, entries: Array<{ path: string; content: Buffer; dir?: boolean }>): Promise<void> {
  const zip = new yazl.ZipFile()
  for (const entry of entries) {
    if (entry.dir) zip.addEmptyDirectory(entry.path, { mtime: new Date(0) })
    else zip.addBuffer(entry.content, entry.path, { mtime: new Date(0) })
  }
  zip.end()
  await new Promise<void>((resolve, reject) => {
    zip.outputStream.pipe(createWriteStream(destination)).on('close', () => resolve()).on('error', reject)
  })
}

/**
 * 原始字节级 STORE-only ZIP 构造器（**独立于被测代码**）。
 *
 * 用于构造 `yazl` 拒绝生成的**恶意路径**（如 `../`）——只有绕过写入侧校验、
 * 直接拼字节，才能真实模拟「攻击者手工构造的归档」。
 */
function buildRawZipBytes(entries: Array<{ path: string; content: string }>): Buffer {
  const crcTable = (() => {
    const table: number[] = []
    for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1; table[n] = c >>> 0 }
    return table
  })()
  const crc32 = (buf: Buffer): number => { let c = 0xFFFFFFFF; for (const b of buf) c = crcTable[(c ^ b) & 0xFF]! ^ (c >>> 8); return (c ^ 0xFFFFFFFF) >>> 0 }
  const locals: Buffer[] = []
  const centrals: Buffer[] = []
  let offset = 0
  for (const entry of entries) {
    const name = Buffer.from(entry.path, 'utf8')
    const data = Buffer.from(entry.content)
    const crc = crc32(data)
    const local = Buffer.alloc(30)
    local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt16LE(0, 6); local.writeUInt16LE(0, 8)
    local.writeUInt16LE(0, 10); local.writeUInt16LE(0, 12); local.writeUInt32LE(crc, 14)
    local.writeUInt32LE(data.length, 18); local.writeUInt32LE(data.length, 22)
    local.writeUInt16LE(name.length, 26); local.writeUInt16LE(0, 28)
    locals.push(local, name, data)
    const central = Buffer.alloc(46)
    central.writeUInt32LE(0x02014b50, 0); central.writeUInt16LE(20, 4); central.writeUInt16LE(20, 6); central.writeUInt16LE(0, 8)
    central.writeUInt16LE(0, 10); central.writeUInt16LE(0, 12); central.writeUInt16LE(0, 14); central.writeUInt32LE(crc, 16)
    central.writeUInt32LE(data.length, 20); central.writeUInt32LE(data.length, 24)
    central.writeUInt16LE(name.length, 28); central.writeUInt16LE(0, 30); central.writeUInt16LE(0, 32)
    central.writeUInt16LE(0, 34); central.writeUInt16LE(0, 36); central.writeUInt32LE(0, 38); central.writeUInt32LE(offset, 42)
    centrals.push(central, name)
    offset += local.length + name.length + data.length
  }
  const localBuf = Buffer.concat(locals)
  const centralBuf = Buffer.concat(centrals)
  const eocd = Buffer.alloc(22)
  eocd.writeUInt32LE(0x06054b50, 0); eocd.writeUInt16LE(0, 4); eocd.writeUInt16LE(0, 6)
  eocd.writeUInt16LE(entries.length, 8); eocd.writeUInt16LE(entries.length, 10)
  eocd.writeUInt32LE(centralBuf.length, 12); eocd.writeUInt32LE(localBuf.length, 16); eocd.writeUInt16LE(0, 20)
  return Buffer.concat([localBuf, centralBuf, eocd])
}

/** 由条目内容构造清单（与 packer 的 ArchiveManifest 结构一致，version=1）。 */
function makeManifest(entries: Array<{ path: string; content: Buffer }>) {
  return {
    version: 1,
    generatedAt: new Date(0).toISOString(),
    entries: entries.map(entry => ({
      path: entry.path,
      kind: 'file' as const,
      size: entry.content.length,
      sha256: createHash('sha256').update(entry.content).digest('hex')
    }))
  }
}

/** 构造一份「内容 + 匹配清单」的合法归档，返回归档路径。 */
async function buildValidZip(dir: string, files: Array<{ path: string; content: Buffer }>): Promise<string> {
  const manifest = makeManifest(files)
  const archive = join(dir, 'backup.zip')
  await buildZip(archive, [
    ...files.map(f => ({ path: f.path, content: f.content })),
    { path: 'mimir-manifest.json', content: Buffer.from(JSON.stringify(manifest), 'utf8') }
  ])
  return archive
}

// ─── 通过组 ────────────────────────────────────────────────────────

it('正常归档解压后逐文件内容与 SHA256 与清单一致', async () => {
  const { extractToStaging } = await extractModule()
  const dir = workDir()
  const files = [
    { path: '.mimir/assets/assets.db', content: Buffer.from('SQLite format 3\0fake', 'utf8') },
    { path: 'papers/中文 论文.pdf', content: Buffer.from('pdf-bytes-内容', 'utf8') },
    { path: '.mimir/store.json', content: Buffer.from('{"k":1}', 'utf8') }
  ]
  const archive = await buildValidZip(dir, files)
  const staging = join(dir, 'staging')
  mkdirSync(staging)

  const result = await extractToStaging({ archivePath: archive, stagingRoot: staging })
  expect(result.files).toBe(3)
  expect(result.bytes).toBe(files.reduce((sum, f) => sum + f.content.length, 0))

  for (const file of files) {
    const actual = readFileSync(join(staging, file.path))
    expect(actual.equals(file.content)).toBe(true)
    const digest = createHash('sha256').update(actual).digest('hex')
    const declared = makeManifest(files).entries.find(e => e.path === file.path)!
    expect(digest).toBe(declared.sha256)
  }
})

it('大文件流式解压后仍逐字节正确（不整块读）', async () => {
  const { extractToStaging } = await extractModule()
  const dir = workDir()
  const big = Buffer.alloc(8 * 1024 * 1024, 0xab) // 8 MiB
  const archive = await buildValidZip(dir, [{ path: 'data/big.bin', content: big }])
  const staging = join(dir, 'staging')
  mkdirSync(staging)
  await extractToStaging({ archivePath: archive, stagingRoot: staging })
  const landed = readFileSync(join(staging, 'data/big.bin'))
  expect(landed.length).toBe(big.length)
  expect(createHash('sha256').update(landed).digest('hex')).toBe(createHash('sha256').update(big).digest('hex'))
})

it('目录条目不创建链接：落地为普通目录', async () => {
  const { extractToStaging } = await extractModule()
  const dir = workDir()
  const archive = join(dir, 'backup.zip')
  const manifest = makeManifest([{ path: 'a/b.txt', content: Buffer.from('x') }])
  // 目录同样属于真实归档集合；旧夹具漏列a，独立验包本来也会拒绝。
  manifest.entries.push({ path: 'a', kind: 'directory', size: 0, sha256: '' })
  await buildZip(archive, [
    { path: 'a', content: Buffer.alloc(0), dir: true },
    { path: 'a/b.txt', content: Buffer.from('x') },
    { path: 'mimir-manifest.json', content: Buffer.from(JSON.stringify(manifest), 'utf8') }
  ])
  const staging = join(dir, 'staging')
  mkdirSync(staging)
  await extractToStaging({ archivePath: archive, stagingRoot: staging })
  expect(statSync(join(staging, 'a')).isDirectory()).toBe(true)
  // 不是符号链接（Windows 上 junction 也会 isSymbolicLink=true，这里必须为 false）。
  expect(statSync(join(staging, 'a')).isSymbolicLink()).toBe(false)
})

// ─── 篡改组：必须失败 ───────────────────────────────────────────────

it('篡改归档内文件内容 → 解压后重算摘要必须失败（DIGEST_MISMATCH）', async () => {
  const { extractToStaging } = await extractModule()
  const { RestoreError } = await contracts()
  const dir = workDir()
  const real = Buffer.from('真实内容')
  // 清单声明真实内容的摘要，但归档里写入被篡改的内容。
  const manifest = makeManifest([{ path: 'x.txt', content: real }])
  const archive = join(dir, 'backup.zip')
  await buildZip(archive, [
    { path: 'x.txt', content: Buffer.from('篡改内容') },
    { path: 'mimir-manifest.json', content: Buffer.from(JSON.stringify(manifest), 'utf8') }
  ])
  const staging = join(dir, 'staging')
  mkdirSync(staging)
  try {
    await extractToStaging({ archivePath: archive, stagingRoot: staging })
    throw new Error('篡改内容应当被拒绝')
  } catch (error) {
    expect(error).toBeInstanceOf(RestoreError)
    expect(['DIGEST_MISMATCH', 'RECHECK_FAILED']).toContain((error as { code: string }).code)
  }
})

it('攻击者手工构造 ../ 逃逸条目 → 必须拒绝，且逃逸目标不被创建', async () => {
  const { extractToStaging } = await extractModule()
  const dir = workDir()
  const escape = join(dir, 'escaped.txt')
  const archive = join(dir, 'backup.zip')
  // 用原始字节构造器绕过 yazl 写入侧校验（模拟真实攻击归档）。
  const manifest = makeManifest([{ path: '../escaped.txt', content: Buffer.from('evil') }])
  writeFileSync(archive, buildRawZipBytes([
    { path: '../escaped.txt', content: 'evil' },
    { path: 'mimir-manifest.json', content: JSON.stringify(manifest) }
  ]))
  const staging = join(dir, 'staging')
  mkdirSync(staging)
  // 拒绝发生在**某一层**（yauzl 解码期或 extract 的 assertArchivePathWithinRoot），
  // 关键是整体 fail-closed：调用必须抛错。
  await expect(extractToStaging({ archivePath: archive, stagingRoot: staging })).rejects.toThrow()
  // 关键：逃逸目标**不得**被创建。
  expect(existsSync(escape)).toBe(false)
})

it('extract 自身的路径守卫拒绝越界条目（直接调用 assertArchivePathWithinRoot 同源约束）', async () => {
  // 说明：yauzl 在 decodeStrings 下已拒绝 `..`/绝对路径，属第一层防护；
  // 本用例断言 extract **依赖的** 第二层守卫（verify.assertArchivePathWithinRoot）语义正确，
  // 两层叠加构成 fail-closed。
  const verifyMod = await import(/* @vite-ignore */ join(process.cwd(), 'electron/workspaceBackup/verify.ts')).catch(() => ({} as any))
  expect(verifyMod.assertArchivePathWithinRoot).toBeTypeOf('function')
  const staging = workDir()
  expect(() => verifyMod.assertArchivePathWithinRoot('../escaped.txt', staging)).toThrow()
  expect(() => verifyMod.assertArchivePathWithinRoot('/absolute/x', staging)).toThrow()
  expect(() => verifyMod.assertArchivePathWithinRoot('C:/x', staging)).toThrow()
  expect(() => verifyMod.assertArchivePathWithinRoot('a/../../x', staging)).toThrow()
  // 正常相对路径不抛。
  expect(() => verifyMod.assertArchivePathWithinRoot('a/b.txt', staging)).not.toThrow()
})

it('归档缺少清单 → 必须失败（RECHECK_FAILED）', async () => {
  const { extractToStaging } = await extractModule()
  const dir = workDir()
  const archive = join(dir, 'backup.zip')
  await buildZip(archive, [{ path: 'x.txt', content: Buffer.from('x') }])
  const staging = join(dir, 'staging')
  mkdirSync(staging)
  await expect(extractToStaging({ archivePath: archive, stagingRoot: staging })).rejects.toThrow()
})

it('暂存根不存在 → 拒绝（须先独占创建）', async () => {
  const { extractToStaging } = await extractModule()
  const dir = workDir()
  const archive = await buildValidZip(dir, [{ path: 'x.txt', content: Buffer.from('x') }])
  await expect(extractToStaging({ archivePath: archive, stagingRoot: join(dir, 'nonexistent') })).rejects.toThrow()
})

// ─── 清理边界组 ────────────────────────────────────────────────────

it('解压中途失败后，原空间路径与原注册表必须原样存在', async () => {
  const { extractToStaging } = await extractModule()
  const dir = workDir()
  // 模拟「原空间」与「原注册表」。
  const originalSpace = join(dir, 'Mimir/我的科研空间')
  mkdirSync(join(originalSpace, '.mimir'), { recursive: true })
  writeFileSync(join(originalSpace, '.mimir/store.json'), '{"业务":"原样"}')
  const registry = join(dir, '.mimir/store.json')
  mkdirSync(join(dir, '.mimir'), { recursive: true })
  writeFileSync(registry, '{"workspaces:list":[]}')

  // 一份必然失败（内容与清单不符）的归档。
  const manifest = makeManifest([{ path: 'a.txt', content: Buffer.from('good') }])
  const archive = join(dir, 'backup.zip')
  await buildZip(archive, [
    { path: 'a.txt', content: Buffer.from('tampered') },
    { path: 'mimir-manifest.json', content: Buffer.from(JSON.stringify(manifest), 'utf8') }
  ])
  const staging = join(dir, 'staging')
  mkdirSync(staging)

  await expect(extractToStaging({ archivePath: archive, stagingRoot: staging })).rejects.toThrow()

  // 断言：原空间与原注册表**逐字未变、仍存在**。
  expect(existsSync(join(originalSpace, '.mimir/store.json'))).toBe(true)
  expect(readFileSync(join(originalSpace, '.mimir/store.json'), 'utf8')).toBe('{"业务":"原样"}')
  expect(existsSync(registry)).toBe(true)
  expect(readFileSync(registry, 'utf8')).toBe('{"workspaces:list":[]}')
})
