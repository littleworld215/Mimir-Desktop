/**
 * 资产文件版本服务（I1-04）。
 *
 * 覆盖 `shared/assetsContracts.ts` 的 6 个方法：
 * - importFile   把任意文件作为**新版本**导入到文件型资产（不可变 blob 落到托管 files/ 目录）
 * - saveFile     把某版本（文件或正文）落盘到渲染层选定的目标路径
 * - listVersions 分页版本历史
 * - getVersion   取单个版本（含正文 / source）
 * - diffVersions 文本版本逐行 diff；文件版本返回 kind='file'（无逐行 diff）
 * - rollbackVersion 以旧版本为正文 / 复用旧 blob 生成新版本（append-only 语义）
 *
 * 设计纪律（与 I0/I1 其它服务一致）：
 * - 唯一写入入口是 `ctx.write`；会话在事务结束后失效，跨 await 持有即失效。
 * - 导入复制异步完成，受 manager.run 跟踪；DB 事务仅做同步提交。
 * - 版本 append-only：staging 完成后复核 scope 与条件，搬入 blob；事务未提交才清理本操作文件。
 * - 渲染层传入的路径在 IPC 层经 `assertRendererPath` 校验，服务层只接收已可信的绝对路径。
 */

import { basename, dirname, join, resolve } from 'node:path'
import { createHash } from 'node:crypto'
import { compareVersionText } from './versionDiff'
import {
  constants,
  type Stats,
  fstatSync,
  read,
  write,
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  openSync,
  closeSync,
  realpathSync,
  linkSync,
  statSync,
  unlinkSync,
  writeFileSync
} from 'node:fs'
import type {
  AssetDetail,
  AssetVersion,
  VersionDiff,
  VersionFileMetadata,
  VersionPage,
  WriteCondition
} from '../../shared/assetsContracts'
import { ASSET_FILE_MAX_BYTES } from '../../shared/assetsContracts'
import { AssetsStoreError, type AssetsContext, type AssetsWriteSession } from './types'
import { assertFileBytes } from './validation'
import { selectAsset, detail, appendVersion, type AssetRow } from './assetRepository'
import { newBlobId, versionBlobRelPath, resolveWithinFiles, safeFileName, type AssetsLayout } from './paths'
import {
  selectVersion,
  countVersions,
  listVersionRows,
  versionSummary,
  toAssetVersion,
  type VersionRow
} from './versionRepository'

// ── 参数校验基元 ──────────────────────────────────────────────────────────
function object(input: unknown, label: string): Record<string, unknown> {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) {
    throw new AssetsStoreError('BAD_REQUEST', `${label}必须是对象。`)
  }
  return input as Record<string, unknown>
}
function positive(input: unknown, label = 'id'): number {
  if (typeof input !== 'number' || !Number.isSafeInteger(input) || input <= 0) {
    throw new AssetsStoreError('BAD_REQUEST', `${label}非法。`)
  }
  return input
}
/** 解析条件写；显式 null 要求当前无版本，缺省才不校验版本指针。 */
function parseCondition(c: unknown): {
  expectedRevision: number
  hasVersion: boolean
  expectedCurrentVersionId: number | null | undefined
} {
  const o = object(c, '条件')
  if (Object.keys(o).some(k => !['expectedRevision', 'expectedCurrentVersionId'].includes(k))) {
    throw new AssetsStoreError('BAD_REQUEST', '条件参数非法。')
  }
  const expectedRevision = positive(o.expectedRevision, 'expectedRevision')
  const hasVersion = Object.hasOwn(o, 'expectedCurrentVersionId')
  let expectedCurrentVersionId: number | null | undefined
  if (hasVersion) {
    if (o.expectedCurrentVersionId === null) expectedCurrentVersionId = null
    else if (o.expectedCurrentVersionId !== undefined) expectedCurrentVersionId = positive(o.expectedCurrentVersionId, 'expectedCurrentVersionId')
  }
  return { expectedRevision, hasVersion, expectedCurrentVersionId }
}
/** 分页参数：默认 1 / 50，上限 200，仅接受正整数 safe integer。 */
function parsePaging(page: unknown, pageSize: unknown): { page: number; pageSize: number } {
  const p = page === undefined ? 1 : positive(page, 'page')
  const ps = pageSize === undefined ? 50 : positive(pageSize, 'pageSize')
  if (ps > 200) throw new AssetsStoreError('BAD_REQUEST', '每页条数超过上限。')
  return { page: p, pageSize: ps }
}

