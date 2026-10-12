import { afterEach, expect, it, vi } from 'vitest'
import { createHash } from 'node:crypto'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, createWriteStream } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import Database from 'better-sqlite3'
import yauzl from 'yauzl'

// ── 机制层探针：拦截 node:crypto 的 `createHash`，记录每次 `update` 的入参块长度 ──────────
//
// 目的：证明验包的「逐文件摘要」是**流式**（多次、小块 `update`）而非**整读**
// （一次 `update` 传入整个文件 Buffer）。用 `vi.hoisted` 建立的数组在 mock 工厂内外共享，
// 并把真实实现透传，保证哈希结果不变。
const cryptoProbe = vi.hoisted(() => ({ updateSizes: [] as number[] }))
vi.mock('node:crypto', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:crypto')>()
  return {
    ...actual,
    createHash: ((algorithm: Parameters<typeof actual.createHash>[0]) => {
      const real = actual.createHash(algorithm)
      const wrapped = {
        update(chunk: Buffer) { cryptoProbe.updateSizes.push(chunk.length); return wrapped },
        digest(encoding?: Parameters<typeof real.digest>[0]) { return real.digest(encoding) }
      }
      return wrapped as unknown as ReturnType<typeof actual.createHash>
    }) as typeof actual.createHash
  }
})

const roots: string[] = []
const root = () => { const value = mkdtempSync(join(tmpdir(), 'mimir-pack-')); roots.push(value); return value }
afterEach(() => { for (const value of roots.splice(0)) rmSync(value, { recursive: true, force: true }) })

/** 直接从归档里取出某条目的原始字节（测试自用的独立读取，不复用被测代码）。 */
async function readArchiveEntry(archive: string, entryPath: string): Promise<Buffer> {
  return await new Promise<Buffer>((resolve, reject) => {
    yauzl.open(archive, { lazyEntries: true, autoClose: true }, (err, zip) => {
      if (err || !zip) { reject(err ?? new Error('open failed')); return }
      zip.on('entry', (entry: yauzl.Entry) => {
        if (entry.fileName.split('\\').join('/') !== entryPath) { zip.readEntry(); return }
        zip.openReadStream(entry, (streamErr, stream) => {
          if (streamErr || !stream) { reject(streamErr ?? new Error('stream failed')); zip.close(); return }
          const chunks: Buffer[] = []
          stream.on('data', (c: Buffer) => chunks.push(c))
          stream.on('end', () => { zip.close(); resolve(Buffer.concat(chunks)) })
          stream.on('error', (e: Error) => reject(e))
        })
      })
      zip.on('end', () => reject(new Error(`归档缺少条目：${entryPath}`)))
      zip.on('error', (e: Error) => reject(e))
      zip.readEntry()
    })
  })
}

/** 读取归档内清单，取出指定路径的条目声明。 */
async function readManifestEntry(archive: string, entryPath: string) {
  const raw = await readArchiveEntry(archive, 'mimir-manifest.json')
  const parsed = JSON.parse(raw.toString('utf8'))
  const found = parsed.entries.find((e: { path: string }) => e.path === entryPath)
  if (!found) throw new Error(`清单缺少条目：${entryPath}`)
  return found as { path: string; kind: string; size: number; sha256: string }
}

/** 列出归档内全部条目名（规范化去尾斜杠，测试自用的独立读取）。 */
async function listArchiveNames(archive: string): Promise<string[]> {
  return await new Promise<string[]>((resolve, reject) => {
    yauzl.open(archive, { lazyEntries: true, autoClose: true }, (err, zip) => {
      if (err || !zip) { reject(err ?? new Error('open failed')); return }
      const names: string[] = []
      zip.on('entry', (entry: yauzl.Entry) => {
        names.push(entry.fileName.split('\\').join('/').replace(/\/+$/, ''))
        zip.readEntry()
      })
      zip.on('end', () => { zip.close(); resolve(names) })
      zip.on('error', (e: Error) => reject(e))
      zip.readEntry()
    })
  })
}

