/**
 * 空间备份清单（I6 批次 2 · 第 1 块）。
 *
 * 职责：把**科研空间根目录**遍历成一份稳定的条目清单（相对路径 + 类型 + 字节数 + SHA256），
 * 作为「流式打包」的输入与「独立验包」的比对基准。清单本身不写盘、不压缩。
 *
 * 纪律（对应 INTEGRATION-PLAN-I6「固定边界」）：
 * - **逐文件 SHA256**：打包与验包各算一次，任一不一致即失败。
 * - **上限硬约束**：条目数、清单总字节、展开总字节各有上限，超限抛错而非截断，
 *   避免「备份悄悄少东西」。
 * - **不跟随符号链接**：链接/联接一律拒绝（`UNEXPECTED_LINK`），
 *   与归档路径校验（`archivePaths.ts`）同一套 Windows 语义。
 * - **路径全部用正斜杠**：跨平台解释一致，验包时不因分隔符差异误判。
 * - **排除暂存目录**：`.mimir/assets/staging/` 是过程产物，不属于稳定内容。
 */

import { createHash } from 'node:crypto'
import { createReadStream, lstatSync, readdirSync, type Stats } from 'node:fs'
import { join, relative } from 'node:path'
import { validateArchivePaths, type ArchivePath } from './archivePaths'

/** 备份清单里的一条条目。 */
export interface ManifestEntry {
  /** 相对空间根的正斜杠路径，例如 `.mimir/assets/assets.db`。 */
  path: string
  kind: 'file' | 'directory'
  /** 文件字节数；目录为 0。 */
  size: number
  /** 文件内容 SHA256（小写十六进制）；目录为空串。 */
  sha256: string
}

export interface ManifestLimits {
  maxEntries: number
  maxManifestBytes: number
  maxTotalBytes: number
}

/**
 * 条目覆盖：用于「打包内容与磁盘内容不一致」的受控替换。
 *
 * 目前唯一用途是 SQLite 一致快照——`assets.db` 在归档里写的是 `backup()` 产出的快照，
 * 而磁盘上的实时库可能与快照字节不同（页空洞、页头变更计数、未检查点内容）。
 * 若清单仍按实时库计算摘要，验包时会得到**假阳性** `DIGEST_MISMATCH`。
 *
 * - `replacementAbsPath`：该条目在归档里实际写入的源文件（快照文件）。
 * - `omit`：该条目只存在于归档、不在磁盘上（如 WAL 已检查点并入主库），清单据此剔除。
 */
export interface ManifestOverrides {
  /** 相对空间根的正斜杠路径 → 替代源（归档内实际内容的判据）。 */
  replacement?: Map<string, { replacementAbsPath: string; size: number }>
  /** 需要从清单剔除的相对路径（磁盘上不该再单独打包的旁路文件）。 */
  omit?: Set<string>
}

/** 与 INTEGRATION-PLAN-I6 固定边界一致：10 万条目 / 64MiB 清单 / 1TiB 展开。 */
export const DEFAULT_MANIFEST_LIMITS: ManifestLimits = {
  maxEntries: 100_000,
  maxManifestBytes: 64 * 1024 * 1024,
  maxTotalBytes: 1024 ** 4
}

/** 备份中的过程产物目录（相对空间根、正斜杠、**带尾斜杠**）——不纳入清单。 */
const EXCLUDED_PREFIXES = ['.mimir/assets/staging/']

/** 应当排除的绝对路径集合由空间根推导；此处只做相对路径判断。 */
function isExcluded(relPath: string): boolean {
  const withSlash = `${relPath}/`
  return EXCLUDED_PREFIXES.some(prefix => withSlash.startsWith(prefix))
}

class ManifestError extends Error {
  constructor(readonly code: string, message: string) { super(message) }
}

/** 逐文件流式计算 SHA256；大文件不整块进内存。 */
async function hashFile(path: string): Promise<string> {
  const hash = createHash('sha256')
  await new Promise<void>((resolve, reject) => {
    const stream = createReadStream(path)
    stream.on('data', chunk => hash.update(chunk))
    stream.on('error', reject)
    stream.on('end', () => resolve())
  })
  return hash.digest('hex')
}

