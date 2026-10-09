import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { pipeSourceHash, verifyPipeArtifact } from './assetsPipeArtifact.mjs'

/** Called by afterPack as well as tests; direct builder invocations cannot bypass it. */
export async function auditPackagedPipeHelper({ projectDir, resourcesDir, platform, arch }) {
  if (platform !== 'win32') return
  if (arch !== 'x64') throw new Error('PIPE_HELPER_UNSUPPORTED_ARCHITECTURE')
  const sourceHash = await pipeSourceHash(join(projectDir, 'native/assets-pipe-helper'))
  const source = await verifyPipeArtifact(join(projectDir, '.native/assets-pipe-helper/win-x64'), { rid: 'win-x64', sourceHash })
  const directory = join(resourcesDir, 'assets-pipe-helper/win-x64')
  const output = await verifyPipeArtifact(directory, { rid: 'win-x64', sourceHash })
  if (JSON.stringify(source.manifest) !== JSON.stringify(output.manifest)) throw new Error('PIPE_HELPER_PACKAGE_MISMATCH')
  for (const name of ['LICENSE.txt', 'THIRD-PARTY-NOTICES.txt']) {
    if (!output.manifest.files.some(file => file.path === name) || !(await readFile(join(directory, name))).length) throw new Error('PIPE_HELPER_LICENSE_MISSING')
  }
  return output.manifest
}
