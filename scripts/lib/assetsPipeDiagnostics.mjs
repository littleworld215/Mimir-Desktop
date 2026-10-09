// Test/diagnostic build tooling only. Never imported by the production application.
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises'
import { dirname, join, resolve, basename } from 'node:path'
import { tmpdir } from 'node:os'
import { projectDir, outputDir, publishPipeHelper, sdkPath } from '../prepareAssetsPipeHelper.mjs'
import { pipeSourceHash, verifyPipeArtifact } from './assetsPipeArtifact.mjs'

export async function publishDiagnosticHelper(source, { expectedSourceHash, outputParent = tmpdir() } = {}) {
  const hash = await pipeSourceHash(projectDir)
  if (expectedSourceHash && hash !== expectedSourceHash) throw new Error('DIAGNOSTIC_SOURCE_MISMATCH')
  await verifyPipeArtifact(outputDir, { rid: 'win-x64', sourceHash: hash })
  const parent = resolve(outputParent)
  const root = await mkdtemp(join(parent, 'mimir-pipe-diagnostic-'))
  const cleanup = async () => {
    if (dirname(root) !== parent || !basename(root).startsWith('mimir-pipe-diagnostic-')) throw new Error('DIAGNOSTIC_CLEANUP_ESCAPE')
    await rm(root, { recursive: true, force: true })
  }
  try {
    const project = join(root, 'project'), app = join(root, 'app')
    await mkdir(project)
    for (const name of ['Program.cs', 'global.json', 'AssetsPipeHelper.csproj']) await writeFile(join(project, name), await readFile(join(projectDir, name)))
    await writeFile(join(project, 'AssetsNativePipe.cs'), source)
    const directory = join(app, '.native/assets-pipe-helper/win-x64')
    await publishPipeHelper({ projectDir: project, outputDir: directory, sdkExecutable: await sdkPath(), diagnosticOnly: true })
    const result = await verifyPipeArtifact(directory, { rid: 'win-x64', diagnosticOnly: true })
    return { ...result, root, appRoot: app, cleanup }
  } catch (error) { await cleanup(); throw error }
}
