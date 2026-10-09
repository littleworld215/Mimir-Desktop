import { spawn } from 'node:child_process'
import { access, copyFile, lstat, mkdir, mkdtemp, readFile, realpath, rename, rm, writeFile } from 'node:fs/promises'
import { dirname, join, parse, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { randomUUID } from 'node:crypto'
import { createPipeManifest, pipeSourceHash, verifyPipeArtifact } from './lib/assetsPipeArtifact.mjs'

export const appRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
export const projectDir = join(appRoot, 'native', 'assets-pipe-helper')
export const outputDir = join(appRoot, '.native', 'assets-pipe-helper', 'win-x64')
function run(executable, args, cwd) {
  const drive = parse(process.env.SystemRoot ?? process.env.WINDIR ?? process.cwd()).root
  return new Promise((resolveResult, reject) => {
    const child = spawn(executable, args, { cwd, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env,
        ProgramFiles: process.env.ProgramFiles ?? join(drive, 'Program Files'),
        'ProgramFiles(x86)': process.env['ProgramFiles(x86)'] ?? join(drive, 'Program Files (x86)'),
        ProgramData: process.env.ProgramData ?? join(drive, 'ProgramData'),
        ALLUSERSPROFILE: process.env.ALLUSERSPROFILE ?? join(drive, 'ProgramData'),
        NUGET_PACKAGES: process.env.NUGET_PACKAGES ?? join(process.env.LOCALAPPDATA, 'MimirBuildTools', 'nuget', 'packages'),
        DOTNET_CLI_HOME: join(process.env.LOCALAPPDATA, 'MimirBuildTools', 'dotnet-home'),
        DOTNET_CLI_TELEMETRY_OPTOUT: '1', DOTNET_SKIP_FIRST_TIME_EXPERIENCE: '1', DOTNET_NOLOGO: '1' } })
    let output = ''
    for (const stream of [child.stdout, child.stderr]) stream.on('data', chunk => { if (output.length < 262144) output += chunk.toString() })
    child.once('error', reject)
    child.once('close', code => code === 0 ? resolveResult(output) : reject(new Error(`PIPE_HELPER_BUILD_FAILED ${code}\n${output}`)))
  })
}
export async function sdkPath() {
  const lock = JSON.parse(await readFile(join(projectDir, 'global.json'), 'utf8'))
  const local = join(process.env.LOCALAPPDATA ?? '', 'MimirBuildTools', 'dotnet', lock.sdk.version, 'dotnet.exe')
  await access(local)
  return local
}
export async function publishPipeHelper({ projectDir, outputDir, sdkExecutable, diagnosticOnly = false }) {
  const parent = resolve(dirname(outputDir))
  await mkdir(parent, { recursive: true })
  const physical = await realpath(parent)
  if (physical.toLowerCase() !== parent.toLowerCase()) throw new Error('PIPE_HELPER_OUTPUT_ESCAPE')
  const lockDir = join(parent, '.publish-lock')
  await mkdir(lockDir)
  let staging
  try {
    const existing = await lstat(outputDir).catch(error => { if (error.code !== 'ENOENT') throw error; return null })
    if (existing && (!existing.isDirectory() || existing.isSymbolicLink() || (await realpath(outputDir)).toLowerCase() !== resolve(outputDir).toLowerCase())) throw new Error('PIPE_HELPER_OUTPUT_ESCAPE')
    // A failed new build must never leave a previous manifest looking current.
    await rm(join(outputDir, 'manifest.json'), { force: true })
    sdkExecutable ??= await sdkPath()
    const lock = JSON.parse(await readFile(join(projectDir, 'global.json'), 'utf8'))
    const version = (await run(sdkExecutable, ['--version'], projectDir)).trim()
    if (version !== lock.sdk.version || lock.sdk.rollForward !== 'disable' || lock.sdk.allowPrerelease !== false) throw new Error('PIPE_HELPER_SDK_MISMATCH')
    const config = await readFile(join(projectDir, 'AssetsPipeHelper.csproj'), 'utf8')
    const runtimeVersion = config.match(/<RuntimeFrameworkVersion>(10\.\d+\.\d+)<\/RuntimeFrameworkVersion>/)?.[1]
    if (!runtimeVersion) throw new Error('PIPE_HELPER_RUNTIME_NOT_PINNED')
    staging = await mkdtemp(join(parent, '.publish-'))
    const publish = join(staging, 'publish')
    await run(sdkExecutable, ['publish', 'AssetsPipeHelper.csproj', '-c', 'Release', '-r', 'win-x64', '--self-contained', 'true', '-o', publish,
      `-p:BaseIntermediateOutputPath=${join(staging, 'obj')}/`, `-p:BaseOutputPath=${join(staging, 'bin')}/`], projectDir)
    const packages = process.env.NUGET_PACKAGES ?? join(process.env.LOCALAPPDATA, 'MimirBuildTools', 'nuget', 'packages')
    const runtimePackage = join(packages, 'microsoft.netcore.app.runtime.win-x64', runtimeVersion)
    await copyFile(join(runtimePackage, 'LICENSE.TXT'), join(publish, 'LICENSE.txt'))
    await copyFile(join(runtimePackage, 'THIRD-PARTY-NOTICES.TXT'), join(publish, 'THIRD-PARTY-NOTICES.txt'))
    const manifest = await createPipeManifest(publish, { protocolVersion: 1, rid: 'win-x64', entry: 'Mimir.AssetsPipeHelper.exe',
      sdkVersion: version, runtimeVersion, sourceHash: await pipeSourceHash(projectDir), ...(diagnosticOnly ? { diagnosticOnly: true } : {}) })
    await writeFile(join(publish, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n')
    await verifyPipeArtifact(publish, { rid: 'win-x64', sourceHash: manifest.sourceHash, ...(diagnosticOnly ? { diagnosticOnly: true } : {}) })
    const retired = join(parent, `.retired-${randomUUID()}`)
    let hadPrevious = false
    try { await access(outputDir); hadPrevious = true } catch { }
    if (hadPrevious) await rename(outputDir, retired)
    try { await rename(publish, outputDir) } catch (error) {
      if (hadPrevious) await rename(retired, outputDir)
      throw error
    }
    if (hadPrevious && dirname(retired) === parent) await rm(retired, { recursive: true, force: true })
    console.log(JSON.stringify({ kind: 'pipe-helper-published', sdkVersion: version, runtimeVersion, files: manifest.files.length,
      bytes: manifest.files.reduce((sum, file) => sum + file.size, 0), sourceHash: manifest.sourceHash }))
  } finally {
    if (staging && dirname(staging) === parent) await rm(staging, { recursive: true, force: true })
    await rm(lockDir, { recursive: true, force: true })
  }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    if (process.platform !== 'win32' || process.arch !== 'x64' || process.argv.length !== 2) throw new Error('PIPE_HELPER_UNSUPPORTED_PLATFORM')
    await publishPipeHelper({ projectDir, outputDir })
  } catch (error) { console.error(error); process.exitCode = 1 }
}
