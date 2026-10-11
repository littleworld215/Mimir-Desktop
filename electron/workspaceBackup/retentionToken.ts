/**
 * 保留确认 token（纯函数 + `node:crypto`，I6 批次 5 · T02）。
 *
 * 职责：为一次「保留预览」生成一个**一次性确认 token**，该 token **绑定本次预览的候选集摘要**。
 * 它的唯一用途是让「确认清理」在真正删除前能判定：**渲染层拿回来的 token 是否对应当前磁盘上
 * 真实的清理候选集**——从而堵住两类风险：
 *
 * - **K2（渲染层指定删除路径）**：token 里**不含候选集本身**（不塞文件列表 / 不塞路径），
 *   只含一个 SHA-256 摘要前缀 + 随机数。渲染层无法从 token 反解出任何文件名 / 路径，
 *   更无法指定要删哪个文件——删除目标永远由主进程**自己重算**（见 `retentionService`）。
 * - **K3（过期预览 → 删错）**：token 摘要随候选集内容变化而变化。若预览之后用户又备份了
 *   一份归档（或删了某份），候选集变了 → 重算摘要 ≠ token 里的摘要 → `TOKEN_MISMATCH`，
 *   执行方**零副作用**返回。
 *
 * ── 为什么以「候选集摘要」而非 TTL 实现过期 ────────────────────────────────
 * 设计稿 §2.2 的过期语义是**内容绑定**而非**时间绑定**：真正会出问题的是「候选集和预览时
 * 不一致」，而不是「预览过了一阵子」。候选集一变，摘要必然不符——过期是**自然涌现**的，
 * 不需要（也不应该有）一个会误伤的 TTL。故本模块**不落盘、不缓存、无时钟**：纯计算，
 * 每次预览现算、每次执行现验。同一候选集在任意时刻算出的摘要恒等（无随机、无时间参与摘要），
 * 随机性只在 token 的 `<randomUUID>` 尾部（仅用于「一次性」观感，不参与匹配判定）。
 *
 * 匹配判定**只依赖**：`token` 中的摘要前缀 + **调用方现算的候选集**。签名刻意不接收任何
 * 秘密 / 密钥——这是一个**完整性自检**（防误操作 / 防过期），不是密码学鉴权（渲染层本就
 * 不可信，真正的安全边界是「主进程自己重算候选 + 严格白名单 + 双重复核」，见 `retentionService`）。
 */

import { createHash, randomUUID } from 'node:crypto'

/**
 * token 里摘要前缀的长度（十六进制字符数）。
 *
 * 取 16：SHA-256 有 64 位十六进制字符，16 位 = 64 bit 摘要前缀——碰撞概率对「同一次会话内
 * 的误配」已足够低（且配合 randomUUID 尾部，两个不同的候选集极难产出同一 token），
 * 同时让 token 保持短小、便于在 UI 与日志里出现（token 本身不含敏感信息，可安全展示）。
 */
const DIGEST_PREFIX_LENGTH = 16

/** 拼装候选集规范化串时使用的**字段分隔符**（选用 `\u0000` 等不可能出现在字段里的字符，避免歧义拼接）。 */
const FIELD_SEPARATOR = '\u0000'
/** 候选项之间的**项分隔符**（同上，选不可能出现在字段里的字符）。 */
const ITEM_SEPARATOR = '\u0001'

/** `createRetentionToken` / `verifyRetentionToken` 接受的最小候选形状（只取参与摘要的三字段）。 */
export interface RetentionTokenCandidate {
  /** 文件名（basename）。 */
  readonly name: string
  /** 字节数。 */
  readonly bytes: number
  /** 最后修改时刻（ISO 字符串）。 */
  readonly modifiedAt: string
}