/** 递归遍历：返回相对路径 → 条目的映射（未排序）；不跟随链接。 */
async function walk(
  root: string,
  limits: ManifestLimits,
  overrides?: ManifestOverrides
): Promise<{ entries: ManifestEntry[]; totalBytes: number }> {
  const entries: ManifestEntry[] = []
  let totalBytes = 0

  const visit = async (absolute: string, relPrefix: string): Promise<void> => {
    let stat: Stats
    try { stat = lstatSync(absolute) } catch (error) {
      throw new ManifestError('READ_FAILED', `无法读取路径：${relPrefix}（${(error as Error).message}）`)
    }
    // 链接/联接：不跟随也不打包，明确拒绝，避免打包到空间之外的内容。
    if (stat.isSymbolicLink()) throw new ManifestError('UNEXPECTED_LINK', `备份不跟随符号链接或联接：${relPrefix}`)

    const posixRel = relPrefix
    if (posixRel !== '' && isExcluded(posixRel)) return
    if (posixRel !== '' && overrides?.omit?.has(posixRel)) return

    if (stat.isDirectory()) {
      if (posixRel !== '') entries.push({ path: posixRel, kind: 'directory', size: 0, sha256: '' })
      if (entries.length > limits.maxEntries) throw new ManifestError('ENTRY_LIMIT', `条目数超过上限 ${limits.maxEntries}`)
      let children: string[]
      try { children = readdirSync(absolute) } catch (error) {
        throw new ManifestError('READ_FAILED', `无法列出目录：${relPrefix || '.'}（${(error as Error).message}）`)
      }
      // 排序保证清单稳定（同一空间多次生成结果可复现，便于比对）。
      for (const name of children.sort()) {
        await visit(join(absolute, name), posixRel === '' ? name : `${posixRel}/${name}`)
      }
      return
    }

    if (!stat.isFile()) throw new ManifestError('UNSUPPORTED_KIND', `备份不支持的文件类型：${relPrefix}`)

    // 受控替换：归档里写的是替代源时，清单必须按替代源计算，否则验包必然假失败。
    const replacement = overrides?.replacement?.get(posixRel)
    const contentPath = replacement ? replacement.replacementAbsPath : absolute
    const contentSize = replacement ? replacement.size : stat.size

    totalBytes += contentSize
    if (totalBytes > limits.maxTotalBytes) throw new ManifestError('TOTAL_LIMIT', `展开总字节超过上限 ${limits.maxTotalBytes}`)
    const sha256 = await hashFile(contentPath)
    entries.push({ path: posixRel, kind: 'file', size: contentSize, sha256 })
    if (entries.length > limits.maxEntries) throw new ManifestError('ENTRY_LIMIT', `条目数超过上限 ${limits.maxEntries}`)
  }

  await visit(root, '')
  return { entries, totalBytes }
}

/**
 * 生成空间清单。
 *
 * @param root 空间根目录（绝对路径，来自可信空间记录）
 * @param limits 上限覆盖（默认见 `DEFAULT_MANIFEST_LIMITS`）
 * @param overrides 条目覆盖（见 `ManifestOverrides`；SQLite 快照路径传此项）
 * @returns 排序后的条目数组与汇总（条目数、展开总字节、清单序列化字节）
 */
export async function buildManifest(
  root: string,
  limits: ManifestLimits = DEFAULT_MANIFEST_LIMITS,
  overrides?: ManifestOverrides
): Promise<{ entries: ManifestEntry[]; totalBytes: number; manifestBytes: number }> {
  const { entries, totalBytes } = await walk(root, limits, overrides)
  // 复用归档路径校验：Windows 保留名、大小写冲突、文件/目录冲突一律拒绝。
  validateArchivePaths(entries as ArchivePath[], limits.maxEntries)
  const manifestBytes = Buffer.byteLength(JSON.stringify(entries), 'utf8')
  if (manifestBytes > limits.maxManifestBytes) {
    throw new ManifestError('MANIFEST_LIMIT', `清单序列化字节超过上限 ${limits.maxManifestBytes}`)
  }
  // 路径已按 `readdirSync().sort()` 与深度优先顺序生成；此处再按路径排序，保证确定性。
  entries.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
  return { entries, totalBytes, manifestBytes }
}

/** 便于调用方区分上限类错误（可提示用户）与 IO 类错误（需排查磁盘）。 */
export function isManifestLimitError(error: unknown): boolean {
  return error instanceof ManifestError
    && ['ENTRY_LIMIT', 'MANIFEST_LIMIT', 'TOTAL_LIMIT'].includes(error.code)
}

export { ManifestError }
/** 供测试/上层复用的相对路径计算（保持正斜杠）。 */
export const toPosixRelative = (root: string, absolute: string): string =>
  relative(root, absolute).split('\\').join('/')