/**
 * 判定源路径是否为符号链接 / junction（跨平台、纯函数，便于单测）。
 *
 * 两种跨平台判定，任一命中即视为链接：
 * - `stat.isSymbolicLink()` 为真：覆盖 Windows 的文件 / 目录符号链接与 junction 在 lstat 下的报告。
 * - 否则若 `realpath` 解析到的路径与入参 `resolvedPath` 不同：覆盖 lstat 不报 symbolicLink 的少数情况。
 * `realPath` 为 null 时无法确认磁盘实体，fail-closed 拒绝；Windows 比较统一大小写。
 */
export function sourceIsLink(
  stat: { isSymbolicLink(): boolean } | null,
  realPath: string | null,
  resolvedPath: string
): boolean {
  if (stat !== null && stat.isSymbolicLink()) return true
  if (realPath === null) return true
  const normalize = (path: string): string => process.platform === 'win32' ? resolve(path).toLowerCase() : resolve(path)
  return normalize(realPath) !== normalize(resolvedPath)
}

function sameFile(a: Stats, b: Stats): boolean {
  return a.dev === b.dev && a.ino === b.ino && a.isFile() && b.isFile() && !b.isSymbolicLink()
}
function unchangedFile(a: Stats, b: Stats): boolean {
  return sameFile(a, b) && a.size === b.size && a.mtimeMs === b.mtimeMs && a.ctimeMs === b.ctimeMs
}
async function copyDescriptors(source: number, destination: number): Promise<{ bytes: number; digest: string }> {
  const buffer = Buffer.allocUnsafe(64 * 1024)
  const digest = createHash('sha256')
  let total = 0
  for (;;) {
    const bytes = await new Promise<number>((resolve, reject) => read(source, buffer, 0, buffer.length, total,
      (error, count) => error ? reject(error) : resolve(count)))
    if (bytes === 0) return { bytes: total, digest: digest.digest('hex') }
    assertFileBytes(total + bytes)
    let offset = 0
    while (offset < bytes) {
      const count = await new Promise<number>((resolve, reject) => write(destination, buffer, offset, bytes - offset, total + offset,
        (error, written) => error ? reject(error) : resolve(written)))
      if (count === 0) throw new AssetsStoreError('WRITE_FAILED', '暂存文件写入未推进。')
      offset += count
    }
    digest.update(buffer.subarray(0, bytes))
    total += bytes
  }
}

/** 校验实际暂存内容；只读持有的 descriptor，不跟随可被替换的路径。 */
async function descriptorDigest(fd: number): Promise<string> {
  const digest = createHash('sha256')
  const buffer = Buffer.allocUnsafe(64 * 1024)
  let offset = 0
  for (;;) {
    const bytes = await new Promise<number>((resolve, reject) => read(fd, buffer, 0, buffer.length, offset,
      (error, count) => error ? reject(error) : resolve(count)))
    if (bytes === 0) return digest.digest('hex')
    assertFileBytes(offset + bytes)
    digest.update(buffer.subarray(0, bytes))
    offset += bytes
  }
}

