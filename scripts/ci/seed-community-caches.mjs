import { execFileSync } from 'node:child_process'
import { constants, cpSync, existsSync, realpathSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, isAbsolute, relative, resolve, sep } from 'node:path'
import { pathToFileURL } from 'node:url'

/** Optional bootstrap from this runner's existing downloads. Never overwrite or prune either cache. */
export function seedCacheDirectory(source, target, { warn = console.warn } = {}) {
  try {
    if (!source || !existsSync(source)) return 'absent'
    const from = realpathSync(source)
    let ancestor = resolve(target)
    const missing = []
    while (!existsSync(ancestor)) { missing.unshift(basename(ancestor)); ancestor = dirname(ancestor) }
    const to = resolve(realpathSync(ancestor), ...missing)
    const contains = (parent, child) => {
      const path = relative(parent, child)
      return !path || (!path.startsWith(`..${sep}`) && path !== '..' && !isAbsolute(path))
    }
    if (contains(from, to) || contains(to, from)) return 'same-store'
    // APFS clones avoid copying package bytes; other filesystems use the normal copy fallback.
    cpSync(from, to, { recursive: true, force: false, errorOnExist: false, mode: constants.COPYFILE_FICLONE })
    return 'seeded'
  } catch (error) {
    // A missing/locked legacy cache does not make an otherwise valid clean installation fail.
    warn(`Local CI cache bootstrap unavailable (${error?.code ?? 'copy failed'}); normal install retained`)
    return 'unavailable'
  }
}

function main() {
  const root = process.env.GITHUB_WORKSPACE ?? process.cwd()
  if (process.env.PNPM_CACHE_HIT !== 'true') {
    try {
      const previous = execFileSync('pnpm', ['store', 'path', '--silent'], { encoding: 'utf8' }).trim()
      const next = execFileSync('pnpm', ['store', 'path', '--silent', '--store-dir', resolve(root, '.ci-cache/pnpm')], { encoding: 'utf8' }).trim()
      console.log(`Local pnpm cache bootstrap: ${seedCacheDirectory(previous, next)}`)
    } catch { console.warn('Local pnpm cache unavailable; normal install retained') }
  }
  if (process.env.ELECTRON_CACHE_HIT !== 'true') {
    const previous = process.platform === 'darwin' ? resolve(homedir(), 'Library/Caches/electron')
      : process.platform === 'linux' ? resolve(process.env.XDG_CACHE_HOME ?? resolve(homedir(), '.cache'), 'electron') : null
    console.log(`Local Electron cache bootstrap: ${seedCacheDirectory(previous, resolve(root, '.ci-cache/electron'))}`)
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) main()
