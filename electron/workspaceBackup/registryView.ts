import { lstatSync, readFileSync } from 'node:fs'
import { isAbsolute, join } from 'node:path'

export interface RegistrySpaceView { id: string; name: string }
function entry(path: string) {
  try { return lstatSync(path) }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw error
  }
}
/** 不复用loadStore：它会自动迁移、创建默认空间和写全局指针。 */
export function readRegistryOverview(home: string): RegistrySpaceView[] {
  const directory = join(home, '.mimir'), path = join(directory, 'store.json')
  const control = entry(directory)
  if (!control) return []
  if (!control.isDirectory() || control.isSymbolicLink()) throw Error('REGISTRY_INVALID')
  const file = entry(path)
  if (!file) return []
  if (!file.isFile() || file.isSymbolicLink() || file.size > 64 * 1024 * 1024) throw Error('REGISTRY_INVALID')
  const value: unknown = JSON.parse(readFileSync(path, 'utf8'))
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw Error('REGISTRY_INVALID')
  const spaces = (value as Record<string, unknown>)['workspaces:list']
  if (spaces === undefined) return []
  if (!Array.isArray(spaces) || spaces.length > 100_000) throw Error('REGISTRY_INVALID')
  const ids = new Set<string>()
  return spaces.map(space => {
    if (!space || typeof space !== 'object' || typeof space.id !== 'string' || !space.id
      || typeof space.name !== 'string' || typeof space.path !== 'string' || !isAbsolute(space.path)
      || ids.has(space.id)) throw Error('REGISTRY_INVALID')
    ids.add(space.id)
    return { id: space.id, name: space.name }
  })
}