// ── importFile ────────────────────────────────────────────────────────────
/** 把源文件作为新版本导入文件型资产；blob 落到托管 files/<assetId>/<blob>-<name>。 */
export async function importFile(
  ctx: AssetsContext,
  assetId: number,
  condition: unknown,
  sourcePath: string,
  changelog?: string
): Promise<AssetDetail> {
  const id = positive(assetId)
  if (typeof sourcePath !== 'string' || sourcePath.trim() === '') {
    throw new AssetsStoreError('BAD_REQUEST', 'sourcePath 必须是非空字符串。')
  }
  const c = parseCondition(condition)
  const log = typeof changelog === 'string' ? changelog : ''
  const now = new Date().toISOString()

  // 事务外异步暂存，搬入 files 后的 SQL/COMMIT/最终 scope 失败统一由外层清理。
  // R2/R4：拒绝符号链接 / junction（只导入真实普通文件）；普通文件 + 字节上限校验。
  let srcStat: Stats
  try {
    srcStat = lstatSync(sourcePath)
  } catch {
    throw new AssetsStoreError('FILE_UNAVAILABLE', '源文件不可读或不存在。')
  }
  // 符号链接 / junction 判定用跨平台纯函数 sourceIsLink：
  // ① lstat 直接报 symbolicLink；② realpath 解析到不同于入参的路径。
  // realpath 失败无法确认实体，按不可用源拒绝，不退回字面路径。
  const rawPath = resolve(sourcePath)
  let realPath: string | null = null
  let parentIdentity = rawPath
  try {
    realPath = realpathSync(sourcePath)
    parentIdentity = join(realpathSync(dirname(rawPath)), basename(rawPath))
  } catch {
    realPath = null
  }
  if (sourceIsLink(srcStat, realPath, parentIdentity)) {
    throw new AssetsStoreError('FILE_UNAVAILABLE', '源文件是符号链接或 junction，拒绝导入。')
  }
  if (!srcStat.isFile()) throw new AssetsStoreError('BAD_REQUEST', '源路径不是普通文件。')
  assertFileBytes(srcStat.size)

  // 拷贝到 staging（与 files/ 同卷，后续排他 hardlink 落盘）；文件名用唯一 blobId，绝不覆盖他人 blob。
  const fileName = basename(sourcePath)
  const stagingName = `${newBlobId()}-${safeFileName(fileName)}`
  const stagingAbs = join(ctx.layout.stagingDir, stagingName)
  let sourceFd: number | null = null
  let stagingFd: number | null = null
  let stagingIdentity: Stats | null = null
  let finalIdentity: Stats | null = null
  let finalAbs: string | null = null
  let committed = false
  try {
    ctx.assertCurrent()
    // POSIX 拒绝最终链接；Windows 没有可靠 O_NOFOLLOW，靠打开前后实体核对 fail-closed。
    sourceFd = openSync(sourcePath, constants.O_RDONLY | (process.platform === 'win32' ? 0 : constants.O_NOFOLLOW))
    if (!unchangedFile(srcStat, fstatSync(sourceFd)) || !unchangedFile(srcStat, lstatSync(sourcePath))) {
      throw new AssetsStoreError('FILE_UNAVAILABLE', '源文件在打开时发生变化。')
    }
    stagingFd = openSync(stagingAbs, 'wx+', 0o600)
    stagingIdentity = fstatSync(stagingFd)
    const copied = await copyDescriptors(sourceFd, stagingFd)
    ctx.assertCurrent()
    if (copied.bytes !== srcStat.size || !unchangedFile(srcStat, fstatSync(sourceFd)) || !unchangedFile(srcStat, lstatSync(sourcePath))) {
      throw new AssetsStoreError('FILE_UNAVAILABLE', '源文件在复制期间发生变化。')
    }
    const staged = fstatSync(stagingFd)
    if (!sameFile(stagingIdentity, lstatSync(stagingAbs)) || staged.nlink !== 1 || staged.size !== copied.bytes) {
      throw new AssetsStoreError('FILE_UNAVAILABLE', '暂存文件身份或字节数在复制期间发生变化。')
    }
    const actualDigest = await descriptorDigest(stagingFd)
    ctx.assertCurrent()
    if (actualDigest !== copied.digest || !unchangedFile(staged, fstatSync(stagingFd)) || !unchangedFile(staged, lstatSync(stagingAbs))) {
      throw new AssetsStoreError('FILE_UNAVAILABLE', '暂存内容在复制或验证期间发生变化。')
    }
    closeSync(sourceFd)
    sourceFd = null
    // 关闭后没有 await；提交内再次核验已验证的实体与修改时间。
    closeSync(stagingFd)
    stagingFd = null
    const asset = ctx.write(s => {
      const row = selectAsset(s, id)
      if (row === undefined) throw new AssetsStoreError('NOT_FOUND', '资产不存在。')
      if (row.archived_at !== null) throw new AssetsStoreError('ASSET_ARCHIVED', '请先恢复归档资产。')
      if (row.storage_type !== 'file') throw new AssetsStoreError('BAD_REQUEST', '仅文件型资产可导入文件。')
      if (row.revision !== c.expectedRevision) {
        throw new AssetsStoreError('REVISION_CONFLICT', '资产已更新。', { currentRevision: row.revision })
      }
      if (c.hasVersion && c.expectedCurrentVersionId !== row.current_version_id) {
        throw new AssetsStoreError('VERSION_CONFLICT', '当前版本已改变。', { currentVersionId: row.current_version_id })
      }

      // 事务内复核：staging 仍可读、字节数未变（防提交前被改），最终路径合法且不存在。
      let st: ReturnType<typeof statSync>
      try {
        st = lstatSync(stagingAbs)
      } catch {
        throw new AssetsStoreError('FILE_UNAVAILABLE', '暂存文件在提交前丢失。')
      }
      if (stagingIdentity === null || !unchangedFile(staged, st) || st.nlink !== 1 || st.size !== srcStat.size || !unchangedFile(srcStat, lstatSync(sourcePath))) {
        throw new AssetsStoreError('FILE_UNAVAILABLE', '暂存文件在提交前发生变化。')
      }
      const relPath = versionBlobRelPath(id, newBlobId(), fileName)
      const abs = resolveWithinFiles(ctx.layout, relPath)
      mkdirSync(dirname(abs), { recursive: true })
      // 同卷排他创建硬链接；已有目标（含外部竞态创建）始终失败，不能先预占再 rename 覆盖。
      try {
        linkSync(stagingAbs, abs)
        finalAbs = abs
        finalIdentity = stagingIdentity
        unlinkSync(stagingAbs)
      } catch {
        throw new AssetsStoreError('WRITE_FAILED', '版本 blob 落盘失败。')
      }
      finalAbs = abs
      stagingIdentity = null
      const moved = lstatSync(abs)
      if (finalIdentity === null || !sameFile(finalIdentity, moved) || moved.nlink !== 1) {
        throw new AssetsStoreError('FILE_UNAVAILABLE', '搬入的版本文件身份发生变化。')
      }

      const next = (s.get<{ n: number }>('SELECT coalesce(max(version),0) n FROM asset_version WHERE asset_id=?', id)?.n ?? 0) + 1
      s.run(
        'INSERT INTO asset_version(asset_id,version,content,changelog,source_json,file_path,file_name,created_at) VALUES (?,?,?,?,?,?,?,?)',
        id, next, '', log, row.source_json, relPath, fileName, now
      )
      const vid = s.get<{ id: number }>('SELECT last_insert_rowid() id')?.id as number
      s.run('UPDATE asset SET current_version_id=?, revision=revision+1, updated_at=? WHERE id=?', vid, now, id)
      return detail(s, selectAsset(s, id) as AssetRow, ctx.layout)
    })
    committed = true
    return asset
  } catch (error) {
    const cleanupErrors: unknown[] = []
    for (const fd of [sourceFd, stagingFd]) {
      if (fd === null) continue
      try { closeSync(fd) } catch (closeError) { cleanupErrors.push(closeError) }
    }
    sourceFd = null
    stagingFd = null
    for (const [path, identity] of [[!committed ? finalAbs : null, finalIdentity], [stagingAbs, stagingIdentity]] as const) {
      if (path === null || identity === null) continue
      try {
        const current = lstatSync(path)
        // link 成功而 staging unlink 失败时，这两个链接均由本操作持有，允许按身份清掉。
        const ownPair = finalAbs !== null && finalIdentity !== null && stagingIdentity !== null
          && current.nlink === 2 && sameFile(identity, lstatSync(finalAbs))
          && sameFile(identity, lstatSync(stagingAbs))
        if (!sameFile(identity, current) || (current.nlink !== 1 && !ownPair)) {
          throw new Error('清理目标身份已改变，保留外部替换文件。')
        }
        unlinkSync(path)
      } catch (cleanupError) {
        if ((cleanupError as NodeJS.ErrnoException).code !== 'ENOENT') cleanupErrors.push(cleanupError)
      }
    }
    if (cleanupErrors.length !== 0) {
      const failure = new AssetsStoreError('WRITE_FAILED', '导入失败且本次文件清理未完成，请查看日志并保留资产库。')
      Object.defineProperty(failure, 'cause', { value: new AggregateError([error, ...cleanupErrors], '导入与清理故障') })
      throw failure
    }
    throw error
  }
}

