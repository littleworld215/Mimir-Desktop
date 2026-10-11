/**
 * 归档内旧空间根的**推导**（I6 批次 3 · 第 5 块 · T05）。
 *
 * 职责：`runRestore` 的 `RestoreInput.oldRoot` 是 T03 重映射的**匹配基准**——
 * 「以旧空间根为前缀的绝对路径」才会被改写。但归档里**没有**记录旧空间根：
 * 清单条目是 `toPosixRelative(root, absolute)` 的相对路径（`manifest.ts:226`），
 * 刻意不嵌绝对路径；空间层 `store.json` 里也只有 `pdfPath` 这类**字段值**含旧根。
 *
 * 于是需要从归档本身**推导**旧根。唯一自洽的口径是**最大公共目录前缀**：
 * 一份空间备份的每个文件必然位于「空间根/…」之下，取所有文件条目路径的公共
 * 目录前缀即得空间根的**相对形态**。
 *
 * 关键性质（本文件的存在理由）：
 * - 推导值是**相对路径**（不是绝对路径）。设计 §3.4 R1 的匹配语义是
 *   「`pdfPath` 以**旧空间根为前缀**」——只要两边用同一口径（都取相对形态），
 *   `matchRootPrefix` 就能命中。因此这里**不**、也**不能**臆造一个绝对盘符。
 * - 匹配**宁可不中**：推不出（空清单、单根层文件、路径形态异常）时返回 `null`，
 *   由调用方把 `oldRoot` 退化为空串——此时 T03 一条都不改写（`skipped: not-absolute`），
 *   空间仍能完整恢复，只是 `pdfPath` 保持旧值。**绝不猜测**：猜错会把
 *   用户空间外的 PDF 路径改到新空间里（K2/§7 高危误写）。
 *
 * 纪律：
 * - 推导逻辑（`oldRootFromArchive` / `canDeriveOldRoot`）**零 IO**：输入是已读出的清单条目
 *   数组，不打开归档、不 stat。归档读取由 `readArchiveManifestEntries` 负责，
 *   它是本文件**唯一**触碰 IO 的函数（沿用 `extract.ts` 的 yauzl 手法，不引新依赖）。
 * - 不 import 任何 `electron` 模块；`fs` 也只用在 `readArchiveManifestEntries` 一处。
 */

import yauzl from 'yauzl'

import { RestoreError } from './restoreContracts'
import { MANIFEST_IN_ARCHIVE, type ArchiveManifest } from './packer'
import type { ManifestEntry } from './manifest'

/** 清单里「相对根」本身的形态：空串或 `.`。 */
const ROOT_SENTINELS = new Set(['', '.'])

/** 归一化：统一正斜杠、去尾部斜杠。返回 `null` 表示该值形态可疑，不应参与推导。 */
function normalizeEntryPath(value: string): string | null {
  if (typeof value !== 'string') return null
  const normalized = value.split('\\').join('/').replace(/\/+$/, '')
  if (ROOT_SENTINELS.has(normalized)) return null
  // 绝对路径 / 盘符 / UNC / 前导斜杠：清单里本就**不该**出现（相对路径口径）；
  // 出现即说明归档形态异常，此时**放弃推导**（返回 null），绝不用它算公共前缀。
  if (/^[a-zA-Z]:/.test(normalized)) return null
  if (normalized.startsWith('/')) return null
  // 逐段检查：`..` 会逃出根，`//` 是空段，都不接受。
  const segments = normalized.split('/')
  if (segments.some((segment) => segment === '' || segment === '..')) return null
  return segments.join('/')
}

/** 取两条路径的公共**目录**前缀（段级比较；不含任何一条文件名本身）。 */
function commonDirectoryPrefix(a: readonly string[], b: readonly string[]): string[] {
  const limit = Math.min(a.length, b.length)
  let index = 0
  while (index < limit && a[index] === b[index]) index += 1
  return a.slice(0, index)
}

/**
 * 从清单条目推导归档内记录的**旧空间根（相对形态）**。
 *
 * ⚠️ **只看文件条目，忽略目录条目。** 这条规则是被真实归档形态逼出来的，不是偏好：
 * 一份源为 `<src>/papers/a.pdf` 的归档，清单是
 * `papers [directory]` + `papers/a.pdf [file]`。
 * - 文件条目给出父前缀 `[papers]`；
 * - 目录条目若也参与，给出 `[]`（它的最后一段就是它自己，不能当作文件名剥掉）；
 * - 两者求交 → `[]` → **推不出根**。
 * 但正确答案显然是 `papers`。根因：**目录条目的最后一段不是文件名**，
 * 而文件条目的最后一段**是**文件名——两者不能套用同一条「剥最后一段」规则。
 * 因此只保留文件条目（每个文件必然位于某个目录内，信息量足够）；
 * 若归档只有目录条目（真实打包不会发生），则推不出根，返回 `null`。
 *
 * @param entries 归档内清单条目（`ArchiveManifest.entries`）
 * @returns 归一化后的相对根；**推不出时返回 `null`**（调用方须退化为「不改写」）
 */
