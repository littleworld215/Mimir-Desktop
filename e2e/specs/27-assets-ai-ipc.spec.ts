import { createServer } from 'node:http'
import type { Socket } from 'node:net'
import { test, expect } from '@playwright/test'
import { launchApp } from '../fixtures/launch'
import { gatewayModelSeed } from '../fixtures/seed'

test('I5 固定 AI IPC：真实 Electron/SQLite/模型SDK生成、冲突、派生、标签及取消', async () => {
  let calls = 0, delay = false
  const sockets = new Set<Socket>()
  const server = createServer(async (req, res) => {
    let body = ''; for await (const chunk of req) body += chunk.toString()
    calls++
    const text = JSON.parse(body).messages.map((m: { content: string }) => m.content).join('\n')
    if (delay) await new Promise(r => setTimeout(r, 700))
    res.setHeader('Content-Type', 'application/json')
    res.end(JSON.stringify({ id: 'mock', object: 'chat.completion', model: 'fake-model', choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content: text.includes('标签') ? '["Rust"]' : '模型润色结果' } }], usage: { prompt_tokens: 1, completion_tokens: 2, total_tokens: 3 } }))
  })
  server.on('connection', socket => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)) })
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r))
  const address = server.address(); if (!address || typeof address === 'string') throw Error('no port')
  const launched = await launchApp({ transformSeed: seed => ({ ...seed, settings: gatewayModelSeed(`http://127.0.0.1:${address.port}/v1`) }) })
  try {
    const result = await launched.page.evaluate(async () => {
      const api = window.electronAPI!.assets
      const c = await api.context(); if (!c.ok) throw Error(c.message)
      const scope = c.context
      const created = await api.create({ ...scope, input: { name: 'AI隔离资产', category: 'inbox', storageType: 'inline_text', content: '原始正文' } }); if (!created.ok) throw Error(created.message)
      const asset = created.asset
      const generated = await api.generateAiDraft({ ...scope, requestId: 'native-generate', confirmSend: true, input: { assetId: asset.id, mode: 'polish' } }); if (!generated.ok) throw Error(generated.message)
      const before = await api.get({ ...scope, assetId: asset.id })
      const page = await api.listAiDrafts({ ...scope, query: { assetId: asset.id } })
      const read = await api.getAiDraft({ ...scope, draftId: generated.draft.id })
      const changed = await api.update({ ...scope, assetId: asset.id, expectedRevision: 1, expectedCurrentVersionId: asset.currentVersionId, patch: { content: '人工修改' } }); if (!changed.ok) throw Error(changed.message)
      const conflict = await api.adoptAiDraft({ ...scope, draftId: generated.draft.id, confirm: true, input: { expectedRevision: 2 } })
      const derived = await api.adoptAiDraft({ ...scope, draftId: generated.draft.id, confirm: true, input: { expectedRevision: 2, carry: 'derived', name: '派生结果' } })
      const tags = await api.suggestAiTags({ ...scope, requestId: 'native-tags', confirmSend: true, input: { assetId: asset.id } })
      const tagged = await api.adoptSuggestedTags({ ...scope, confirm: true, input: { assetId: asset.id, expectedRevision: 2, names: ['Rust'] } })
      return { assetId: asset.id, scope, generated, before, page, read, conflict, derived, tags, tagged }
    })
    expect(result.generated).toMatchObject({ ok: true, draft: { content: '模型润色结果', usage: { totalTokens: 3 } } })
    expect(result.before).toMatchObject({ ok: true, asset: { currentContent: '原始正文', revision: 1 } })
    expect(result.page).toMatchObject({ ok: true, page: { total: 1 } }); expect(result.read).toMatchObject({ ok: true })
    expect(result.conflict).toMatchObject({ ok: false, code: 'VERSION_CONFLICT' })
    expect(result.derived).toMatchObject({ ok: true, carry: 'derived', asset: { currentContent: '模型润色结果' } })
    expect(result.tags).toMatchObject({ ok: true, suggestions: [{ name: 'Rust' }] })
    expect(result.tagged).toMatchObject({ ok: true, asset: { currentContent: '人工修改', revision: 3 } })
    expect(calls).toBe(2)
    delay = true
    const canceled = await launched.page.evaluate(async ({ assetId, scope }) => {
      const api = window.electronAPI!.assets
      const running = api.generateAiDraft({ ...scope, requestId: 'native-cancel', confirmSend: true, input: { assetId, mode: 'polish' } })
      await new Promise(r => setTimeout(r, 100))
      const canceled = await api.cancelAiRequest({ ...scope, requestId: 'native-cancel' })
      const result = await running
      await new Promise(r => setTimeout(r, 800))
      return { canceled, result, drafts: await api.listAiDrafts({ ...scope }) }
    }, { assetId: result.assetId, scope: result.scope })
    expect(canceled.canceled).toMatchObject({ ok: true, canceled: true })
    expect(canceled.result).toMatchObject({ ok: false, code: 'AI_ABORTED' })
    expect(canceled.drafts).toMatchObject({ ok: true, page: { total: 0 } })
  } finally {
    await launched.cleanup()
    for (const socket of sockets) socket.destroy()
    await new Promise<void>(r => server.close(() => r()))
  }
})

