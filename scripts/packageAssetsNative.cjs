// afterPack runs before signing. Keep Node's test binding untouched and replace
// only the unpacked artifact with the exact Electron/platform/architecture cache.
const { copyFile, stat } = require('node:fs/promises')
const { join } = require('node:path')

module.exports = async function packageAssetsNative(context) {
  // electron-builder Arch enum: ia32=0, x64=1, armv7l=2, arm64=3.
  // Universal output needs an explicit merged binary; never choose one silently.
  const arch = ['ia32', 'x64', 'armv7l', 'arm64'][context.arch]
  if (!arch) throw new Error(`Unsupported asset native package architecture: ${context.arch}`)
  const version = context.packager.info.framework.version
  const platform = context.electronPlatformName
  const source = join(context.packager.projectDir, '.native', `electron-${version}`, `${platform}-${arch}`, 'better_sqlite3.node')
  const destination = join(context.packager.getResourcesDir(context.appOutDir), 'app.asar.unpacked', 'node_modules', 'better-sqlite3', 'build', 'Release', 'better_sqlite3.node')
  const info = await stat(source).catch(() => null)
  if (!info?.isFile() || info.size === 0) {
    throw new Error(`Electron native binding missing or empty: ${source}. Prepare the matching cache with scripts/prepareAssetsNative.mjs before packaging.`)
  }
  // The packager must already have collected this production dependency.
  const output = await stat(destination).catch(() => null)
  if (!output?.isFile()) throw new Error(`Packaged better-sqlite3 binding not found: ${destination}`)
  await copyFile(source, destination)
  console.log(`[assets-native] Packaged Electron ${version} ${platform}-${arch} binding`)
}
