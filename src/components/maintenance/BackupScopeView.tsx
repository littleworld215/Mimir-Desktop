import type { BackupScopeSummary } from '../../../shared/workspaceBackupMetadata'

/** 覆盖范围与内容校验始终独立展示，不将声明当作签名或业务完整性。 */
export function BackupScopeView({ scope, verification }: { scope?: BackupScopeSummary; verification: 'not-run' | 'passed' }) {
  const legacy = !scope || scope.metadata === 'legacy-unknown'
  return <div className="backup-scope" aria-label="备份范围摘要">
    <p>{verification === 'passed' ? '已纳入内容校验通过；这不代表所有科研资料均已包含。' : '内容校验尚未运行；当前只读取范围声明。'}</p>
    {legacy ? <p role="note">该备份未保存范围说明，排除与外部依赖未知。</p> : <>
      <p role={scope.excludedCount + scope.externalCount + scope.unresolvedCount > 0 ? 'note' : undefined}>
        未纳入超限项：{scope.excludedCount}；已知外部引用：{scope.externalCount}；未解析：{scope.unresolvedCount}。
      </p>
      <p>{scope.coverage === 'unknown' ? '资料覆盖范围未知，不能据此认定没有遗漏。'
        : scope.externalCount === 0 ? '未发现已知结构字段中的外部引用；未扫描正文或核实外部目标。'
          : '列出的外部引用未包含、存在性未核实；未扫描正文。'}</p>
      {scope.producer && <p>包内来源声明：{scope.producer.application}，版本 {scope.producer.version ?? '未知'}，平台 {scope.producer.platform}。</p>}
      {scope.database && <p>包内数据库说明：{scope.database.state === 'present' ? `快照版本 ${scope.database.userVersion}` : scope.database.state === 'absent' ? '未包含资产数据库' : '版本未知'}。恢复仍独立校验实际数据库。</p>}
    </>}
    <p>范围说明由打包者声明，不是数字签名。</p>
  </div>
}
