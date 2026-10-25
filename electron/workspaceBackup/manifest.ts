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
 * - **精确排除资产库旁文件**：仅 `.mimir/assets/assets.db` 的 WAL/SHM/journal 不进清单；
 *   其它文件和目录不能只因同名后缀而被排除，未知资料仍须保存。
 */

import { createHash } from 'node:crypto'
import { pipeline } from 'node:stream/promises'
import { maintenanceCheckpoint, maintenanceSignal } from './maintenanceTask'
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
  /**
   * **单文件**字节上限。超限文件不纳入清单（不 throw），改为记入 `excluded` 供上层报告，
   * 默认排除、备份继续。见 `DEFAULT_MAX_FILE_BYTES` 的取值依据。
   */
  maxFileBytes: number
}

/**
 * 单文件上限取值依据（1 GiB）：
 *
 * - **与 `maxTotalBytes`（1 TiB）区别**：后者约束空间总量，超限必须失败（否则备份不可控）；
 *   本项约束**单个**文件，超限只需**排除它**——用一个 50GB 文件让整个备份永久失败，
 *   是把可用性问题当成正确性问题处理。
 * - **取 1 GiB 的理由**：① 绝大多数科研资料（论文 PDF、数据集、代码包）远小于此；
 *   ② 备份默认保留 20 份，单文件 1 GiB 意味着最坏情况 20 GiB 增量，仍在可接受量级；
 *   ③ 流式 SHA256 + ZIP64 对 1 GiB 文件耗时可接受（秒级），不产生明显的启停停顿。
 * - **为什么不是 64 MiB**（与 `maxManifestBytes` 同量级）：那会把正常的单篇文献
 *   或中等数据集误判为超限，排除率过高，反而让备份不可用。
 * - 需要时调用方可用 `limits` 覆盖；上限一旦收紧，历史归档仍可正常验包（本项不影响格式）。
 */
export const DEFAULT_MAX_FILE_BYTES = 1024 * 1024 * 1024

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

/**
 * 未纳入备份的条目（供上层向用户「明确报告」，对应 INTEGRATION-PLAN-I6
 * 「未包含依赖明确报告」）。
 *
 * 注意：**符号链接/联接不在本清单内**——它们是 fail-closed 的**安全**拒绝（直接失败），
 * 不是「用户可选是否纳入」的可用性问题。只有超限单文件会出现在这里。
 */
export interface ExcludedEntry {
  /** 相对空间根的正斜杠路径。 */
  path: string
  reason: 'oversize'
  /** 磁盘上的真实字节数（可能大于 `maxFileBytes`）。 */
  size: number
  /** 建议处置；当前恒为排除，保留字段以便未来扩展。 */
  defaultDisposition: 'exclude'
}

/** 与 INTEGRATION-PLAN-I6 固定边界一致：10 万条目 / 64MiB 清单 / 1TiB 展开 / 单文件 1GiB。 */
export const DEFAULT_MANIFEST_LIMITS: ManifestLimits = {
  maxEntries: 100_000,
  maxManifestBytes: 64 * 1024 * 1024,
  maxTotalBytes: 1024 ** 4,
  maxFileBytes: DEFAULT_MAX_FILE_BYTES
}

/** 备份中的过程产物目录（相对空间根、正斜杠、**带尾斜杠**）——不纳入清单。 */
const EXCLUDED_PREFIXES = ['.mimir/assets/staging/']

/**
 * 已由一致快照替换的资产库，其三个临时旁文件不进清单。
 *
 * 恢复不能把快照主库与原库实时WAL混用。但后缀本身不能证明文件属于SQLite：
 * 用户的实验记录、项目目录、其它模块文件均原样保留，不按名称猜测其用途。
 */
const ASSETS_SIDECAR_PATHS = new Set(['-wal', '-shm', '-journal'].map(suffix => `.mimir/assets/assets.db${suffix}`))

// 只排除受管控制路径；用户目录的同名资料和锁备份仍属稳定内容。
const RUNTIME_LOCK_PATHS = new Set(['.mimir/workspace.writer-lock', '.mimir/assets/assets.db.writer-lock'])

/**
 * 应当排除的绝对路径集合由空间根推导；此处只做相对路径判断。
 *
 * 精确控制文件与过程产物目录分开判断：
 * 1. **前缀**：`EXCLUDED_PREFIXES`（过程产物**目录**，需以 `/` 补齐后比前缀）。
 * 2. **精确路径**：受管写锁与资产库旁文件（大小写不敏感），其它同名资料保留。
 */
export function isExcludedFromBackup(relPath: string): boolean {
  const withSlash = `${relPath}/`
  if (EXCLUDED_PREFIXES.some(prefix => withSlash.startsWith(prefix))) return true
  // 大小写不敏感：Windows 上 `ASSETS.DB-WAL` 也可能出现（NTFS 默认不区分大小写）。
  const lower = relPath.toLowerCase()
  if (RUNTIME_LOCK_PATHS.has(lower)) return true
  return ASSETS_SIDECAR_PATHS.has(lower)
}

class ManifestError extends Error {
  constructor(readonly code: string, message: string) { super(message) }
}