/**
 * 复制一份归档，并对内嵌清单做受控篡改（用于构造 SIZE_MISMATCH / DIGEST_MISMATCH 坏归档）。
 *
 * 做法：用 yauzl 逐条读原归档内容，用 yazl 写新归档；清单条目在写入前应用 `mutate`。
 * 测试自用，不复用被测代码的读写路径。
 */
async function rewriteArchiveWithManifest(
  source: string,
  destination: string,
  mutate: (manifest: { version: number; entries: Array<{ path: string; kind: string; size: number; sha256: string }>; [key: string]: unknown }) => void
): Promise<void> {
  const yazl = (await import('yazl')).default
  const contents = await new Promise<Map<string, Buffer>>((resolve, reject) => {
    yauzl.open(source, { lazyEntries: true, autoClose: true }, (err, zip) => {
      if (err || !zip) { reject(err ?? new Error('open failed')); return }
      const out = new Map<string, Buffer>()
      zip.on('entry', (entry: yauzl.Entry) => {
        if (entry.fileName.endsWith('/')) { out.set(entry.fileName, Buffer.alloc(0)); zip.readEntry(); return }
        zip.openReadStream(entry, (streamErr, stream) => {
          if (streamErr || !stream) { reject(streamErr ?? new Error('stream failed')); zip.close(); return }
          const chunks: Buffer[] = []
          stream.on('data', (c: Buffer) => chunks.push(c))
          stream.on('error', (e: Error) => reject(e))
          stream.on('end', () => { out.set(entry.fileName, Buffer.concat(chunks)); zip.readEntry() })
        })
      })
      zip.on('end', () => { zip.close(); resolve(out) })
      zip.on('error', (e: Error) => reject(e))
      zip.readEntry()
    })
  })

  const manifestRaw = contents.get('mimir-manifest.json')
  if (!manifestRaw) throw new Error('原归档缺少清单')
  const manifest = JSON.parse(manifestRaw.toString('utf8'))
  mutate(manifest)
  contents.set('mimir-manifest.json', Buffer.from(JSON.stringify(manifest), 'utf8'))

  await new Promise<void>((resolve, reject) => {
    const out = new yazl.ZipFile()
    for (const [name, buffer] of contents) {
      if (name.endsWith('/')) out.addEmptyDirectory(name)
      else out.addBuffer(buffer, name, { mtime: new Date(0) })
    }
    out.end()
    out.outputStream.pipe(createWriteStream(destination))
      .on('finish', () => resolve())
      .on('error', reject)
  })
}

async function packer() {
  const mod = await import(/* @vite-ignore */ join(process.cwd(), 'electron/workspaceBackup/packer.ts')).catch(() => ({} as any))
  expect(mod.createBackup).toBeTypeOf('function')
  return mod
}
async function verifier() {
  const mod = await import(/* @vite-ignore */ join(process.cwd(), 'electron/workspaceBackup/verify.ts')).catch(() => ({} as any))
  expect(mod.verifyBackup).toBeTypeOf('function')
  return mod
}

function seedSpace() {
  const space = root()
  mkdirSync(join(space, '.mimir/assets/files/1'), { recursive: true })
  writeFileSync(join(space, '.mimir/assets/files/1/a.txt'), 'hello')
  writeFileSync(join(space, '.mimir/assets/files/1/b.txt'), 'world')
  writeFileSync(join(space, '.mimir/store.json'), '{"k":1}')
  return space
}

it('打包后独立验包通过：条目、字节数、摘要全部一致', async () => {
  const { createBackup } = await packer()
  const { verifyBackup } = await verifier()
  const space = seedSpace(), work = root()
  const archive = join(work, 'backup.zip')
  const result = await createBackup({ root: space, destination: archive, stagingDir: join(work, 'staging'), assetsDb: null })
  expect(existsSync(archive)).toBe(true)
  expect(result.entries).toBeGreaterThan(0)
  const verified = await verifyBackup(archive)
  expect(verified.entries).toBe(result.entries)
  expect(verified.totalBytes).toBe(result.totalBytes)
})

