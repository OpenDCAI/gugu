import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

export function readNodePin(rootDir = repoRoot) {
  const pin = readFileSync(path.join(rootDir, '.node-version'), 'utf8').trim().replace(/^v/, '')
  if (!pin) throw new Error(`.node-version is empty: ${path.join(rootDir, '.node-version')}`)
  return pin
}

export function assertNodeVersion({ rootDir = repoRoot, currentVersion = process.version } = {}) {
  const pin = readNodePin(rootDir)
  const current = String(currentVersion).trim().replace(/^v/, '')
  if (current !== pin) {
    throw new Error([
      `Node version mismatch: current version=v${current}`,
      `repository pin=${pin}`,
      'fix PATH to use the pinned Node from .node-version; preflight will not auto-switch toolchains',
    ].join('\n'))
  }
  return { current, pin }
}

export function runNodeVersionPreflight(rootDir = process.env.GUGU_NODE_VERSION_PREFLIGHT_ROOT ?? repoRoot) {
  const result = assertNodeVersion({ rootDir })
  console.log(`Node version matches repository pin: v${result.current}`)
  return result
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
if (isMain) {
  try {
    runNodeVersionPreflight()
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error))
    process.exitCode = 1
  }
}