// ── saveFile ─────────────────────────────────────────────────────────────
/**
 * 把某版本（文件 blob 或正文）落盘到目标路径。versionId 缺省取当前版本。
 *
 * 纪律（R1）：
 * - 事务内**只**校验 + 取源（文件 blob 绝对路径 / 正文），**不**在事务内写盘，
 *   避免「DB 回滚但目标文件已落盘」的孤儿（目标在用户空间，不应因资产事务失败被留下）。
 * - 写盘在事务提交后做，并以**原子独占创建**（`wx` / `COPYFILE_EXCL`）拒绝覆盖既有目标：
 *   不先 exists 再写（消除 TOCTOU 竞态），目标已存在直接抛 `FILE_EXISTS`，原文件字节不变。
 */
export function saveFile(
  ctx: AssetsContext,
  assetId: number,
  versionId: number | undefined,
  destinationPath: string
): { saved: true } {
  const id = positive(assetId)
  if (typeof destinationPath !== 'string' || destinationPath.trim() === '') {
    throw new AssetsStoreError('BAD_REQUEST', 'destinationPath 必须是非空字符串。')
  }
  const dest = resolve(destinationPath)

  const source = ctx.write(s => {
    const row = selectAsset(s, id)
    if (row === undefined) throw new AssetsStoreError('NOT_FOUND', '资产不存在。')
    const vid = versionId == null ? row.current_version_id : positive(versionId, 'versionId')
    if (vid === null) throw new AssetsStoreError('NOT_FOUND', '该资产尚无版本。')
    const v = selectVersion(s, id, vid)
    if (v === undefined) throw new AssetsStoreError('NOT_FOUND', '版本不存在。')
    if (v.file_path !== null) {
      const abs = resolveWithinFiles(ctx.layout, v.file_path)
      if (!existsSync(abs)) throw new AssetsStoreError('FILE_UNAVAILABLE', '版本文件已不存在。')
      return { kind: 'file' as const, abs }
    }
    return { kind: 'text' as const, content: v.content }
  })

  mkdirSync(dirname(dest), { recursive: true })
  try {
    if (source.kind === 'file') {
      copyFileSync(source.abs, dest, constants.COPYFILE_EXCL)
    } else {
      writeFileSync(dest, source.content, { flag: 'wx' })
    }
  } catch (error) {
    if (error instanceof AssetsStoreError) throw error
    const errno = (error as NodeJS.ErrnoException | undefined)?.code
    if (errno === 'EEXIST') {
      throw new AssetsStoreError('FILE_EXISTS', '目标文件已存在，拒绝覆盖；请选择其它路径或先删除目标文件。')
    }
    throw error
  }
  return { saved: true }
}

