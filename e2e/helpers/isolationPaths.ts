import { isAbsolute, relative, resolve, sep } from 'path'
export function isInside(child: string, parent: string): boolean {
  const path = relative(resolve(parent), resolve(child))
  return path === '' || (!isAbsolute(path) && path !== '..' && !path.startsWith(`..${sep}`))
}