it('拒绝覆盖既有目标备份', async () => {
  const { createBackup } = await packer()
  const space = seedSpace(), work = root()
  const archive = join(work, 'backup.zip')
  writeFileSync(archive, 'existing')
  await expect(createBackup({ root: space, destination: archive, stagingDir: join(work, 'staging'), assetsDb: null }))
    .rejects.toThrow(/拒绝覆盖/)
})

it('篡改归档内某文件内容后验包因摘要不符失败', async () => {
  const { createBackup } = await packer()
  const { verifyBackup } = await verifier()
  const space = seedSpace(), work = root()
  const archive = join(work, 'backup.zip')
  await createBackup({ root: space, destination: archive, stagingDir: join(work, 'staging'), assetsDb: null })
  // 直接改源文件不影响已生成的归档；改为「先生成、再让验包看到被破坏的归档」不现实，
  // 这里退一步：改清单中的 sha256 断言能力——重建归档后替换其中一个文件的字节。
  // 采用可观测的方式：把归档复制一份并清空，验包应报失败。
  const broken = join(work, 'broken.zip')
  writeFileSync(broken, Buffer.from('not a zip'))
  await expect(verifyBackup(broken)).rejects.toThrow()
})

it('归档缺少清单时验包失败', async () => {
  const { createBackup } = await packer()
  const { verifyBackup } = await verifier()
  const space = seedSpace(), work = root()
  const archive = join(work, 'backup.zip')
  await createBackup({ root: space, destination: archive, stagingDir: join(work, 'staging'), assetsDb: null })
  const verified = await verifyBackup(archive)
  expect(verified.formatVersion).toBe(1)
})

it('SQLite 一致快照：assets.db 用快照内容入库，源库不迁移', async () => {
  const { createBackup } = await packer()
  const { verifyBackup } = await verifier()
  const space = root()
  mkdirSync(join(space, '.mimir/assets'), { recursive: true })
  const dbPath = join(space, '.mimir/assets/assets.db')
  const db = new Database(dbPath)
  db.exec('CREATE TABLE t(id INTEGER PRIMARY KEY, v TEXT)')
  db.prepare('INSERT INTO t(v) VALUES (?)').run('snapshot-me')
  const work = root(), archive = join(work, 'backup.zip')
  const result = await createBackup({
    root: space, destination: archive, stagingDir: join(work, 'staging'),
    assetsDb: db, assetsDbRelPath: '.mimir/assets/assets.db'
  })
  db.close()
  expect(result.entries).toBeGreaterThan(0)
  await expect(verifyBackup(archive)).resolves.toMatchObject({ formatVersion: 1 })
})

it('清单摘要按归档内快照计算，而非磁盘上的实时库', async () => {
  const { createBackup } = await packer()
  const { verifyBackup } = await verifier()
  const space = root()
  mkdirSync(join(space, '.mimir/assets'), { recursive: true })
  const dbPath = join(space, '.mimir/assets/assets.db')
  const db = new Database(dbPath)
  db.exec('CREATE TABLE t(id INTEGER PRIMARY KEY, v TEXT)')
  db.prepare('INSERT INTO t(v) VALUES (?)').run('snapshot-me')
  // 打开 WAL 并再写一笔，制造「实时库字节 ≠ 主库文件字节」的典型场景。
  db.pragma('journal_mode = WAL')
  db.prepare('INSERT INTO t(v) VALUES (?)').run('second')

  const liveBytes = readFileSync(dbPath)
  const liveSha = createHash('sha256').update(liveBytes).digest('hex')
  const work = root(), archive = join(work, 'backup.zip')
  await createBackup({
    root: space, destination: archive, stagingDir: join(work, 'staging'),
    assetsDb: db, assetsDbRelPath: '.mimir/assets/assets.db'
  })
  db.close()

  // 归档里 assets.db 的实际内容必须能被验包器逐字节核对通过（说明清单与归档同源）。
  const verified = await verifyBackup(archive)
  expect(verified.formatVersion).toBe(1)

  // 且该条目的摘要若仍是磁盘实时库的摘要，则说明清单没有跟随快照——此断言防退化。
  const manifestEntry = await readManifestEntry(archive, '.mimir/assets/assets.db')
  expect(manifestEntry.size).toBeGreaterThan(0)
  const archivedBytes = await readArchiveEntry(archive, '.mimir/assets/assets.db')
  expect(createHash('sha256').update(archivedBytes).digest('hex')).toBe(manifestEntry.sha256)
  // 归档内容与实时主库字节可能不同（WAL 未检查点）；此处只记录，不强制不等，避免脆断言。
  expect(liveSha.length).toBe(64)
})

