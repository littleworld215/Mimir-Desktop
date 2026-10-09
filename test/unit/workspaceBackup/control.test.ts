import { expect, it } from 'vitest'
import { WorkspaceOperationGate } from '../../../electron/workspaceBackup/operationGate'
import { performance } from 'node:perf_hooks'

const scope = { id: 'a', epoch: '1', root: '/synthetic' }
const deferred = () => {
  let resolve!: () => void
  const promise = new Promise<void>(done => { resolve = done })
  return { promise, resolve }
}
it('控制请求先暂停新任务，排空在途任务后才执行；两个控制按顺序且中途不放新写入', async () => {
  const gate = new WorkspaceOperationGate()
  const work = deferred(), control = deferred(), calls: string[] = []
  const pending = gate.run(scope, async () => { await work.promise; calls.push('work') })
  const first = gate.runControl(1000, async () => {
    gate.assertWritable(); calls.push('first'); await control.promise
  })
  const second = gate.runControl(1000, async () => { gate.assertWritable(); calls.push('second') })
  await expect(gate.run(scope, async () => {})).rejects.toThrow()
  expect(calls).toEqual([])
  work.resolve(); await pending
  await new Promise(resolve => setImmediate(resolve))
  expect(calls).toEqual(['work', 'first'])
  await expect(gate.run(scope, async () => {})).rejects.toThrow()
  control.resolve(); await first; await second
  expect(calls).toEqual(['work', 'first', 'second'])
  await expect(gate.run(scope, async () => 7)).resolves.toBe(7)
})
it('控制回调失败阻断后续控制和新任务，不能用resume掩盖失败', async () => {
  const gate = new WorkspaceOperationGate()
  const first = gate.runControl(1000, async () => { throw Error('close failure') })
  let called = false
  const second = gate.runControl(1000, async () => { called = true })
  await expect(first).rejects.toThrow('close failure')
  await expect(second).rejects.toThrow()
  expect(called).toBe(false)
  expect(() => gate.resume()).toThrow()
  await expect(gate.run(scope, async () => {})).rejects.toThrow()
})
it('控制自身不得作为普通被跟踪任务等待自己，也不得嵌套控制', async () => {
  const gate = new WorkspaceOperationGate()
  await gate.run(scope, async () => {
    await expect(gate.runControl(1000, async () => {})).rejects.toThrow('嵌套')
  })
  await gate.runControl(1000, async () => {
    await expect(gate.runControl(1000, async () => {})).rejects.toThrow('嵌套')
  })
})
it('控制超时保持阻断，迟到回调失去写权限，不能恢复入口', async () => {
  const gate = new WorkspaceOperationGate(), done = deferred()
  let late!: () => void
  const control = gate.runControl(15, async () => {
    late = gate.bind(() => gate.assertWritable())
    await done.promise
  })
  await expect(control).rejects.toThrow('超时')
  expect(() => late()).toThrow()
  done.resolve()
  await new Promise(resolve => setImmediate(resolve))
  await expect(gate.run(scope, async () => {})).rejects.toThrow()
})
it('在途任务排空期间失败不执行控制回调，保留阻断', async () => {
  const gate = new WorkspaceOperationGate(), done = deferred()
  const pending = gate.run(scope, async () => { await done.promise; throw Error('work failed') })
  const caught = pending.catch(() => {})
  let called = false
  const control = gate.runControl(1000, async () => { called = true })
  done.resolve()
  await expect(control).rejects.toThrow('任务失败')
  await caught
  expect(called).toBe(false)
})
it('同步回调占用事件循环超过预算后不能写入，不依赖定时器先执行', async () => {
  const gate = new WorkspaceOperationGate()
  await expect(gate.runControl(10, async () => {
    const until = performance.now() + 30
    while (performance.now() < until) { /* synthetic synchronous work */ }
    expect(() => gate.assertWritable()).toThrow('超时')
  })).rejects.toThrow('超时')
})
it('读取上下文的调用方不能修改当前任务固定根', async () => {
  const gate = new WorkspaceOperationGate()
  await gate.run(scope, async () => {
    Object.assign(gate.current()!, { root: '/changed' })
    expect(gate.current()?.root).toBe('/synthetic')
  })
})
it('结束的控制回调不能借run重新获得任务租约', async () => {
  const gate = new WorkspaceOperationGate()
  let late!: () => Promise<void>, ran = false
  await gate.runControl(1000, async () => {
    late = gate.bind(() => gate.run(scope, async () => { ran = true }))
  })
  await expect(late()).rejects.toThrow('控制已结束')
  expect(ran).toBe(false)
})
it('外部排空与活动控制互斥，控制成功不能撤销外部暂停', async () => {
  const gate = new WorkspaceOperationGate(), finish = deferred(), entered = deferred()
  const control = gate.runControl(1000, async () => { entered.resolve(); await finish.promise })
  await entered.promise
  gate.stopAccepting()
  await expect(gate.drain(100)).rejects.toThrow('控制')
  finish.resolve(); await control
  await expect(gate.run(scope, async () => {})).rejects.toThrow()
  await expect(gate.runControl(100, async () => {})).rejects.toThrow()
  gate.resume()
  await expect(gate.run(scope, async () => 1)).resolves.toBe(1)
})
it('已经开始外部排空时拒绝新控制，不在已授权维护后变更空间', async () => {
  const gate = new WorkspaceOperationGate()
  await gate.drain(100)
  await expect(gate.runControl(100, async () => {})).rejects.toThrow()
})
