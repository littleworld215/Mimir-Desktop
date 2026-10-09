import { basename, dirname, resolve } from 'node:path'

/** Probe input is the explicitly selected build root, never a client parameter. */
export function artifactLocationForRoot(root) {
  const absolute = resolve(root)
  return basename(absolute).toLowerCase() === 'app.asar'
    ? { kind: 'packaged', resourcesPath: dirname(absolute) }
    : { kind: 'development', appRoot: absolute }
}
