import { afterEach, expect, it, vi } from 'vitest'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

vi.mock('node:fs/promises', async importOriginal => {
  const fs = await importOriginal<typeof import('node:fs/promises')>()
  return { ...fs,
    readFile: async (...args: Parameters<typeof fs.readFile>) => {
      if (String(args[0]).endsWith('oversized.dll')) throw new Error('OVERSIZED_FILE_WAS_READ')
      return fs.readFile(...args)
    },
    open: async (...args: Parameters<typeof fs.open>) => {
      const handle = await fs.open(...args)
      if (String(args[0]).endsWith('oversized.dll')) {
        const stat = handle.stat.bind(handle)
        handle.stat = (async () => ({ ...await stat(), size: 513 * 1024 * 1024, isFile: () => true })) as typeof handle.stat
      }
      return handle
    }
  }
})
import { createPipeManifest } from '../../../scripts/lib/assetsPipeArtifact.mjs'
let root: string
afterEach(async () => { if (root) await rm(root, { recursive: true, force: true }) })
it('rejects an oversized file before reading its bytes into the main process', async () => {
  root = await mkdtemp(join(tmpdir(), 'mimir-size-'))
  await mkdir(join(root, 'artifact')); await writeFile(join(root, 'artifact/oversized.dll'), 'small physical fixture')
  await expect(createPipeManifest(join(root, 'artifact'), { protocolVersion: 1, rid: 'win-x64', entry: 'Mimir.AssetsPipeHelper.exe', sdkVersion: '10.0.401', runtimeVersion: '10.0.12', sourceHash: 'a'.repeat(64) })).rejects.toThrow('PIPE_ARTIFACT_INVALID')
})
