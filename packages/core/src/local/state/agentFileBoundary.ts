import { lstat, readdir, readlink, realpath, stat } from 'node:fs/promises'
import { dirname, isAbsolute, join, parse, resolve, sep } from 'node:path'
import { privateStorageBoundaryRegistrations, protectedPrivateStorages } from './protectedPrivateStorage'

export { privateServicePermissionDirectory } from './protectedPrivateStorage'
export const PRIVATE_PERMISSION_STATE_REFUSAL = 'Agent file access to protected private storage is forbidden'
const within = (file: string, directory: string) => {
  const target = resolve(file).toLowerCase(), root = resolve(directory).toLowerCase()
  return target === root || target.startsWith(root.endsWith(sep) ? root : root + sep)
}
const identity = (file: { dev: bigint; ino: bigint }) => `${file.dev}:${file.ino}`
const missing = (error: unknown) => (error as NodeJS.ErrnoException).code === 'ENOENT'

/** Fresh per operation; no stale allow cache when a private journal or switch is replaced. */
async function protectedFileIdentities(roots: readonly string[]) {
  const files = new Map<string, { links: bigint; names: bigint }>()
  const seen = new Set<string>()
  let visited = 0
  const walk = async (file: string): Promise<void> => {
    if (seen.has(file)) return
    seen.add(file)
    const info = await lstat(file, { bigint: true }).catch(error => { if (missing(error)) return null; throw new Error('Private permission state could not be verified') })
    if (!info) return
    if (++visited > 10_000 || info.isSymbolicLink()) throw new Error('Private permission state could not be verified')
    if (info.isDirectory()) {
      for (const name of await readdir(file)) await walk(join(file, name))
    } else if (info.isFile()) {
      const key = identity(info), prior = files.get(key)
      files.set(key, { links: info.nlink, names: (prior?.names ?? 0n) + 1n })
    } else throw new Error('Private permission state could not be verified')
  }
  for (const root of roots) await walk(root)
  return { files, externalLinks: [...files.values()].some(file => file.links > file.names) }
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
  let declared: string[]
  let canonicalRoots: string[]
  let protectedFiles: Awaited<ReturnType<typeof protectedFileIdentities>>
  try {
    declared = privateStorageBoundaryRegistrations().flatMap(storage => storage.paths)
    canonicalRoots = [...new Set(await Promise.all(declared.map(canonicalTarget)))]
    protectedFiles = await protectedFileIdentities(canonicalRoots)
  } catch {
    // Do not expose private filenames or raw filesystem errors through a failed Agent operation.
    throw new Error('Protected private storage is unavailable')
  }
  const roots = [...new Set([...declared.map(file => resolve(file)), ...canonicalRoots])]
  return {
    roots,
    excludes: (file: string) => roots.some(root => within(file, root)),
    // Whole-tree copy, move, replacement and trash would expose or alter private state through an ancestor.
    overlaps: (file: string) => roots.some(root => within(file, root) || within(root, file)),
    async assertIdentity(file: string) {
      const info = await stat(file, { bigint: true }).catch(error => { if (missing(error)) return null; throw error })
      if (info && protectedFiles.files.has(identity(info))) throw new Error(PRIVATE_PERMISSION_STATE_REFUSAL)
    },
    /** cp/rg preserve nested links; consumers such as browser directory upload must also inspect their targets. */
    async assertTree(file: string, skip: (path: string) => boolean = () => false, followLinks = false) {
      if (!protectedFiles.externalLinks && !followLinks) return
      let visited = 0
      const seen = new Set<string>(), active = new Set<string>()
      const walk = async (target: string): Promise<void> => {
        if (skip(target)) return
        let info = await lstat(target, { bigint: true }).catch(error => { if (missing(error)) return null; throw error })
        if (!info) return
        if (info.isSymbolicLink()) {
          if (!followLinks) return
          target = await canonicalTarget(target)
          if (roots.some(root => within(target, root) || within(root, target))) throw new Error(PRIVATE_PERMISSION_STATE_REFUSAL)
          info = await lstat(target, { bigint: true }).catch(error => { if (missing(error)) return null; throw error })
          if (!info) return
          if (info.isSymbolicLink()) throw new Error('Agent file tree could not be verified against private permission state')
        }
        if (++visited > 10_000) throw new Error('Agent file tree could not be verified against private permission state')
        if (protectedFiles.files.has(identity(info))) throw new Error(PRIVATE_PERMISSION_STATE_REFUSAL)
        if (!info.isDirectory()) return
        if (active.has(target)) throw new Error('Agent file tree could not be verified against private permission state')
        if (seen.has(target)) return
        seen.add(target)
        active.add(target)
        try { for (const name of await readdir(target)) await walk(join(target, name)) }
        finally { active.delete(target) }
      }
      await walk(file)
    },
  }
}

/** Trusted features must check immediately before saving/using private material; an absent registration is not safety. */
export async function protectedPrivateStorageStatus(id: string): Promise<
  { status: 'ready' } | { status: 'unavailable'; reason: 'not_registered' | 'protection_unavailable' }
> {
  try {
    if (!protectedPrivateStorages().some(storage => storage.id === id)) return { status: 'unavailable', reason: 'not_registered' }
    await agentFileBoundary()
    return { status: 'ready' }
  } catch {
    return { status: 'unavailable', reason: 'protection_unavailable' }
  }
}

/** Independent of rollout/enforcement and of files.other grants. Caller uses the canonical result for I/O. */
export async function requireAgentFileAccess(file: string, knownBoundary?: Awaited<ReturnType<typeof agentFileBoundary>>): Promise<string> {
  const boundary = knownBoundary ?? await agentFileBoundary()
  if (boundary.excludes(file)) throw new Error(PRIVATE_PERMISSION_STATE_REFUSAL)
  const canonical = await canonicalTarget(file)
  if (boundary.excludes(canonical)) throw new Error(PRIVATE_PERMISSION_STATE_REFUSAL)
  await boundary.assertIdentity(canonical)
  return canonical
}

/** A delegated workspace/archive/upload may access its whole tree, so an excluded descendant also forbids delegation. */
export async function requireAgentFileTreeAccess(file: string, options: { followLinks?: boolean } = {}): Promise<string> {
  const boundary = await agentFileBoundary()
  const canonical = await requireAgentFileAccess(file, boundary)
  if (boundary.overlaps(canonical)) throw new Error(PRIVATE_PERMISSION_STATE_REFUSAL)
  await boundary.assertTree(canonical, undefined, options.followLinks)
  return canonical
}
