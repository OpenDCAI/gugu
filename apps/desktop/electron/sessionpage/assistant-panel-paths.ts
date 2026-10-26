import { lstat, mkdir, realpath } from 'node:fs/promises'
import { isAbsolute, relative, resolve, sep } from 'node:path'

function inside(root: string, target: string): boolean {
  const rest = relative(root,target)
  return rest === '' || (!isAbsolute(rest) && rest !== '..' && !rest.startsWith(`..${sep}`))
}

/** Validate both lexical components and the real existing parent chain. An
 * absent child must not hide an existing symlink farther up the path. */
export async function assistantPanelPath(root: string, path: unknown, options: { home: string; createParents?: boolean }): Promise<string> {
  if (typeof path !== 'string' || !path || path.length > 4096
    || /(^[/~]|[\\:%]|(^|\/)\.{1,2}(\/|$)|\/\/|\/$)/.test(path)
    || [...path].some(character => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127)) {
    throw new Error('PANEL_PATH_INVALID')
  }
  const home = resolve(options.home), base = resolve(root), target = resolve(base,path)
  if (!inside(home,base) || target === base || !inside(base,target)) throw new Error('PANEL_PATH_OUTSIDE_HOME')
  const actualHome = await realpath(home)
  const rootParts = relative(home,base).split(sep).filter(Boolean)
  const segments = [...rootParts,...path.split('/')]
  let current = home, actualBase = actualHome
  for (let index = 0; index < segments.length; index++) {
    current = resolve(current,segments[index]!)
    let actual: string | null = null
    try {
      const info = await lstat(current)
      actual = await realpath(current)
      if (index < segments.length - 1 && !info.isDirectory() && !info.isSymbolicLink()) throw new Error('PANEL_PATH_NOT_DIRECTORY')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      if (options.createParents && index < segments.length - 1) {
        await mkdir(current,{ mode: 0o700 })
        actual = await realpath(current)
      }
    }
    if (actual && (!inside(actualHome,actual) || index >= rootParts.length && !inside(actualBase,actual))) {
      throw new Error('PANEL_PATH_OUTSIDE_HOME')
    }
    if (index === rootParts.length - 1 && actual) actualBase = actual
  }
  return target
}
