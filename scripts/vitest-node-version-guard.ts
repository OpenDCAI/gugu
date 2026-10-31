import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { assertNodeVersion } from './node-version-preflight.mts'

export const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

export function assertVitestNodeVersion(
  currentVersion = process.version,
  rootDir = repositoryRoot
): { current: string; pin: string } {
  return assertNodeVersion({ rootDir, currentVersion })
}

export default function vitestNodeVersionGuard(): void {
  assertVitestNodeVersion()
}
