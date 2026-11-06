import { lstat, readlink, realpath } from 'node:fs/promises'
import { dirname, isAbsolute, join, parse, resolve, sep } from 'node:path'
import { resolveGuguHome } from './paths'

/** One location shared by the private writer and all Agent file gateways. Never exposed as an MCP resource. */
export const privateServicePermissionDirectory = () => join(resolveGuguHome(), 'private-service-permissions')
export const PRIVATE_PERMISSION_STATE_REFUSAL = 'Agent file access to private permission state is forbidden'
const within = (file: string, directory: string) => {
  const target = resolve(file).toLowerCase(), root = resolve(directory).toLowerCase()
  return target === root || target.startsWith(root + sep)
}

/** Resolve every link entry, including a dangling final link, before comparing a future write target. */
async function canonicalTarget(file: string): Promise<string> {
  // Do not collapse ".." before following links: its parent is the resolved link target's parent.
  const absolute = isAbsolute(file) ? file : `${process.cwd()}${sep}${file}`
  const components = (value: string) => value.split(sep === '\\' ? /[\\/]+/ : /\/+/).filter(Boolean)
  let current = parse(absolute).root
  const pending = components(absolute.slice(current.length)).reverse()
  let links = 0
  while (pending.length) {
    const component = pending.pop()!
    if (component === '.') continue
    if (component === '..') { current = dirname(current); continue }
    const candidate = join(current, component)
    let entry
    try { entry = await lstat(candidate) }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      // The entry itself is absent. A dangling link would have been visible to lstat above.
      current = candidate
      continue
    }
    if (entry.isSymbolicLink()) {
      if (++links > 40) throw new Error('Too many symbolic links in Agent file path')
      const target = await readlink(candidate)
      if (isAbsolute(target)) {
        current = parse(target).root
        pending.push(...components(target.slice(current.length)).reverse())
      } else pending.push(...components(target).reverse())
    } else {
      // Canonical casing/platform aliases; a race that invalidates an existing entry fails closed.
      current = await realpath(candidate)
    }
  }
  return current
}

export async function agentFileBoundary() {
  const lexical = resolve(privateServicePermissionDirectory())
  const roots = [lexical, await canonicalTarget(lexical)]
  return {
    roots,
    excludes: (file: string) => roots.some(root => within(file, root)),
    // Whole-tree copy, move, replacement and trash would expose or alter private state through an ancestor.
    overlaps: (file: string) => roots.some(root => within(file, root) || within(root, file)),
  }
}

/** Independent of rollout/enforcement and of files.other grants. Caller uses the canonical result for I/O. */
export async function requireAgentFileAccess(file: string): Promise<string> {
  const boundary = await agentFileBoundary()
  if (boundary.excludes(file)) throw new Error(PRIVATE_PERMISSION_STATE_REFUSAL)
  const canonical = await canonicalTarget(file)
  if (boundary.excludes(canonical)) throw new Error(PRIVATE_PERMISSION_STATE_REFUSAL)
  return canonical
}