// ── listVersions ──────────────────────────────────────────────────────────
export function listVersions(ctx: AssetsContext, assetId: number, page?: unknown, pageSize?: unknown): VersionPage {
  const id = positive(assetId)
  const { page: p, pageSize: ps } = parsePaging(page, pageSize)
  return ctx.write(s => {
    const row = selectAsset(s, id)
    if (row === undefined) throw new AssetsStoreError('NOT_FOUND', '资产不存在。')
    const total = countVersions(s, id)
    const rows = listVersionRows(s, id, p, ps)
    return { items: rows.map(versionSummary), total, page: p, pageSize: ps }
  })
}

// ── getVersion ────────────────────────────────────────────────────────────
export function getVersion(ctx: AssetsContext, assetId: number, versionId: number): { version: AssetVersion } {
  const id = positive(assetId)
  const vid = positive(versionId, 'versionId')
  return ctx.write(s => {
    const row = selectAsset(s, id)
    if (row === undefined) throw new AssetsStoreError('NOT_FOUND', '资产不存在。')
    const v = selectVersion(s, id, vid)
    if (v === undefined) throw new AssetsStoreError('NOT_FOUND', '版本不存在。')
    return { version: toAssetVersion(v) }
  })
}

// ── diffVersions ──────────────────────────────────────────────────────────
export function diffVersions(
  ctx: AssetsContext,
  assetId: number,
  fromVersionId: number,
  toVersionId: number
): { diff: VersionDiff } {
  const id = positive(assetId)
  const f = positive(fromVersionId, 'fromVersionId')
  const t = positive(toVersionId, 'toVersionId')
  return ctx.write(s => {
    const row = selectAsset(s, id)
    if (row === undefined) throw new AssetsStoreError('NOT_FOUND', '资产不存在。')
    const a = selectVersion(s, id, f)
    if (a === undefined) throw new AssetsStoreError('NOT_FOUND', '源版本不存在。')
    const b = selectVersion(s, id, t)
    if (b === undefined) throw new AssetsStoreError('NOT_FOUND', '目标版本不存在。')
    // 任一侧是文件版本 → 无逐行 diff（二进制无法文本比对）。
    if (a.file_path !== null || b.file_path !== null) {
      return { diff: { kind: 'file', fromVersion: a.version, toVersion: b.version, lines: [], files: {
        from: versionFileMetadata(ctx.layout, a), to: versionFileMetadata(ctx.layout, b)
      } } }
    }
    return {
      diff: {
        kind: 'text',
        fromVersion: a.version,
        toVersion: b.version,
        ...compareVersionText(a.content, b.content)
      }
    }
  })
}

