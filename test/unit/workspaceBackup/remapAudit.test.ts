import { expect, it, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

async function auditModule() {
  const mod = await import(/* @vite-ignore */ join(process.cwd(), 'electron/workspaceBackup/remapAudit.ts')).catch(() => ({} as any))
  expect(mod.auditSpaceStore).toBeTypeOf('function')
  expect(mod.auditStagedSpaceStore).toBeTypeOf('function')
  return mod
}
async function remapModule() {
  const mod = await import(/* @vite-ignore */ join(process.cwd(), 'electron/workspaceBackup/spaceStoreRemap.ts')).catch(() => ({} as any))
  expect(mod.remapSpaceStore).toBeTypeOf('function')
  return mod
}
async function contracts() {
  const mod = await import(/* @vite-ignore */ join(process.cwd(), 'electron/workspaceBackup/restoreContracts.ts')).catch(() => ({} as any))
  expect(mod.RestoreError).toBeTypeOf('function')
  return mod
}

const OLD_ROOT = '/old/space'
const NEW_ROOT = '/new/space'
// 显式 opts：跨平台确定性（不依赖 win32 默认）
const OPTS = { caseInsensitive: false, separator: '/' as const }

/**
 * 真实形态的合成空间 store。
 *
 * ⚠️ `library:papers` 是 **Record<string, PaperRecord>（按 arxivId 键控）**，不是数组——
 * 见 `electron/library/libraryService.ts:40-42` 的 `papersTable()`。
 * 自由文本（title / summary / notes / tags[i]）**故意**包含旧根字符串，用于验证 K1。
 */
function makeStore() {
  return {
    'library:papers': {
      '2103.00020v2': {
        arxivId: '2103.00020v2',
        title: '论文标题里也有 /old/space 这个字符串',
        authors: ['Author A'],
        summary: '摘要提到 /old/space/papers/2103.00020v2.pdf 也不应被改写',
        url: 'https://arxiv.org/abs/2103.00020v2',
        notes: '[2026-01-01 10:00] 见 /old/space/papers/2103.00020v2.pdf',
        tags: ['/old/space/tag-含旧根'],
        projectIds: [],
        pdfPath: `${OLD_ROOT}/papers/2103.00020v2.pdf`,
        addedAt: '2026-01-01T00:00:00.000Z'
      },
      '2103.00021v1': {
        arxivId: '2103.00021v1',
        title: '另一篇',
        authors: ['Author B'],
        summary: '',
        url: 'https://arxiv.org/abs/2103.00021v1',
        notes: '',
        tags: [],
        projectIds: [],
        // 空间**之外**的绝对路径：应原样保留并计入 skipped，不失败
        pdfPath: '/elsewhere/papers/2103.00021v1.pdf',
        addedAt: '2026-01-02T00:00:00.000Z'
      },
      '2103.00022v1': {
        arxivId: '2103.00022v1',
        title: '未下载 PDF 的论文',
        authors: ['Author C'],
        summary: '',
        url: 'https://arxiv.org/abs/2103.00022v1',
        notes: '',
        tags: [],
        projectIds: [],
        addedAt: '2026-01-03T00:00:00.000Z'
      }
    },
    'library:projects': [
      {
        id: 'p1',
        title: '项目一',
        // 用户自选的空间外 LaTeX 目录：**绝不改写**（设计 §3.0）
        paperDir: 'C:\\Users\\me\\latex\\proj1',
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:00.000Z'
      }
    ],
    // 诱导项：字段名也叫 pdfPath，但顶层键不是白名单的 library:papers → 只观察、不改写
    'library:decoy': {
      'x1': { pdfPath: `${OLD_ROOT}/papers/decoy.pdf` }
    }
  }
}

// ─── 改写组：白名单字段命中旧根 ─────────────────────────────────────

it('pdfPath 命中旧根 → found/rewritten 各 1 条，newValue 以新根开头且文件名不变', async () => {
  const { auditSpaceStore } = await auditModule()
  const report = auditSpaceStore(makeStore() as any, OLD_ROOT, NEW_ROOT, OPTS)
  expect(report.found).toHaveLength(1)
  expect(report.rewritten).toHaveLength(1)
  const finding = report.found[0]
  expect(finding.storeKey).toBe('library:papers')
  expect(finding.locator).toBe('2103.00020v2') // Record 形态：locator 是 arxivId
  expect(finding.field).toBe('pdfPath')
  expect(finding.oldValue).toBe(`${OLD_ROOT}/papers/2103.00020v2.pdf`)
  expect(finding.newValue).toBe(`${NEW_ROOT}/papers/2103.00020v2.pdf`)
  expect(finding.newValue.startsWith(NEW_ROOT)).toBe(true)
  expect(finding.newValue.split('/').pop()).toBe('2103.00020v2.pdf')
})

it('remapSpaceStore 真的把 pdfPath 改成新根，且 locator 正确（Record 形态）', async () => {
  const { remapSpaceStore } = await remapModule()
  const { store } = remapSpaceStore(makeStore() as any, OLD_ROOT, NEW_ROOT, OPTS)
  const papers = (store as any)['library:papers']
  expect(papers['2103.00020v2'].pdfPath).toBe(`${NEW_ROOT}/papers/2103.00020v2.pdf`)
  // 空间外路径原样保留
  expect(papers['2103.00021v1'].pdfPath).toBe('/elsewhere/papers/2103.00021v1.pdf')
  // 未下载论文的 pdfPath 仍是缺省（不应被凭空创建）
  expect(papers['2103.00022v1'].pdfPath).toBeUndefined()
})

// ─── K1 核心断言：自由文本未被全局替换 ──────────────────────────────

it('自由文本（title/summary/notes/tags[i]）含旧根也逐字不变', async () => {
  const { remapSpaceStore } = await remapModule()
  const before = makeStore()
  const { store } = remapSpaceStore(before as any, OLD_ROOT, NEW_ROOT, OPTS)
  const paper = (store as any)['library:papers']['2103.00020v2']
  expect(paper.title).toBe('论文标题里也有 /old/space 这个字符串')
  expect(paper.summary).toBe('摘要提到 /old/space/papers/2103.00020v2.pdf 也不应被改写')
  expect(paper.notes).toBe('[2026-01-01 10:00] 见 /old/space/papers/2103.00020v2.pdf')
  expect(paper.tags[0]).toBe('/old/space/tag-含旧根')
})

it('ProjectRecord.paperDir 是绝对路径也绝不改写（空间外用户目录）', async () => {
  const { remapSpaceStore } = await remapModule()
  const { store } = remapSpaceStore(makeStore() as any, OLD_ROOT, NEW_ROOT, OPTS)
  expect((store as any)['library:projects'][0].paperDir).toBe('C:\\Users\\me\\latex\\proj1')
})

it('诱导项：非白名单顶层键下的 pdfPath 不被改写，只出现在 observed', async () => {
  const { remapSpaceStore } = await remapModule()
  const { store, report } = remapSpaceStore(makeStore() as any, OLD_ROOT, NEW_ROOT, OPTS)
  expect((store as any)['library:decoy']['x1'].pdfPath).toBe(`${OLD_ROOT}/papers/decoy.pdf`)
  expect(report.observed.some((o: any) => o.storeKey === 'library:decoy' && o.field === 'pdfPath')).toBe(true)
  expect(report.found.every((f: any) => f.storeKey !== 'library:decoy')).toBe(true)
})

// ─── skipped 组：白名单字段但未命中 ─────────────────────────────────

it('空间外的 pdfPath → skipped(reason=outside-old-root)，值不变、不失败', async () => {
  const { auditSpaceStore } = await auditModule()
  const report = auditSpaceStore(makeStore() as any, OLD_ROOT, NEW_ROOT, OPTS)
  const skip = report.skipped.find((s: any) => s.locator === '2103.00021v1')
  expect(skip).toBeTruthy()
  expect(skip.reason).toBe('outside-old-root')
  expect(skip.value).toBe('/elsewhere/papers/2103.00021v1.pdf')
  expect(report.found.some((f: any) => f.locator === '2103.00021v1')).toBe(false)
})

it('相对路径 / 空串的 pdfPath → skipped(not-absolute|empty)', async () => {
  const { auditSpaceStore } = await auditModule()
  const store = {
    'library:papers': {
      a: { pdfPath: 'papers/relative.pdf' },
      b: { pdfPath: '' }
    }
  }
  const report = auditSpaceStore(store as any, OLD_ROOT, NEW_ROOT, OPTS)
  expect(report.skipped.find((s: any) => s.locator === 'a').reason).toBe('not-absolute')
  expect(report.skipped.find((s: any) => s.locator === 'b').reason).toBe('empty')
  expect(report.found).toHaveLength(0)
})

// ─── observed 组：非白名单字段的绝对路径只报告 ──────────────────────

it('非白名单字段含绝对路径 → 出现在 observed 且未被改写（U6 兜底钩子）', async () => {
  const { auditSpaceStore } = await auditModule()
  const report = auditSpaceStore(makeStore() as any, OLD_ROOT, NEW_ROOT, OPTS)
  const hit = report.observed.find((o: any) => o.storeKey === 'library:projects' && o.field === 'paperDir')
  expect(hit).toBeTruthy()
  expect(hit.locator).toBe('[0]')
  expect(hit.value).toBe('C:\\Users\\me\\latex\\proj1')
})

// ─── 零处需重写也算通过 ─────────────────────────────────────────────

it('完全没有路径的 store → 四桶全空、不抛错、返回的 store 与原 store 深相等', async () => {
  const { auditSpaceStore } = await auditModule()
  const { remapSpaceStore } = await remapModule()
  const store = {
    'library:papers': { a: { arxivId: 'a', title: 't', notes: '', tags: [] } },
    'library:projects': [{ id: 'p', title: 'p', createdAt: '', updatedAt: '' }]
  }
  const report = auditSpaceStore(store as any, OLD_ROOT, NEW_ROOT, OPTS)
  expect(report.found).toHaveLength(0)
  expect(report.rewritten).toHaveLength(0)
  expect(report.skipped).toHaveLength(0)
  expect(report.observed).toHaveLength(0)
  const { store: out } = remapSpaceStore(store as any, OLD_ROOT, NEW_ROOT, OPTS)
  expect(out).toEqual(store)
  expect(JSON.stringify(out)).toBe(JSON.stringify(store))
})

// ─── 未改部分逐字保留 ───────────────────────────────────────────────

it('改写后除 pdfPath 外，其余键与原 store 逐字一致（JSON 级比对）', async () => {
  const { remapSpaceStore } = await remapModule()
  const original = makeStore()
  const { store } = remapSpaceStore(original as any, OLD_ROOT, NEW_ROOT, OPTS)
  const expected: any = JSON.parse(JSON.stringify(original))
  expected['library:papers']['2103.00020v2'].pdfPath = `${NEW_ROOT}/papers/2103.00020v2.pdf`
  expect(JSON.stringify(store)).toBe(JSON.stringify(expected))
})

// ─── 幂等 & 输入不被改动 ────────────────────────────────────────────

it('幂等：对已改写的 store 再跑一次，found 为空', async () => {
  const { remapSpaceStore } = await remapModule()
  const first = remapSpaceStore(makeStore() as any, OLD_ROOT, NEW_ROOT, OPTS)
  expect(first.report.found).toHaveLength(1)
  const second = remapSpaceStore(first.store, OLD_ROOT, NEW_ROOT, OPTS)
  expect(second.report.found).toHaveLength(0)
  expect(second.report.rewritten).toHaveLength(0)
  expect(JSON.stringify(second.store)).toBe(JSON.stringify(first.store))
})

it('输入不被改动：调用后原对象的 pdfPath 仍是旧值', async () => {
  const { remapSpaceStore } = await remapModule()
  const original = makeStore()
  const { store } = remapSpaceStore(original as any, OLD_ROOT, NEW_ROOT, OPTS)
  expect((original as any)['library:papers']['2103.00020v2'].pdfPath).toBe(`${OLD_ROOT}/papers/2103.00020v2.pdf`)
  expect(store).not.toBe(original)
})

// ─── 唯一的 IO 入口：auditStagedSpaceStore ──────────────────────────

const dirs: string[] = []
function workDir(): string {
  const root = mkdtempSync(join(tmpdir(), 'mimir-remap-'))
  dirs.push(root)
  return root
}
afterEach(() => {
  for (const root of dirs.splice(0)) rmSync(root, { recursive: true, force: true })
})

it('auditStagedSpaceStore 读 <stagingRoot>/.mimir/store.json 并给出四桶报告', async () => {
  const { auditStagedSpaceStore } = await auditModule()
  const root = workDir()
  mkdirSync(join(root, '.mimir'), { recursive: true })
  writeFileSync(
    join(root, '.mimir', 'store.json'),
    JSON.stringify({ 'library:papers': { a: { pdfPath: `${OLD_ROOT}/papers/a.pdf` } } }),
    'utf8'
  )
  const report = auditStagedSpaceStore(root, OLD_ROOT, NEW_ROOT, OPTS)
  expect(report.found).toHaveLength(1)
  expect(report.found[0].newValue).toBe(`${NEW_ROOT}/papers/a.pdf`)
})

it('暂存 store.json 不是合法 JSON → 抛 RECHECK_FAILED（不静默通过）', async () => {
  const { auditStagedSpaceStore } = await auditModule()
  const { RestoreError } = await contracts()
  const root = workDir()
  mkdirSync(join(root, '.mimir'), { recursive: true })
  writeFileSync(join(root, '.mimir', 'store.json'), '{ 这不是 JSON', 'utf8')
  try {
    auditStagedSpaceStore(root, OLD_ROOT, NEW_ROOT, OPTS)
    throw new Error('应当拒绝非法 JSON')
  } catch (error) {
    expect((error as any).name).toBe('RestoreError')
    expect((error as any).code).toBe('RECHECK_FAILED')
    expect(error).toBeInstanceOf(RestoreError)
  }
})

it('暂存 store.json 缺失 → 抛 RECHECK_FAILED', async () => {
  const { auditStagedSpaceStore } = await auditModule()
  const root = workDir()
  try {
    auditStagedSpaceStore(root, OLD_ROOT, NEW_ROOT, OPTS)
    throw new Error('应当在缺失文件时失败')
  } catch (error) {
    expect((error as any).code).toBe('RECHECK_FAILED')
  }
})
