import { existsSync, readdirSync, statSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

export function verifyMacDmg(releaseDir = 'release') {
  const root = resolve(releaseDir)
  const fail = (message) => new Error(`packaging stage (not renderer compilation): ${message}`)
  if (!existsSync(root)) throw fail(`release directory is missing: ${root}`)
  const candidates = readdirSync(root)
    .filter((name) => /arm64\.dmg$/.test(name))
    .map((name) => join(root, name))
    .filter((path) => statSync(path).isFile())
  if (candidates.length !== 1) {
    throw fail(`expected exactly one macOS arm64 DMG, found ${candidates.length} in ${root}`)
  }
  const [dmg] = candidates
  const size = statSync(dmg).size
  if (size === 0) throw fail(`macOS arm64 DMG is empty: ${dmg}`)
  return { path: dmg, size }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const result = verifyMacDmg(process.argv[2] ?? 'release')
    console.log(`[pr-dmg] verified ${result.path} (${result.size} bytes)`)
  } catch (error) {
    console.error(`[pr-dmg] ${error instanceof Error ? error.message : String(error)}`)
    process.exitCode = 1
  }
}
