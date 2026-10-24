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
 *
 * ⚠️ **上面这条「同口径就能命中」的推断是错的，已被实测推翻（T05 联调）**：
 * `remapRules.matchRootPrefix` 第 147 行要求「旧根与待改写值**都是绝对路径**」才可能命中
 * （`isAbsolutePathLike` 双侧判定）。而 store 里的 `pdfPath` 是**绝对**路径
 * （`electron/library/types.ts` 明写「已下载 PDF 的绝对路径」），
 * 于是把**相对**根喂进 T03 → `rewritten=0`（`reason: outside-old-root`），
 * 换成绝对根 → `rewritten=1`。**结论：T03 的路径改写只能以绝对旧根为基准。**
 *
 * 因此本文件的 `oldRootFromArchive` **不再是 T03 的匹配基准**，它的正确用途有二：
 * 1. `canDeriveOldRoot` —— 在**选归档阶段**给用户提示「这份归档的条目形态是否规整」；
 * 2. 作为 `sourceRoot` 缺失（批次 2/3 早期归档）时的**诊断信息**，不作改写依据。
 *
 * 权威基准改由 `readArchiveManifest` 读出的 **`ArchiveManifest.sourceRoot`**（绝对路径，
 * 打包时写入）担任，见 `restoreMain.runMaintenanceRestore` 的旧根选择逻辑。
 * 匹配**宁可不中**：`sourceRoot` 缺失时 `oldRoot` 退化为空串——此时 T03 一条都不改写，
 * 空间仍能完整恢复，只是 `pdfPath` 保持旧值。**绝不猜测**：猜错会把
 * 用户空间外的 PDF 路径改到新空间里（K2/§7 高危误写）。
 *
 * 纪律：
 * - 推导逻辑（`oldRootFromArchive` / `canDeriveOldRoot`）**零 IO**：输入是已读出的清单条目
 *   数组，不打开归档、不 stat。归档读取由 `readArchiveManifest` / `readArchiveManifestEntries`
 *   负责，它们是本文件**唯一**触碰 IO 的函数（沿用 `extract.ts` 的 yauzl 手法，不引新依赖）。
 * - 不 import 任何 `electron` 模块；`fs` 也只用在归档读取两处。
 */

import { scanArchive } from './archiveReader'
import { resolveArchiveLimits, VerifyError, type ArchiveLimitsInput } from './archivePolicy'

import { RestoreError } from './restoreContracts'
import type { ArchiveManifest } from './archiveFormat'
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
 * ⚠️ **本函数的结果不再是 T03 的匹配基准**（相对根与绝对 `pdfPath` 永不匹配，实测见文件头
 * 注释）。它的正确用途是「形态诊断」与 `canDeriveOldRoot`，以及作为 `sourceRoot` 缺失时的
 * 参考信息。**T03 必须用 `ArchiveManifest.sourceRoot`（绝对路径）。**
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
 * @returns 归一化后的**相对**根；**推不出时返回 `null`**（调用方须退化为「不改写」）
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

/** 预览只读清单，但全目录计数、路径集合及清单字节限制与验包一致。 */
export async function readArchiveManifestEntries(archivePath: string, limits?: ArchiveLimitsInput): Promise<ManifestEntry[]> {
  return (await readArchiveManifest(archivePath, limits)).entries
}

/** 早期清单缺sourceRoot仍合法；实际旧根不猜测，未知业务键保留。 */
export async function readArchiveManifest(archivePath: string, input?: ArchiveLimitsInput): Promise<ArchiveManifest> {
  try { return (await scanArchive(archivePath, resolveArchiveLimits(input))).manifest } catch (error) {
    if (error instanceof VerifyError && error.code !== 'OPEN_FAILED' && error.code !== 'READ_FAILED' && error.code !== 'MANIFEST_MISSING') {
      throw new RestoreError(error.code, error.message)
    }
    throw new RestoreError('RECHECK_FAILED', '读取归档清单失败：' + (error instanceof Error ? error.message : '未知错误'))
  }
}
