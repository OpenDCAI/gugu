import { realpath } from 'node:fs/promises'
import { dirname, join, resolve, sep, basename } from 'node:path'
import { resolveGuguHome } from './paths'

/** One location shared by the private writer and all Agent file gateways. Never exposed as an MCP resource. */
export const privateServicePermissionDirectory = () => join(resolveGuguHome(), 'private-service-permissions')
export const PRIVATE_PERMISSION_STATE_REFUSAL = 'Agent file access to private permission state is forbidden'
const within = (file: string, directory: string) => {
  const target = resolve(file).toLowerCase(), root = resolve(directory).toLowerCase()
  return target === root || target.startsWith(root + sep)
}

/** Canonicalize even an absent write destination, following the nearest existing ancestor. */
async function canonicalTarget(file: string): Promise<string> {
  let current = resolve(file)
  const rest: string[] = []
  for (;;) {
    try { return join(await realpath(current), ...[...rest].reverse()) }
    catch (error) {
      if (!['ENOENT', 'ENOTDIR'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error
      const parent = dirname(current)
      if (parent === current) throw error
      rest.push(basename(current))
      current = parent
    }
  }
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