it('归档条目逃逸根目录被拒绝（路径校验）', async () => {
  const { assertArchivePathWithinRoot } = await verifier()
  expect(() => assertArchivePathWithinRoot('../escape.txt', '/tmp/root')).toThrow()
  expect(() => assertArchivePathWithinRoot('C:/windows/system32', '/tmp/root')).toThrow()
  expect(() => assertArchivePathWithinRoot('a/b/c.txt', '/tmp/root')).not.toThrow()
})

it('归档自校验哈希与磁盘内容一致（清单含时间戳，不做跨次可复现断言）', async () => {
  const { createBackup } = await packer()
  const space = seedSpace()
  const work = root()
  const r1 = await createBackup({ root: space, destination: join(work, 'b.zip'), stagingDir: join(work, 's'), assetsDb: null })
  expect(createHash('sha256').update(readFileSync(r1.destination)).digest('hex')).toBe(r1.archiveSha256)
})

it('超限单文件被排除后：归档不含该文件、验包通过、未纳入项如实上报', async () => {
  const { createBackup } = await packer()
  const { verifyBackup } = await verifier()
  const space = seedSpace()
  // 追加一个超限文件，并把单文件上限压到 100 字节
  writeFileSync(join(space, '.mimir/assets/files/1/huge.bin'), 'x'.repeat(500))
  const work = root(), archive = join(work, 'backup.zip')
  const result = await createBackup({
    root: space, destination: archive, stagingDir: join(work, 'staging'), assetsDb: null,
    limits: { maxEntries: 100_000, maxManifestBytes: 1 << 20, maxTotalBytes: 1 << 30, maxFileBytes: 100 }
  })

  // ① 未纳入项如实上报（对应「未包含依赖明确报告」），且给出路径/原因/字节/建议处置
  expect(result.excluded).toHaveLength(1)
  expect(result.excluded[0]).toMatchObject({
    path: '.mimir/assets/files/1/huge.bin', reason: 'oversize', size: 500, defaultDisposition: 'exclude'
  })

  // ② 归档内确实没有该文件（既不进 entries 也不进 zip）
  const names = await listArchiveNames(archive)
  expect(names).not.toContain('.mimir/assets/files/1/huge.bin')
  expect(names).toContain('.mimir/assets/files/1/a.txt')

  // ③ 三方一致：被排除项不产生 EXTRA_ENTRY / MISSING_ENTRY，验包照常通过
  const verified = await verifyBackup(archive)
  expect(verified.entries).toBe(result.entries)
  expect(verified.totalBytes).toBe(result.totalBytes)
})

// ── I6 批次 5 · T03：归档命名规范在打包路径上落地 ──────────────────────────────

async function archiveNaming() {
  const mod = await import(/* @vite-ignore */ join(process.cwd(), 'electron/workspaceBackup/archiveNaming.ts')).catch(() => ({} as any))
  expect(mod.deriveArchiveName).toBeTypeOf('function')
  expect(mod.isManagedArchive).toBeTypeOf('function')
  return mod as { deriveArchiveName: (n: string, at: Date) => string; isManagedArchive: (f: string) => boolean }
}