/** 比较文件版本只读取元信息；缺失或越界保留显示名并明确不可用。 */
function versionFileMetadata(layout: AssetsLayout, version: VersionRow): VersionFileMetadata {
  try {
    assertReadableBlob(layout, version.file_path)
    const fileBytes = statSync(resolveWithinFiles(layout, version.file_path!)).size
    return { fileName: version.file_name, fileBytes, available: true }
  } catch {
    return { fileName: version.file_name, fileBytes: null, available: false }
  }
}

// ── rollbackVersion ───────────────────────────────────────────────────────
/**
 * 校验某版本关联的 blob 仍是「托管目录内、普通文件、可读」。供 rollbackVersion 文件分支在
 * 复用不可变 blob 之前调用（R3）：校验失败抛错，事务回滚，不产生任何版本 / revision / 指针变化，
 * 旧版本行与旧 blob 哈希均保持原样。
 */
function assertReadableBlob(layout: AssetsLayout, relPath: string | null): void {
  if (relPath === null) throw new AssetsStoreError('FILE_UNAVAILABLE', '该版本没有关联的文件。')
  let abs: string
  try {
    abs = resolveWithinFiles(layout, relPath)
  } catch {
    throw new AssetsStoreError('PATH_REJECTED', '版本文件不在托管目录内。')
  }
  let lst: ReturnType<typeof lstatSync>
  try {
    lst = lstatSync(abs)
  } catch {
    throw new AssetsStoreError('FILE_UNAVAILABLE', '版本文件已不存在。')
  }
  if (lst.isSymbolicLink()) throw new AssetsStoreError('PATH_REJECTED', '版本文件是符号链接，拒绝复用。')
  if (!lst.isFile()) throw new AssetsStoreError('FILE_UNAVAILABLE', '版本文件不是普通文件。')
  try {
    const fd = openSync(abs, 'r')
    closeSync(fd)
  } catch {
    throw new AssetsStoreError('FILE_UNAVAILABLE', '版本文件不可读。')
  }
}

