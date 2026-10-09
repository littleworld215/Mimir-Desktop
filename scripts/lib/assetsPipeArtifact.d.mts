export interface PipeArtifactManifest {
  protocolVersion: 1
  rid: 'win-x64'
  entry: 'Mimir.AssetsPipeHelper.exe'
  sdkVersion: string
  runtimeVersion: string
  sourceHash: string
  diagnosticOnly?: true
  files: Array<{ path: string; size: number; sha256: string }>
}
export function createPipeManifest(directory: string, metadata: Omit<PipeArtifactManifest, 'files'>): Promise<PipeArtifactManifest>
export function verifyPipeArtifact(directory: string, expected: { rid: 'win-x64'; sourceHash?: string; diagnosticOnly?: true }, signal?: AbortSignal): Promise<{ executable: string; manifest: PipeArtifactManifest }>
export function pipeSourceHash(projectDir: string): Promise<string>