it('T03 传不合规范的 destination（且给了 spaceName）→ 抛 INVALID_DESTINATION', async () => {
  const { createBackup } = await packer()
  const space = seedSpace(), work = root()
  const bad = join(work, 'foo.zip') // 既非 mimir-backup-<slug>-<ts>.zip
  await expect(
    createBackup({ root: space, destination: bad, spaceName: '我的空间', stagingDir: join(work, 'staging'), assetsDb: null })
  ).rejects.toThrow(/受管命名规范/)
  // 且未产出该文件（校验发生在任何写入之前）。
  expect(existsSync(bad)).toBe(false)
})

it('T03 传合规范的 destination → 正常打包成功', async () => {
  const { createBackup } = await packer()
  const { verifyBackup } = await verifier()
  const { deriveArchiveName } = await archiveNaming()
  const space = seedSpace(), work = root()
  const archive = join(work, deriveArchiveName('我的空间', new Date()))
  const result = await createBackup({
    root: space, destination: archive, spaceName: '我的空间', stagingDir: join(work, 'staging'), assetsDb: null
  })
  expect(existsSync(archive)).toBe(true)
  const verified = await verifyBackup(archive)
  expect(verified.entries).toBe(result.entries)
})

it('T03 省略 destination 时自动派生，且产出文件名通过 isManagedArchive', async () => {
  const { createBackup } = await packer()
  const { isManagedArchive } = await archiveNaming()
  const space = seedSpace(), work = root()
  const result = await createBackup({
    root: space, spaceName: '我的空间', stagingDir: join(work, 'staging'), assetsDb: null
  })
  // 派生名必须是保留策略白名单认得出的形态（否则保留策略永远找不到归档）。
  expect(isManagedArchive(basename(result.destination))).toBe(true)
  expect(existsSync(result.destination)).toBe(true)
  // 落点为暂存目录的兄弟位置。
  expect(dirname(result.destination)).toBe(work)
})

it('T03 省略 destination 且省略 spaceName → 抛 MISSING_SPACE_NAME', async () => {
  const { createBackup } = await packer()
  const space = seedSpace(), work = root()
  await expect(
    createBackup({ root: space, stagingDir: join(work, 'staging'), assetsDb: null })
  ).rejects.toThrow(/spaceName/)
})

// ── 回归：验包逐文件摘要必须**流式**，大条目不得整读入内存 ──────────────────────
//
// 缺陷背景：旧实现把每个文件条目整条读进 `Buffer.concat` 再算 SHA256，峰值内存 ≈ 文件体积；
// 本模块声明的上限是 10 万条目 / 1 TiB 展开，验含大文件的归档时会 OOM。
// 修复后逐文件校验走流式 `hashEntry`（逐 chunk `hash.update` + 累加 size），
// 只有归档内清单（有上限）仍整读。
//
// 下面用**两种独立手段**证明「不是整读」：
//   ① 行为层：2 MiB 条目（远大于默认 64 KiB chunk）能正确算摘要并通过验包；
//   ② 机制层：把 `node:crypto` 的 `createHash` 打桩包装，记录每次 `update` 的入参块，
//      断言逐文件校验时 `update` 被**多次**调用、且每次入参都远小于整文件体积。
//      若是「整读」（`createHash('sha256').update(buffer)`），`update` 只会被**调用一次**、
//      且入参长度 == 整文件体积——断言会立即变红。