/** 以旧版本为蓝本生成新版本：正文型直接复用内容，文件型复用不可变 blob。 */
export function rollbackVersion(
  ctx: AssetsContext,
  assetId: number,
  condition: unknown,
  versionId: number
): { asset: AssetDetail; createdVersion: AssetVersion } {
  const id = positive(assetId)
  const vid = positive(versionId, 'versionId')
  const c = parseCondition(condition)
  const now = new Date().toISOString()

  return ctx.write(s => {
    const row = selectAsset(s, id)
    if (row === undefined) throw new AssetsStoreError('NOT_FOUND', '资产不存在。')
    if (row.archived_at !== null) throw new AssetsStoreError('ASSET_ARCHIVED', '请先恢复归档资产。')
    if (row.revision !== c.expectedRevision) {
      throw new AssetsStoreError('REVISION_CONFLICT', '资产已更新。', { currentRevision: row.revision })
    }
    if (c.hasVersion && c.expectedCurrentVersionId !== row.current_version_id) {
      throw new AssetsStoreError('VERSION_CONFLICT', '当前版本已改变。', { currentVersionId: row.current_version_id })
    }
    const target = selectVersion(s, id, vid)
    if (target === undefined) throw new AssetsStoreError('NOT_FOUND', '目标版本不存在。')

    if (target.file_path !== null) {
      // R3：复用不可变 blob 前，先校验该 blob 仍是「托管目录内、普通文件、可读」。
      // 校验失败（缺失 / 符号链接 / 不可读 / 越界）直接抛错 → 事务回滚，版本号 / revision /
      // 指针 / 时间戳全部不变，旧版本行与旧 blob 哈希均保持原样。
      assertReadableBlob(ctx.layout, target.file_path)
      // 复用不可变 blob：新建一条版本记录指向同一 blob，version 号递增。
      const next = (s.get<{ n: number }>('SELECT coalesce(max(version),0) n FROM asset_version WHERE asset_id=?', id)?.n ?? 0) + 1
      s.run(
        'INSERT INTO asset_version(asset_id,version,content,changelog,source_json,file_path,file_name,created_at) VALUES (?,?,?,?,?,?,?,?)',
        id, next, '', `回滚至 v${target.version}`, target.source_json, target.file_path, target.file_name, now
      )
      const newId = s.get<{ id: number }>('SELECT last_insert_rowid() id')?.id as number
      s.run('UPDATE asset SET current_version_id=?, revision=revision+1, updated_at=? WHERE id=?', newId, now, id)
      const fresh = selectAsset(s, id) as AssetRow
      return { asset: detail(s, fresh, ctx.layout), createdVersion: toAssetVersion(selectVersion(s, id, newId) as VersionRow) }
    }

    // 正文型：把旧版本内容作为新版本追加（内容不变，changelog 标注回滚），并递增 revision。
    void appendVersion(s, row, target.content, `回滚至 v${target.version}`, now, null, target.source_json)
    s.run('UPDATE asset SET revision=revision+1, updated_at=? WHERE id=?', now, id)
    const fresh = selectAsset(s, id) as AssetRow
    const newVersionId = fresh.current_version_id as number
    return { asset: detail(s, fresh, ctx.layout), createdVersion: toAssetVersion(selectVersion(s, id, newVersionId) as VersionRow) }
  })
}