export function oldRootFromArchive(entries: readonly ManifestEntry[]): string | null {
  let prefix: string[] | null = null

  for (const entry of entries) {
    // 目录条目不参与：其「最后一段」是目录名而非文件名（见上方注释）。
    if (entry?.kind === 'directory') continue
    const normalized = normalizeEntryPath(entry?.path ?? '')
    if (normalized === null) continue
    const segments = normalized.split('/')

    // 文件条目的最后一段必是文件名 → 剥掉，只留目录部分。
    const directory = segments.slice(0, -1)
    prefix = prefix === null ? directory : commonDirectoryPrefix(prefix, directory)

    // ⚠️ 不在此处提前 return：公共目录前缀一旦被某条路径清空，就**永远**是空，
    // 后续条目不可能把它拼回来。语义统一在循环结束后判定，只维护一条规则。
  }

  // 空公共前缀 = **推不出根**（如 `papers/a.pdf` 与 `.mimir/store.json` 的公共目录前缀为空）。
  // 返回 `null` 让调用方退化为「不改写」，**绝不**返回 `''`——空串进入
  // `matchRootPrefix` 会被判为非法根（`remapRules` 拒绝空归一化根），
  // 且空串会让调用方误以为「有根」。
  if (prefix === null || prefix.length === 0) return null
  return prefix.join('/')
}

/**
 * 归档内清单是否**含可推导的根**——与 `oldRootFromArchive` 同口径的布尔封装。
 *
 * 存在理由：`restoreMain` 需要在**选归档阶段**就告诉用户「这份归档回来后
 * `pdfPath` 能不能自动改到新空间」，而不是等恢复到一半才发现无法匹配。
 */
export function canDeriveOldRoot(entries: readonly ManifestEntry[]): boolean {
  return oldRootFromArchive(entries) !== null
}

/** 打开归档（与 `extract.ts` 同口径：lazyEntries + autoClose）。 */
function openArchive(path: string): Promise<yauzl.ZipFile> {
  return new Promise((resolveOpen, reject) => {
    yauzl.open(path, { lazyEntries: true, autoClose: true, decodeStrings: true }, (error, zipfile) => {
      if (error || !zipfile) {
        reject(new RestoreError('RECHECK_FAILED', `无法打开归档：${error?.message ?? '未知错误'}`))
      } else {
        resolveOpen(zipfile)
      }
    })
  })
}

/** 判断某条目是否就是归档内清单（尾斜杠归一后比较）。 */
function isManifestEntry(fileName: string): boolean {
  return fileName.split('\\').join('/').replace(/\/+$/, '') === MANIFEST_IN_ARCHIVE
}

/** 读出单个条目的全部字节（清单是 KB 级纯 JSON，可整块读）。 */
function readEntryBytes(zipfile: yauzl.ZipFile, entry: yauzl.Entry): Promise<Buffer> {
  return new Promise((resolveRead, reject) => {
    zipfile.openReadStream(entry, (error, stream) => {
      if (error || !stream) {
        reject(new RestoreError('RECHECK_FAILED', `无法读取归档清单条目：${entry.fileName}`))
        return
      }
      const chunks: Buffer[] = []
      let total = 0
      stream.on('data', (chunk: Buffer) => { chunks.push(chunk); total += chunk.length })
      stream.on('error', (streamError: Error) =>
        reject(new RestoreError('RECHECK_FAILED', `归档清单读取失败：${streamError.message}`)))
      stream.on('end', () => resolveRead(Buffer.concat(chunks, total)))
    })
  })
}

/**
 * 从归档读出清单条目（**只读**，流式扫描中央目录，不整文件读入内存）。
 *
 * 与 `restoreMain` 的分工：本函数只负责「把清单读成结构化数组」，
 * 不认识「旧根」「注册表」等上层概念；上层拿到结果再交给 `oldRootFromArchive`。
 *
 * @throws RestoreError `RECHECK_FAILED` 当清单缺失 / 不可解析 / 归档无法打开
 */
export async function readArchiveManifestEntries(archivePath: string): Promise<ManifestEntry[]> {
  const zipfile = await openArchive(archivePath)
  try {
    const buffer = await new Promise<Buffer | null>((resolveFound, rejectFound) => {
      zipfile.on('entry', (entry: yauzl.Entry) => {
        void (async () => {
          try {
            if (isManifestEntry(entry.fileName)) {
              const bytes = await readEntryBytes(zipfile, entry)
              zipfile.close()
              resolveFound(bytes)
              return
            }
            zipfile.readEntry()
          } catch (error) {
            zipfile.close()
            rejectFound(error)
          }
        })()
      })
      zipfile.on('end', () => resolveFound(null))
      zipfile.on('error', (error: Error) =>
        rejectFound(new RestoreError('RECHECK_FAILED', `归档读取失败：${error.message}`)))
      zipfile.readEntry()
    })

    if (buffer === null) {
      throw new RestoreError('RECHECK_FAILED', `归档缺少清单 ${MANIFEST_IN_ARCHIVE}：${archivePath}`)
    }

    let manifest: ArchiveManifest
    try {
      manifest = JSON.parse(buffer.toString('utf8')) as ArchiveManifest
    } catch (error) {
      throw new RestoreError(
        'RECHECK_FAILED',
        `归档清单不是合法 JSON：${archivePath}（${(error as Error).message}）`
      )
    }
    if (!Array.isArray(manifest.entries)) {
      throw new RestoreError('RECHECK_FAILED', `归档清单 entries 不是数组：${archivePath}`)
    }
    return manifest.entries
  } catch (error) {
    throw error instanceof RestoreError
      ? error
      : new RestoreError('RECHECK_FAILED', `读取归档清单失败：${archivePath}（${(error as Error).message}）`)
  }
}
