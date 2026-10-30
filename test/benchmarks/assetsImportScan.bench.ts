import { afterAll, expect, it } from 'vitest'
import * as harness from './importScanHarness'
const api = harness as unknown as {
  statistics(samples: number[]): { min: number; median: number; max: number; p95?: number }
  runCase(count: number, bytes: number): Promise<unknown>
  writeReport(path: string, cases: unknown[]): void
  correctness(): Promise<void>
}
const cases: unknown[] = []
it('量测设施：原始样本统计，不足20不声称P95', () => {
  expect(api.statistics).toBeTypeOf('function')
  expect(api.statistics([5,1,4,2,3])).toEqual({min:1,median:3,max:5})
})
it('量测设施：失败零部分写入、异常文件及受管路径拒绝', async () => {
  expect(api.correctness).toBeTypeOf('function'); await api.correctness()
})
for (const [count,bytes] of [[100,4096],[1000,4096],[5000,4096],[100,1048576]]) it(`合成${count}×${bytes}：预热一次、五次独立库/目录`, async () => {
  expect(api.runCase).toBeTypeOf('function'); cases.push(await api.runCase(count!,bytes!))
})
afterAll(() => { if (typeof api.writeReport === 'function') api.writeReport(process.env.MIMIR_IMPORT_SCAN_REPORT ?? '', cases) })
