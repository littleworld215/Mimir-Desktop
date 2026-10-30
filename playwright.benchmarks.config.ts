import { defineConfig } from '@playwright/test'
import base from './playwright.config'
export default defineConfig({ ...base, testDir: './e2e/benchmarks', timeout: 180000, retries: 0 })
