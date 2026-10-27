import { expect, it } from 'vitest'
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve, sep } from 'node:path'
import { randomUUID } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { pathToFileURL } from 'node:url'

it('生产探针后置校验失败仍保留计数与错误，已知注入不当作自然故障', () => {
  const root = mkdtempSync(join(tmpdir(), 'mimir-journal-proof-')), identity = realpathSync(root), token = randomUUID()
  const report = join(root, 'report.json'), hook = join(root, 'injected.mjs'), project = resolve(process.cwd())
  const owner = { kind: 'restore-journal-publication', token, realRoot: identity, reportRoot: root }
  writeFileSync(join(root, 'probe-owner.json'), JSON.stringify(owner))
  writeFileSync(hook, `import fs from 'node:fs'; import { syncBuiltinESMExports } from 'node:module';
const home=${JSON.stringify(join(root, 'home') + sep)}, rename=fs.renameSync; let count=0;
fs.renameSync=(from,to)=>{ if(String(to).startsWith(home) && JSON.parse(fs.readFileSync(from,'utf8')).phase==='inspecting' && count<4){
count++; fs.writeFileSync(${JSON.stringify(join(root, 'injected-count.json'))},JSON.stringify({injected:count})); throw Object.assign(Error('known test injection'),{code:'EPERM'}); } return rename(from,to); }; syncBuiltinESMExports();`)
  try {
    const child = spawnSync(process.execPath, ['--import', 'tsx', '--import', pathToFileURL(hook).href,
      join(project, 'scripts/checkRestoreJournalPublication.mjs'), '--worker', root, report, 'actual', '1'], {
      cwd: project, env: { ...process.env, MIMIR_TEST: '1', MIMIR_JOURNAL_PROBE_TOKEN: token },
      encoding: 'utf8', windowsHide: true, timeout: 30000
    })
    expect(child.error, child.stderr).toBeUndefined()
    expect(child.status).toBe(1)
    expect(existsSync(report), 'Failed worker must write structured evidence before returning').toBe(true)
    const result = JSON.parse(readFileSync(report, 'utf8'))
    expect(result.passed).toBe(false)
    expect(result.counts).toMatchObject({ planned: 1, create: 1, save: 0, failed: 1, actualErrors: process.platform === 'win32' ? 4 : 1 })
    expect(result.verificationErrors).toHaveLength(1)
    expect(JSON.parse(readFileSync(join(root, 'injected-count.json'), 'utf8')).injected).toBe(process.platform === 'win32' ? 4 : 1)
  } finally {
    expect(realpathSync(root)).toBe(identity)
    expect(JSON.parse(readFileSync(join(root, 'probe-owner.json'), 'utf8'))).toEqual(owner)
    rmSync(root, { recursive: true })
  }
})
