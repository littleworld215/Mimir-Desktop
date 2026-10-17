import { closeSync, fstatSync, fsyncSync, lstatSync, openSync, unlinkSync, writeFileSync } from 'node:fs'
import type { EvidenceDocument, EvidenceFilter } from '../../../shared/libraryEvidenceContracts'
import { selectEvidenceCards, type EvidenceViewContext } from './matrix'
import { currentEvidenceVersion } from './service'
import { EvidenceError } from './validation'

const markdownText = (value: string) => value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/[\\`*_{}\[\]()#!|~]/g, '\\$&')
const csvText = (value: string) => `"${(/^[\s\u0000-\u001f\u007f]*[=+\-@]/u.test(value) ? `'${value}` : value).replace(/"/g, '""')}"`
export function serializeEvidenceExport(doc: EvidenceDocument, filter: EvidenceFilter, format: 'markdown' | 'csv' | 'json', context: EvidenceViewContext = {}) {
  const cards = selectEvidenceCards(doc, filter, context)
  let output: string
  if (format === 'json') output = JSON.stringify({ ...doc, cards }, null, 2)
  else {
    const headers = ['证据ID', '文献ID', '文献标题', '研究问题', '待比较判断', '原文摘录', '方法', '数据或材料', '主要发现', '局限', '个人评注', '用户关系', '核对状态', '归档', '修订', 'PDF物理起始页', 'PDF结束页', '印刷页码', '章节', '图表', 'PDF_SHA256', 'PDF字节数', '来源确认时间']
    const rows = cards.map(card => { const v = currentEvidenceVersion(card); return [card.id, v.paperId, v.paperSnapshot.title, v.question, v.claim, v.quote, v.method, v.datasetOrMaterial, v.finding, v.limitation, v.comment, v.relation, v.reviewState, String(v.archived), String(v.version), String(v.locator.pageStart ?? ''), String(v.locator.pageEnd ?? ''), v.locator.printedPageLabel ?? '', v.locator.section ?? '', v.locator.figureOrTable ?? '', v.documentBinding?.sha256 ?? '', String(v.documentBinding?.size ?? ''), v.documentBinding?.checkedAt ?? ''] })
    output = format === 'csv' ? [headers, ...rows].map(row => row.map(csvText).join(',')).join('\r\n') + '\r\n'
      : '# 文献证据（人工整理）\n\n用户判断与核对状态不代表科研事实验证。\n\n' + rows.map((row, i) => `## 证据 ${i + 1}\n\n` + row.map((value, col) => `**${headers[col]}**\n\n${markdownText(value || '未填写')}\n`).join('\n')).join('\n')
  }
  return { utf8: Buffer.from(output, 'utf8'), cardCount: cards.length, versionCount: format === 'json' ? cards.reduce((sum, card) => sum + card.versions.length, 0) : cards.length }
}
/** 可信主进程路径必须来自原生选择框；wx拒绝已存在和竞态目标。 */
export function createEvidenceExportWriter(hooks: Partial<Record<'write' | 'sync' | 'close', () => void>> = {}) {
  return (path: string, bytes: Buffer) => {
    let fd: number | undefined, owned: ReturnType<typeof fstatSync> | undefined, complete = false
    try {
      fd = openSync(path, 'wx', 0o600); owned = fstatSync(fd)
      hooks.write?.(); writeFileSync(fd, bytes)
      hooks.sync?.(); fsyncSync(fd)
      hooks.close?.(); closeSync(fd); fd = undefined; complete = true
    } catch { throw new EvidenceError('WRITE_FAILED', '导出未完成；已有文件不会覆盖，请使用新文件名并检查磁盘') }
    finally {
      let failed = false
      if (fd !== undefined) { try { closeSync(fd) } catch { failed = true } }
      if (!complete && owned) {
        try { const current = lstatSync(path); if (!current.isSymbolicLink() && current.ino === owned.ino && current.dev === owned.dev) unlinkSync(path); else failed = true }
        catch { failed = true }
      }
      if (failed) throw new EvidenceError('WRITE_FAILED', '导出失败且新文件清理未完成，请检查本机磁盘；未覆盖已有文件')
    }
  }
}