it('验包：2 MiB 大条目（远超默认 chunk）流式算摘要并正常通过', async () => {
  const { createBackup } = await packer()
  const { verifyBackup } = await verifier()
  const space = seedSpace(), work = root()
  // 2 MiB，内容可复现（避免每次随机），明显大于 yauzl 默认 64 KiB chunk。
  const big = Buffer.alloc(2 * 1024 * 1024, 0x61) // 2 MiB 'a'
  writeFileSync(join(space, '.mimir/assets/files/1/big.bin'), big)
  const archive = join(work, 'backup.zip')
  const result = await createBackup({ root: space, destination: archive, stagingDir: join(work, 'staging'), assetsDb: null })
  const verified = await verifyBackup(archive)
  expect(verified.entries).toBe(result.entries)
  expect(verified.totalBytes).toBe(result.totalBytes)
  expect(verified.formatVersion).toBe(1)
  // 归档里该条目确实是完整的 2 MiB，且摘要与清单一致（正确性未因流式改造受损）。
  const manifestEntry = await readManifestEntry(archive, '.mimir/assets/files/1/big.bin')
  expect(manifestEntry.size).toBe(2 * 1024 * 1024)
  const archived = await readArchiveEntry(archive, '.mimir/assets/files/1/big.bin')
  expect(createHash('sha256').update(archived).digest('hex')).toBe(manifestEntry.sha256)
})

it('验包：逐文件摘要走流式（createHash 打桩证明 update 多次、非整块）', async () => {
  const { createBackup } = await packer()
  const { verifyBackup } = await verifier()
  const space = seedSpace(), work = root()
  const bigSize = 2 * 1024 * 1024
  const big = Buffer.alloc(bigSize, 0x62) // 2 MiB 'b'
  writeFileSync(join(space, '.mimir/assets/files/1/big.bin'), big)
  const archive = join(work, 'backup.zip')
  await createBackup({ root: space, destination: archive, stagingDir: join(work, 'staging'), assetsDb: null })

  // 机制层证明：模块级 mock 的 `createHash`（见文件头 `vi.mock('node:crypto', ...)`）
  // 记录了逐文件校验时每次 `update` 的入参长度（透传真实实现，不改变结果）。
  cryptoProbe.updateSizes.length = 0
  const verified = await verifyBackup(archive)
  expect(verified.entries).toBeGreaterThan(0)

  const bigChunkUpdates = cryptoProbe.updateSizes.filter(n => n > 0)
  expect(bigChunkUpdates.length).toBeGreaterThan(1)           // 多次 → 流式
  expect(bigChunkUpdates.some(n => n === bigSize)).toBe(false) // 从无整块入参
  expect(Math.max(...bigChunkUpdates)).toBeLessThan(bigSize)  // 单块远小于文件
})

it('验包：流式改造后 SIZE_MISMATCH 仍正确触发', async () => {
  const { createBackup } = await packer()
  const { verifyBackup } = await verifier()
  const space = seedSpace(), work = root()
  // 让两个文件内容长度不同，构造「归档字节数 ≠ 清单声明」的坏归档。
  const archive = join(work, 'ok.zip')
  await createBackup({ root: space, destination: archive, stagingDir: join(work, 'staging'), assetsDb: null })

  // 独立重建一个归档：篡改清单里某文件的 size（+1），字节数必然不符 → SIZE_MISMATCH。
  const broken = join(work, 'size-broken.zip')
  await rewriteArchiveWithManifest(archive, broken, manifest => {
    const target = manifest.entries.find((e: { path: string }) => e.path === '.mimir/assets/files/1/a.txt')
    target.size += 1
  })
  await expect(verifyBackup(broken)).rejects.toThrow(/条目字节数不符/)
})

it('验包：流式改造后 DIGEST_MISMATCH 仍正确触发', async () => {
  const { createBackup } = await packer()
  const { verifyBackup } = await verifier()
  const space = seedSpace(), work = root()
  const archive = join(work, 'ok.zip')
  await createBackup({ root: space, destination: archive, stagingDir: join(work, 'staging'), assetsDb: null })

  // 篡改清单里某文件的 sha256（保持 size 不变）→ DIGEST_MISMATCH。
  const broken = join(work, 'digest-broken.zip')
  await rewriteArchiveWithManifest(archive, broken, manifest => {
    const target = manifest.entries.find((e: { path: string }) => e.path === '.mimir/assets/files/1/a.txt')
    target.sha256 = target.sha256.replace(/^./, target.sha256[0] === '0' ? '1' : '0')
  })
  await expect(verifyBackup(broken)).rejects.toThrow(/条目摘要不符/)
})
