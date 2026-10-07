import { it, expect } from 'vitest'
import { readApprovalSourceContext } from '../../electron/agent/approval'
import { ALL_TOOL_IDS, WORKER_TOOL_CATALOG, resolveAllWorkerTools, resolveWorkerTools, loadCapabilityDomains, buildDomainSubagents } from '../../electron/agent/capabilityDomains'
it('资产五工具在目录、主Agent与独立能力域同源，旧域与未知白名单约束保留', () => {
  const names = ['asset_search', 'asset_read', 'asset_ai', 'asset_draft', 'asset_tags']
  expect(ALL_TOOL_IDS).toEqual(expect.arrayContaining(names))
  expect(WORKER_TOOL_CATALOG.filter(t => names.includes(t.id))).toHaveLength(5)
  expect((resolveAllWorkerTools() as { name: string }[]).map(t => t.name)).toEqual(expect.arrayContaining(names))
  expect(resolveWorkerTools(['unknown', 'asset_ai', 'asset_ai'])).toHaveLength(1)
  const { domains } = loadCapabilityDomains()
  expect(domains.map(d => d.id)).toEqual(expect.arrayContaining(['literature', 'paper', 'experiment', 'meeting', 'server', 'files', 'assets']))
  const domain = domains.find(d => d.id === 'assets')!
  expect((domain.tools as { name: string }[]).map(t => t.name)).toEqual(names)
  const specs = buildDomainSubagents(domains)
  expect((specs.find(s => s.name === 'assets')!.tools as { name: string }[]).map(t => t.name)).toEqual(names)
})
it('真实子代理构建出口注入批准来源并保留空间与取消配置', async () => {
  const { domains } = loadCapabilityDomains()
  const domain = domains.find(d => d.id === 'assets')!
  const config = { signal: new AbortController().signal, configurable: { assetsScope: { workspaceId: 'old', spaceEpoch: 1 } } }
  const base = { name: 'asset_ai', invoke: async (_input: unknown, received: unknown) => ({ source: readApprovalSourceContext(), received }) }
  const [spec] = buildDomainSubagents([{ ...domain, tools: [base] }])
  const result = await (spec.tools[0] as typeof base).invoke({}, config)
  expect(result.source).toMatchObject({ origin: 'subagent', subagentId: 'assets', subagentLabel: domain.label })
  expect(result.received).toBe(config)
})
