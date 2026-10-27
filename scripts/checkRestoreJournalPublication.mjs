/** Synthetic production-path acceptance; retains every owned root and raw result. */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { randomUUID } from 'node:crypto'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { syncBuiltinESMExports } from 'node:module'
import { spawn } from 'node:child_process'

const script = fileURLToPath(import.meta.url), project = resolve(dirname(script), '..')
const write = (file, value) => fs.writeFileSync(file, JSON.stringify(value, null, 2), { flag: 'wx' })

async function worker() {
  const [, root, output, mode, countRaw] = process.argv.slice(2), count = Number(countRaw)
  assert(['actual', 'calibration'].includes(mode))
  assert(Number.isSafeInteger(count) && count >= 1 && count <= 100)
  const owner = JSON.parse(fs.readFileSync(join(root, 'probe-owner.json'), 'utf8'))
  assert.equal(owner.kind, 'restore-journal-publication')
  assert.equal(owner.token, process.env.MIMIR_JOURNAL_PROBE_TOKEN)
  assert.equal(fs.realpathSync(root), owner.realRoot)
  assert.equal(fs.realpathSync(dirname(root)), fs.realpathSync(tmpdir()))
  assert.equal(dirname(output), owner.reportRoot)
  const home = join(root, 'home'), target = join(root, 'target-parent')
  fs.mkdirSync(home); fs.mkdirSync(target)
  const counts = { planned: count, create: 0, save: 0, failed: 0, renameCalls: 0, injectedErrors: 0, actualErrors: 0 }
  const errors = [], failures = [], originalRename = fs.renameSync
  let phase = 'prepared', remaining = mode === 'calibration' ? 4 : 0
  fs.renameSync = (from, to) => {
    if (!String(to).startsWith(home)) return originalRename(from, to)
    counts.renameCalls++
    if (remaining > 0) {
      remaining--; counts.injectedErrors++
      throw Object.assign(Error('explicit four-attempt calibration'), { code: 'EPERM' })
    }
    try { return originalRename(from, to) } catch (error) {
      counts.actualErrors++
      errors.push({ phase, code: error.code, errno: error.errno, syscall: error.syscall })
      throw error
    }
  }
  syncBuiltinESMExports()
  const { RestoreJournal } = await import(pathToFileURL(join(project, 'electron/workspaceBackup/restoreJournal.ts')).href)
  const journal = new RestoreJournal(home), started = Date.now()
  try {
    for (let index = 0; index < count; index++) {
      phase = 'prepared'
      try {
        let record = journal.create(join(target, `synthetic-${index}`), `合成记录${index}`)
        counts.create++
        for (phase of ['inspecting', 'extracting', 'verifying', 'verified']) {
          record = journal.save(record, { phase }); counts.save++
          assert.deepEqual(journal.read(record.id), record)
        }
      } catch (error) { counts.failed++; failures.push({ index, phase, code: error.code, name: error.name }) }
    }
  } finally { fs.renameSync = originalRename; syncBuiltinESMExports() }
  const verificationErrors = []
  let names = []
  try { names = fs.readdirSync(journal.directory) } catch (error) {
    verificationErrors.push({ phase: 'directory', code: error.code, name: error.name, message: error.message })
  }
  const files = names.filter(name => name.endsWith('.json'))
  for (const file of files) {
    try {
      const record = journal.read(file.slice(0, -5))
      assert.equal(fs.lstatSync(join(journal.directory, file)).nlink, 1)
      assert.equal(record.revision, 4); assert.equal(record.phase, 'verified')
    } catch (error) { verificationErrors.push({ phase: 'final-record', file, code: error.code, name: error.name, message: error.message }) }
  }
  const calibrated = mode === 'calibration' && counts.failed === 1 && counts.create === 0 && counts.save === 0
    && counts.injectedErrors === 4 && counts.actualErrors === 0 && counts.renameCalls === 4 && names.length === 0
  const passed = (mode === 'calibration' ? calibrated : counts.failed === 0 && counts.create === count
    && counts.save === count * 4 && files.length === count && names.length === files.length && counts.injectedErrors === 0) && verificationErrors.length === 0
  const report = { mode, passed, counts, errors, failures, verificationErrors, elapsedMs: Date.now() - started, retainedSyntheticRoot: root }
  write(output, report)
  console.log(JSON.stringify({ mode, passed, counts, elapsedMs: report.elapsedMs }))
  process.exitCode = passed ? 0 : 1
}

async function parent() {
  assert.equal(process.platform, 'win32', 'First publication acceptance is Windows-only')
  assert.equal(process.versions.node.split('.')[0], '22', 'Use the verified Node22 runtime')
  assert.equal(process.argv.length, 3, 'Usage: node --import tsx scripts/checkRestoreJournalPublication.mjs <new-evidence-directory>')
  const output = resolve(process.argv[2])
  fs.mkdirSync(output)
  write(join(output, 'proof-owner.json'), { kind: 'restore-journal-publication-acceptance', createdAt: new Date().toISOString() })
  async function run(label, count, mode = 'actual') {
    const root = fs.mkdtempSync(join(tmpdir(), 'mimir-journal-proof-')), token = randomUUID()
    const report = join(output, `${label}.json`)
    write(join(root, 'probe-owner.json'), { kind: 'restore-journal-publication', token, realRoot: fs.realpathSync(root), reportRoot: output })
    const child = spawn(process.execPath, ['--import', 'tsx', script, '--worker', root, report, mode, String(count)], {
      cwd: project, windowsHide: true, env: { ...process.env, MIMIR_TEST: '1', MIMIR_JOURNAL_PROBE_TOKEN: token }
    })
    const stdout = fs.createWriteStream(join(output, `${label}.stdout.log`), { flags: 'wx' })
    const stderr = fs.createWriteStream(join(output, `${label}.stderr.log`), { flags: 'wx' })
    child.stdout.pipe(stdout); child.stderr.pipe(stderr)
    let timedOut = false, spawnError
    const timer = setTimeout(() => { timedOut = true; child.kill('SIGTERM') }, 120000)
    const status = await new Promise(resolveStatus => {
      child.once('error', error => { spawnError = { code: error.code, message: error.message } })
      child.once('close', (code, signal) => { clearTimeout(timer); resolveStatus({ code, signal, timedOut, spawnError }) })
    })
    await Promise.all([new Promise(done => stdout.closed ? done() : stdout.once('close', done)), new Promise(done => stderr.closed ? done() : stderr.once('close', done))])
    const result = fs.existsSync(report) ? JSON.parse(fs.readFileSync(report, 'utf8')) : null
    const value = { label, ...status, result }
    write(join(output, `${label}.status.json`), value)
    console.log(JSON.stringify({ label, ...status, counts: result?.counts, passed: result?.passed }))
    return value
  }
  const calibration = await run('calibration', 1, 'calibration')
  const single = await run('single', 100)
  const parallel = await Promise.allSettled([1, 2, 3, 4].map(index => run(`parallel-${index}`, 100)))
  const reports = [calibration, single, ...parallel.map(value => value.status === 'fulfilled' ? value.value : { error: String(value.reason) })]
  const passed = reports.every(value => value.code === 0 && !value.timedOut && value.result?.passed)
  write(join(output, 'summary.json'), { kind: 'production-path-with-separate-calibration', passed, actualPlanned: 500, reports })
  process.exitCode = passed ? 0 : 1
}

(process.argv[2] === '--worker' ? worker() : parent()).catch(error => { console.error(error); process.exitCode = 1 })
