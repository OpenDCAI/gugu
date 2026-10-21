export const STASH_SUFFIX: string
export function packageRoot(name: string, req?: NodeJS.Require): string
export function stashBuild(pkgDir: string): void
export function restoreBuild(pkgDir: string): boolean
export function snapshotEntries(pkgDir: string): Set<string>
export function removeNewEntries(pkgDir: string, before: Set<string>): string[]
