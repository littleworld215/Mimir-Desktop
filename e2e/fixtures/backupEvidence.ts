import type { TestInfo } from '@playwright/test'
import { writeFileSync } from 'node:fs'

/** 通过场景也保留JSON文件；仅内存body附件在list报告结束后可能不落盘。 */
export async function attachBackupEvidence(info: TestInfo, name: string, evidence: unknown): Promise<void> {
  const path = info.outputPath(name + '.json')
  writeFileSync(path, JSON.stringify(evidence, null, 2))
  await info.attach(name, { path, contentType: 'application/json' })
}