/**
 * 把候选集规范化为**确定性的**字符串（摘要的输入）。
 *
 * 规范化规则（**决定摘要是否稳定**，必须确定性）：
 * 1. 先按 `name` **字典序升序**排序——`listManagedArchives` 返回的是按 `modifiedAt` 降序，
 *    若直接拿它算摘要，候选集内容相同但顺序抖动（如 mtime 精度差异）会让摘要不稳定。按 `name`
 *    排序给出一个与输入顺序无关的确定性规格化表示。
 * 2. 每项拼成 `name\u0000bytes\u0000modifiedAt`，项间用 `\u0001` 连接。
 * 3. 分隔符选用 NUL/SOH 控制字符：文件名与 ISO 时间戳都不可能含它们，杜绝「字段边界歧义」
 *    导致的**摘要碰撞**（如 `['a','bc']` 与 `['ab','c']` 拼成同一串）。
 *
 * **纯函数**：不修改入参数组（用 `[...candidates]` 复制后排序），无 IO，无时钟。
 *
 * @param candidates 候选集（只取 `name` / `bytes` / `modifiedAt`；顺序无关）。
 * @returns 确定性的规范化串。
 */
function canonicalize(candidates: readonly RetentionTokenCandidate[]): string {
  return [...candidates]
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
    .map((c) => `${c.name}${FIELD_SEPARATOR}${c.bytes}${FIELD_SEPARATOR}${c.modifiedAt}`)
    .join(ITEM_SEPARATOR)
}

/**
 * 计算候选集的 SHA-256 摘要（十六进制，小写）。
 *
 * @param candidates 候选集。
 * @returns 64 位十六进制摘要字符串。
 */
function digestOf(candidates: readonly RetentionTokenCandidate[]): string {
  return createHash('sha256').update(canonicalize(candidates), 'utf8').digest('hex')
}

/**
 * 由候选集摘要 + 随机数生成一次性确认 token。
 *
 * 形态：`<摘要前16位>-<randomUUID>`，例如 `3f2a9c1b8e0d4a77-1b4e2c3d-...`。
 *
 * ⚠️ **token 只含摘要前缀与随机数，绝不含候选集本身**（不含文件名 / 字节 / 时间 / 路径）：
 * 渲染层拿到 token 也解不出任何归档信息，删除目标只能由主进程重算候选后确定（K2）。
 *
 * @param candidates 本次预览的**清理候选**集合（摘要即绑定于此）。
 * @returns 形如 `<16位摘要>-<uuid>` 的 token。
 */
export function createRetentionToken(candidates: readonly RetentionTokenCandidate[]): string {
  const digestPrefix = digestOf(candidates).slice(0, DIGEST_PREFIX_LENGTH)
  return `${digestPrefix}-${randomUUID()}`
}

/**
 * 校验 token 是否匹配给定候选集（防过期预览 / 防替换）。
 *
 * 判定：取 `token` 中 `-` 前的**摘要前缀**，与「对 `candidates` 现算摘要」的前缀比对。
 * 相等 → `true`（候选集与签发 token 时一致）；否则 `false`。
 *
 * **纯函数**：无 IO、无时钟、无随机；同一 `(token, candidates)` 恒返回同一结果。
 * token 形态非法（无分隔符 / 前缀非 16 位十六进制）→ `false`（绝不 throw，
 * 让调用方以「不匹配」这一条统一路径处理）。
 *
 * @param token 待校验 token（来自渲染层，**不可信**）。
 * @param candidates 调用方**现算**的候选集（主进程重算，非渲染层传入）。
 * @returns 匹配 → `true`。
 */
export function verifyRetentionToken(
  token: string,
  candidates: readonly RetentionTokenCandidate[]
): boolean {
  if (typeof token !== 'string') return false
  const separatorIndex = token.indexOf('-')
  // 无分隔符 → 非法形态，不匹配。
  if (separatorIndex !== DIGEST_PREFIX_LENGTH) return false
  const prefix = token.slice(0, separatorIndex)
  // 摘要前缀必须是 16 位小写十六进制（挡掉任意字符串伪造成「匹配」）。
  if (!/^[0-9a-f]{16}$/.test(prefix)) return false
  return prefix === digestOf(candidates).slice(0, DIGEST_PREFIX_LENGTH)
}
