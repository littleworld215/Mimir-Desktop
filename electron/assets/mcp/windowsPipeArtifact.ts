import { join } from 'node:path'
import { verifyPipeArtifact } from '../../../scripts/lib/assetsPipeArtifact.mjs'

/** Trusted application composition only; never accepted from IPC or MCP arguments. */
export type PipeArtifactLocation = { kind: 'development'; appRoot: string } | { kind: 'packaged'; resourcesPath: string }
export async function resolveWindowsPipeArtifact(location: PipeArtifactLocation, signal?: AbortSignal) {
  if (!location || (location.kind !== 'development' && location.kind !== 'packaged')) throw new Error('PIPE_ARTIFACT_INVALID')
  const directory = location.kind === 'development'
    ? join(location.appRoot, '.native', 'assets-pipe-helper', 'win-x64')
    : join(location.resourcesPath, 'assets-pipe-helper', 'win-x64')
  return verifyPipeArtifact(directory, { rid: 'win-x64' }, signal)
}
