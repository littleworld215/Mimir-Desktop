import { pipeSourceHash, verifyPipeArtifact } from './lib/assetsPipeArtifact.mjs'
import { projectDir, outputDir } from './prepareAssetsPipeHelper.mjs'
try {
  const artifact = await verifyPipeArtifact(outputDir, { rid: 'win-x64', sourceHash: await pipeSourceHash(projectDir) })
  console.log(JSON.stringify({ kind: 'pipe-helper-verified', files: artifact.manifest.files.length, sourceHash: artifact.manifest.sourceHash }))
} catch (error) { console.error(error); process.exitCode = 1 }
