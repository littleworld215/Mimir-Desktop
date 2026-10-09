#!/usr/bin/env node
// Audit the actual archive and unpacked binding, not the builder configuration.
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { readFileSync, readdirSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { dirname, join, normalize, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { auditPackagedPipeHelper } from './lib/packageAssetsPipeHelper.mjs'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const require = createRequire(import.meta.url)
const asar = createRequire(require.resolve('electron-builder'))('@electron/asar')
const resources = resolve(process.argv[2] ?? 'dist/win-unpacked/resources')
const version = JSON.parse(readFileSync(join(root, 'node_modules/electron/package.json'), 'utf8')).version
const hash = bytes => createHash('sha256').update(bytes).digest('hex')
const archive = join(resources, 'app.asar')
const entries = asar.listPackage(archive).map(name => name.replaceAll('\\', '/').replace(/^\//, ''))
for (const entry of entries) {
  assert(entry === 'LICENSE' || entry === 'package.json' || entry === 'out' || entry.startsWith('out/') || entry === 'node_modules' || entry.startsWith('node_modules/'), `Unexpected packaged project file: ${entry}`)
  assert(!/\.(db|sqlite|sqlite3)(-(wal|shm|journal))?$/i.test(entry), `Database inside package: ${entry}`)
  assert(!entry.startsWith('out/') || !entry.endsWith('.tsbuildinfo'), `Project build cache inside package: ${entry}`)
  if (entry.startsWith('out/') && !asar.statFile(archive, normalize(entry)).files) {
    assert.equal(hash(asar.extractFile(archive, normalize(entry))), hash(readFileSync(join(root, entry))), `Packaged output differs from current build: ${entry}`)
  }
}
const bindingRelative = 'node_modules/better-sqlite3/build/Release/better_sqlite3.node'
const bindingEntries = entries.filter(entry => entry.endsWith('/better_sqlite3.node'))
assert.deepEqual(bindingEntries, [bindingRelative], 'Exactly one SQLite binary must be shipped')
const unpacked = join(resources, 'app.asar.unpacked')
const expected = readFileSync(join(root, '.native', `electron-${version}`, `${process.platform}-${process.arch}`, 'better_sqlite3.node'))
assert.equal(hash(readFileSync(join(unpacked, bindingRelative))), hash(expected), 'Packaged binding differs from Electron cache')
const nodeHash = hash(readFileSync(join(dirname(require.resolve('better-sqlite3/package.json')), 'build/Release/better_sqlite3.node')))
assert.notEqual(hash(expected), nodeHash, 'Electron and Node bindings unexpectedly identical')
function auditUnpacked(dir) {
  for (const item of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, item.name)
    if (item.isDirectory()) auditUnpacked(path)
    else {
      assert(!/\.(db|sqlite|sqlite3)(-(wal|shm|journal))?$/i.test(item.name), `Database in unpacked resources: ${path}`)
      if (item.name.endsWith('.node')) assert.notEqual(hash(readFileSync(path)), nodeHash, `Node SQLite binding inside artifact: ${path}`)
    }
  }
}
auditUnpacked(resources)
const pipeHelper = await auditPackagedPipeHelper({ projectDir: root, resourcesDir: resources, platform: process.platform, arch: process.arch })
console.log(JSON.stringify({ result: 'PASS', entries: entries.length, electron: version, platform: process.platform, arch: process.arch, pipeHelper, sqliteBindingSha256: hash(expected), nodeBindingSha256: nodeHash, projectRoots: [...new Set(entries.filter(entry => !entry.startsWith('node_modules/')).map(entry => entry.split('/')[0]))] }, null, 2))
