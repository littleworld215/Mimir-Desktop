import { defineConfig } from 'vitest/config'
import base from './vitest.config'
export default defineConfig({ ...base, test: { ...base.test, include: ['test/benchmarks/**/*.bench.ts'], testTimeout: 600000, hookTimeout: 60000, fileParallelism: false } })
