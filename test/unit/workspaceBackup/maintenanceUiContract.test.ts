import { expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * 渲染层维护窗口的**源码契约**测试（I6 批次 4 · T05）。
 *
 * `src/renderer/maintenance.tsx` 是沙箱渲染层，运行在无 `node:*`、无任意文件系统能力的
 * 隔离环境里。它**只能做展示**：路径由主进程给，评分/科研判断一律禁止。这里用源码契约
 * 保证这些纪律在后续重构中不会被悄悄破坏——每条断言的字符串都刻意精确，能在真正违规时变红。
 */
const source = () => readFileSync(join(process.cwd(), 'src/renderer/maintenance.tsx'), 'utf8')

it('渲染层只做展示：不出现路径拼接迹象（§4.2 S7）', () => {
  const src = source()
  // 路径一律由主进程给（`archive.path` / 结果 `root` 只作展示）。
  // 渲染层**不得**自行拼接：既不许 `path.join` / `path.resolve`，也不许裸反斜杠拼变量。
  expect(src).not.toContain('path.join')
  expect(src).not.toContain('path.resolve')
  expect(src).not.toContain('path.sep')
  expect(src).not.toContain("require('path')")
  expect(src).not.toContain('require("path")')
  // 裸反斜杠 + 变量拼接（如 `\\` + variable）也是拼路径的迹象；转义后的正则精确匹配。
  expect(src).not.toMatch(/\\\\\s*\+/)
  expect(src).not.toMatch(/\+\s*\\\\/)
})

it('渲染层不引入评分/健康度暗示（K1 红线，对齐 D-038）', () => {
  const src = source()
  // 自检只陈述技术事实，**绝不做**评分/健康度/百分比/建议清理这类科研判断。
  expect(src).not.toContain('健康分')
  expect(src).not.toContain('健康度')
  expect(src).not.toContain('评分')
  expect(src).not.toContain('score')
  expect(src).not.toContain('百分比')
  expect(src).not.toContain('建议清理')
  expect(src).not.toContain('建议删除')
  // 注意：`%` 只允许出现在「百分比」的禁止文案里；代码中不得出现 `%` 相关的展示文案。
  expect(src).not.toMatch(/[0-9]\s*%/)
})

it('closeForm 不再是 busy 时静默 return：接线了取消（§3.2）', () => {
  const src = source()
  // 取消接线必须存在（判存在再调），并且对不可取消阶段给出明确提示文案。
  expect(src).toContain('cancelRestore')
  expect(src).toContain('已进入发布阶段，无法安全取消')
  // 诚实反映主进程的 NOT_SUPPORTED（不假装取消成功）。
  expect(src).toContain('当前版本不支持中途取消')
  // 不可取消阶段的判定必须存在（publishing / registering）。
  expect(src).toContain('isRestoreUncancellable')
  expect(src).toContain("'publishing'")
  expect(src).toContain("'registering'")
})

it('doctor / auditRecent 有判存在的降级（保持向后兼容）', () => {
  const src = source()
  // 旧主进程不提供新方法时，渲染层必须判存在再调用，不能直接抛错。
  expect(src).toContain("typeof api.doctor !== 'function'")
  expect(src).toContain("typeof api.auditRecent !== 'function'")
  // 进度订阅同样判存在再订阅（照 onRestoreProgress 的降级写法）。
  expect(src).toContain("typeof api.onDoctorProgress !== 'function'")
  expect(src).toContain('api.doctor')
  expect(src).toContain('api.auditRecent(50)')
})

it('保留区块不引入后台自动行为文案（K4 红线，对齐 D-032）', () => {
  const src = source()
  // 本功能只能由用户点按钮**显式**触发；**绝不**出现暗示后台 / 定时 / 一键的文案。
  expect(src).not.toContain('自动清理')
  expect(src).not.toContain('一键清理')
  expect(src).not.toContain('定时清理')
  expect(src).not.toContain('定时')
  expect(src).not.toContain('智能清理')
  expect(src).not.toContain('自动删除')
  expect(src).not.toContain('后台清理')
})

it('retentionPreview / applyRetention 有判存在的降级（保持向后兼容）', () => {
  const src = source()
  // 旧主进程不提供新方法时，渲染层必须判存在再调用，不能直接抛错。
  expect(src).toContain("typeof api.retentionPreview !== 'function'")
  expect(src).toContain("typeof api.applyRetention !== 'function'")
  // 两个方法本身必须被实际调用（判存在之后）。
  expect(src).toContain('api.retentionPreview()')
  expect(src).toContain('api.applyRetention(')
  // 旧主进程不提供清理时如实提示，不假装成功。
  expect(src).toContain('当前版本不支持清理')
  // 二次确认文案必须写明「删除不可撤销」（§7 K5）。
  expect(src).toContain('删除不可撤销')
  // 诚实反映 TOKEN_MISMATCH（不假装成功）。
  expect(src).toContain('TOKEN_MISMATCH')
  expect(src).toContain('备份已变化，请重新预览')
})

it('保留区块不回传路径：apply 只接收 token（K2 红线，对齐 §2.2 / §4.2 S7）', () => {
  const src = source()
  // item 契约只有 name（basename），**没有** path——渲染层不得读 `item.path`。
  expect(src).not.toContain('item.path')
  // apply 的实参必须是渲染层持有的 token 变量，**不得**是任何 item 字段 / 文件名。
  expect(src).toMatch(/applyRetention\(\s*retentionToken\s*\)/)
  expect(src).not.toMatch(/applyRetention\(\s*item\./)
  expect(src).not.toMatch(/applyRetention\(\s*\{\s*name:/)
})
