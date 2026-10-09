export interface ArchivePath { path: string; kind: 'file' | 'directory' }
interface Node { name: string; kind: 'file' | 'directory'; children: Map<string, Node> }

/** 格式用正斜杠；在所有平台按Windows约束验证，避免验包与恢复之间解释不同。 */
export function validateArchivePaths(entries: readonly ArchivePath[], maxEntries = 100_000) {
  if (entries.length > maxEntries) throw Error('ENTRY_LIMIT')
  const root: Node = { name: '', kind: 'directory', children: new Map() }
  const seen = new Set<string>()
  for (const entry of entries) {
    if (entry.kind !== 'file' && entry.kind !== 'directory') throw Error('INVALID_KIND')
    if (typeof entry.path !== 'string' || entry.path.length === 0 || entry.path.length > 4096) throw Error('INVALID_PATH')
    if (seen.has(entry.path)) throw Error('DUPLICATE_PATH')
    seen.add(entry.path)
    const parts = entry.path.split('/')
    let node = root
    for (let index = 0; index < parts.length; index++) {
      const name = parts[index]
      const deviceBase = name.split('.')[0].trimEnd()
      if (!name || name === '.' || name === '..' || /[<>:"\\|?*\u0000-\u001f\u007f]/.test(name) || /[. ]$/.test(name)
        || /^(CON|PRN|AUX|NUL|CLOCK\$|CONIN\$|CONOUT\$|COM[1-9¹²³]|LPT[1-9¹²³])$/i.test(deviceBase)) throw Error('INVALID_PATH')
      if (node.kind === 'file') throw Error('FILE_DIRECTORY_CONFLICT')
      const key = name.toUpperCase()
      const final = index === parts.length - 1
      let child = node.children.get(key)
      if (child && child.name !== name) throw Error('CASE_CONFLICT')
      if (child && final && entry.kind === 'file' && (child.kind === 'directory' || child.children.size > 0)) throw Error('FILE_DIRECTORY_CONFLICT')
      if (child && final && entry.kind === 'directory' && child.kind === 'file') throw Error('FILE_DIRECTORY_CONFLICT')
      if (!child) {
        child = { name, kind: final ? entry.kind : 'directory', children: new Map() }
        node.children.set(key, child)
      }
      node = child
    }
  }
}