/** 逐文件流式计算 SHA256；大文件不整块进内存。 */
async function hashFile(path: string): Promise<string> {
  const hash = createHash('sha256')
  await pipeline(createReadStream(path), async function* (source) {
    for await (const chunk of source) hash.update(chunk as Buffer)
  }, { signal: maintenanceSignal() })
  return hash.digest('hex')
}

/** Windows快照匹配忽略大小写，归档仍保留原路径；其它平台保持精确匹配。 */
export const manifestPathKey = (path: string): string => process.platform === 'win32' ? path.toLowerCase() : path

/** 递归遍历：返回相对路径 → 条目的映射（未排序）；不跟随链接。 */
async function walk(
  root: string,
  limits: ManifestLimits,
  overrides?: ManifestOverrides
): Promise<{ entries: ManifestEntry[]; totalBytes: number; excluded: ExcludedEntry[] }> {
  const entries: ManifestEntry[] = []
  const excluded: ExcludedEntry[] = []
  const replacements = new Map(Array.from(overrides?.replacement ?? [], ([path, value]) => [manifestPathKey(path), value]))
  let totalBytes = 0

  const visit = async (absolute: string, relPrefix: string): Promise<void> => {
    await maintenanceCheckpoint()
    let stat: Stats
    try { stat = lstatSync(absolute) } catch (error) {
      throw new ManifestError('READ_FAILED', `无法读取路径：${relPrefix}（${(error as Error).message}）`)
    }
    // 链接/联接：不跟随也不打包，明确拒绝，避免打包到空间之外的内容。
    // 注意这是 **fail-closed 的安全拒绝**（不是「可选项」）：备份整体失败，绝不静默穿透。
    // Node 在 Windows 上把 junction 也报为 isSymbolicLink()，故联接同样在此拦下。
    if (stat.isSymbolicLink()) throw new ManifestError('UNEXPECTED_LINK', `备份不跟随符号链接或联接：${relPrefix}`)

    const posixRel = relPrefix
    if (posixRel !== '' && isExcludedFromBackup(posixRel)) return
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
    const replacement = replacements.get(manifestPathKey(posixRel))
    const contentPath = replacement ? replacement.replacementAbsPath : absolute
    const contentSize = replacement ? replacement.size : stat.size

    // 单文件超限：**排除该文件**并继续备份，而不是让整个备份永久失败。
    // 与 TOTAL_LIMIT 的区别：总量超限不可控（必须失败），单文件超限只需排除（可用性问题）。
    // 被排除项不进 entries → 不进 zip → verify 的条目集合一一对应天然成立，不产生 EXTRA/MISSING。
    if (contentSize > limits.maxFileBytes) {
      excluded.push({ path: posixRel, reason: 'oversize', size: contentSize, defaultDisposition: 'exclude' })
      return
    }

    totalBytes += contentSize
    if (totalBytes > limits.maxTotalBytes) throw new ManifestError('TOTAL_LIMIT', `展开总字节超过上限 ${limits.maxTotalBytes}`)
    const sha256 = await hashFile(contentPath)
    entries.push({ path: posixRel, kind: 'file', size: contentSize, sha256 })
    if (entries.length > limits.maxEntries) throw new ManifestError('ENTRY_LIMIT', `条目数超过上限 ${limits.maxEntries}`)
  }

  await visit(root, '')
  return { entries, totalBytes, excluded }
}

/**
 * 生成空间清单。
 *
 * @param root 空间根目录（绝对路径，来自可信空间记录）
 * @param limits 上限覆盖（默认见 `DEFAULT_MANIFEST_LIMITS`）
 * @param overrides 条目覆盖（见 `ManifestOverrides`；SQLite 快照路径传此项）
 * @returns 排序后的条目数组、汇总（条目数/展开总字节/清单序列化字节），以及
 *          **未纳入项** `excluded`（超限单文件；供上层「明确报告」，不静默丢弃）
 */
export async function buildManifest(
  root: string,
  limits: ManifestLimits = DEFAULT_MANIFEST_LIMITS,
  overrides?: ManifestOverrides
): Promise<{ entries: ManifestEntry[]; totalBytes: number; manifestBytes: number; excluded: ExcludedEntry[] }> {
  const { entries, totalBytes, excluded } = await walk(root, limits, overrides)
  // 复用归档路径校验：Windows 保留名、大小写冲突、文件/目录冲突一律拒绝。
  validateArchivePaths(entries as ArchivePath[], limits.maxEntries)
  const manifestBytes = Buffer.byteLength(JSON.stringify(entries), 'utf8')
  if (manifestBytes > limits.maxManifestBytes) {
    throw new ManifestError('MANIFEST_LIMIT', `清单序列化字节超过上限 ${limits.maxManifestBytes}`)
  }
  // 路径已按 `readdirSync().sort()` 与深度优先顺序生成；此处再按路径排序，保证确定性。
  entries.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
  // 未纳入项同样排序，保证「明确报告」的顺序稳定、可跨次比对。
  excluded.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
  return { entries, totalBytes, manifestBytes, excluded }
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