test('I5 真实主Agent工具链：资产工具注册、外发批准、草稿入库与原文保留', async () => {
  let assetId = 0, streams = 0, actions = 0
  const toolNames: string[] = [], sockets = new Set<Socket>()
  const server = createServer(async (req, res) => {
    let body = ''; for await (const chunk of req) body += chunk.toString()
    const payload = JSON.parse(body)
    if (payload.stream && (payload.tools?.length ?? 0) > 1) {
      streams++
      toolNames.push(...(payload.tools ?? []).map((t: { function: { name: string } }) => t.function.name))
      res.writeHead(200, { 'Content-Type': 'text/event-stream' })
      const delta = (value: object, reason: string | null = null) => `data: ${JSON.stringify({ id: 'agent-mock', object: 'chat.completion.chunk', model: 'fake-model', choices: [{ index: 0, delta: value, finish_reason: reason }] })}\n\n`
      res.write(delta({ role: 'assistant' }))
      if (streams === 1) {
        res.write(delta({ tool_calls: [{ index: 0, id: 'call-asset', type: 'function', function: { name: 'asset_ai', arguments: JSON.stringify({ assetId, mode: 'polish' }) } }] }))
        res.write(delta({}, 'tool_calls'))
      } else { res.write(delta({ content: '资产草稿已保存，等待采纳。' })); res.write(delta({}, 'stop')) }
      res.end('data: [DONE]\n\n')
    } else {
      actions++
      // 嵌套 invoke 会继承父图流式回调：SDK 可以走 SSE，按工具定义区分职责而非 stream 标志。
      if (payload.stream) {
        res.writeHead(200, { 'Content-Type': 'text/event-stream' })
        res.write(`data: ${JSON.stringify({ id: 'action', object: 'chat.completion.chunk', model: 'fake-model', choices: [{ index: 0, delta: { role: 'assistant', content: 'Agent润色结果' }, finish_reason: null }] })}\n\n`)
        res.end('data: [DONE]\n\n')
      } else {
        res.setHeader('Content-Type', 'application/json')
        res.end(JSON.stringify({ id: 'action', object: 'chat.completion', model: 'fake-model', choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content: 'Agent润色结果' } }], usage: { prompt_tokens: 1, completion_tokens: 2, total_tokens: 3 } }))
      }
    }
  })
  server.on('connection', socket => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)) })
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r))
  const address = server.address(); if (!address || typeof address === 'string') throw Error('no port')
  const launched = await launchApp({ transformSeed: seed => ({ ...seed, settings: gatewayModelSeed(`http://127.0.0.1:${address.port}/v1`) }) })
  try {
    assetId = await launched.page.evaluate(async () => {
      const api = window.electronAPI!.assets, scope = await api.context(); if (!scope.ok) throw Error(scope.message)
      const created = await api.create({ ...scope.context, input: { name: 'Agent资产', category: 'inbox', storageType: 'inline_text', content: 'Agent原文' } }); if (!created.ok) throw Error(created.message)
      return created.asset.id
    })
    const result = await launched.page.evaluate(async assetId => {
      const api = window.electronAPI!, approvals: string[] = []
      const unsub = api.onApprovalRequest(request => { approvals.push(request.tool); void api.approvalRespond(request.id, true) })
      try {
        const text = await api.streamMessage('请润色指定资产', 'asset-native-conversation', () => undefined, { manual: true })
        const scope = await api.assets.context(); if (!scope.ok) throw Error(scope.message)
        const drafts = await api.assets.listAiDrafts({ ...scope.context }); if (!drafts.ok) throw Error(drafts.message)
        return { text, approvals, drafts, draft: await api.assets.getAiDraft({ ...scope.context, draftId: drafts.page.items[0].id }), asset: await api.assets.get({ ...scope.context, assetId }) }
      } finally { unsub() }
    }, assetId)
    expect(result.text).toContain('资产草稿已保存')
    expect(result.approvals).toEqual(['asset_ai'])
    expect(result.drafts).toMatchObject({ ok: true, page: { total: 1 } })
    expect(result.draft).toMatchObject({ ok: true, draft: { content: 'Agent润色结果' } })
    expect(result.asset).toMatchObject({ ok: true, asset: { currentContent: 'Agent原文', revision: 1 } })
    expect(toolNames).toEqual(expect.arrayContaining(['asset_search', 'asset_read', 'asset_ai', 'asset_draft', 'asset_tags']))
    expect(actions).toBe(1); expect(streams).toBe(2)
  } finally {
    await launched.cleanup(); for (const socket of sockets) socket.destroy()
    await new Promise<void>(r => server.close(() => r()))
  }
})
