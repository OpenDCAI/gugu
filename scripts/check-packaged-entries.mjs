#!/usr/bin/env node
import { createRequire } from 'node:module'
import { existsSync, readdirSync, readFileSync, realpathSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import exclusions from './packaged-file-exclusions.cjs'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const require = createRequire(import.meta.url)
const builderRequire = createRequire(require.resolve('electron-builder'))
const { minimatch } = createRequire(builderRequire.resolve('app-builder-lib'))('minimatch')
const runtimeConditions = new Set(['node', 'require', 'import', 'default', 'node-addons', 'electron'])

function targets(value, conditional) {
  if (typeof value === 'string') return [value]
  if (Array.isArray(value)) return value.flatMap((v) => targets(v, conditional))
  return Object.entries(value ?? {}).filter(([key]) => !conditional || key.startsWith('.') || runtimeConditions.has(key))
    .flatMap(([, v]) => targets(v, conditional))
}

export function riskyEntries(pkg, exists = () => true) {
  return ['main', 'module', 'bin', 'exports'].flatMap((field) => targets(pkg[field], field !== 'bin')
    .filter((target) => exists(target) && exclusions.some((glob) => minimatch(
      path.posix.join('node_modules', pkg.name ?? 'package', target), glob.slice(1), { dot: true },
    ))).map((target) => ({ field, target })))
}

function dependencies(pkg, fromDir) {
  return Object.keys({ ...pkg.dependencies, ...pkg.optionalDependencies })
    .map((name) => ({ name, fromDir, optional: Object.hasOwn(pkg.optionalDependencies ?? {}, name) }))
}

function resolvePackageDir({ name, fromDir, optional }) {
  for (const base of createRequire(path.join(fromDir, 'package.json')).resolve.paths(`${name}/package.json`) ?? []) {
    const dir = path.join(base, name)
    if (existsSync(dir)) return realpathSync(dir)
  }
  if (optional) return null
  throw new Error(`Cannot resolve required production dependency ${name} from ${fromDir}`)
}

export function scan(root, unpacked) {
  const queue = unpacked ? [root] : dependencies(JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8')), root)
  const seen = new Set(), risky = []
  let scanned = 0
  while (queue.length) {
    const item = queue.pop()
    const dir = unpacked ? item : resolvePackageDir(item)
    if (!dir || seen.has(dir)) continue // Only explicitly optional dependencies may be absent.
    seen.add(dir)
    const manifest = path.join(dir, 'package.json')
    if (!unpacked || existsSync(manifest)) {
      const pkg = JSON.parse(readFileSync(manifest, 'utf8'))
      scanned += 1
      // Artifact targets may already have been removed by packaging.
      for (const hit of riskyEntries(pkg, unpacked ? undefined : (t) => existsSync(path.resolve(dir, t)))) {
        risky.push(`${pkg.name ?? dir} ${hit.field} -> ${hit.target}`)
      }
      if (!unpacked) queue.push(...dependencies(pkg, dir))
    }
    if (unpacked) queue.push(...readdirSync(dir, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => path.join(dir, e.name)))
  }
  if (risky.length) throw new Error(`Runtime entries reference excluded files:\n${risky.join('\n')}`)
  return scanned
}

if (path.resolve(process.argv[1] ?? '') === fileURLToPath(import.meta.url)) {
  try {
    const args = process.argv.slice(2)
    if (args.length && (args.length !== 2 || args[0] !== '--root' || args[1].startsWith('--'))) throw new Error('Usage: check-packaged-entries.mjs [--root <unpacked directory>]')
    const unpacked = args.length === 2
    const root = unpacked ? path.resolve(args[1]) : repoRoot
    console.log(`[check-packaged-entries] scanned ${scan(root, unpacked)} packages; no excluded runtime entries`)
    if (!unpacked) console.log('Also run --root <unpacked directory> on the packaged artifact for complete coverage.')
  } catch (error) {
    console.error(`[check-packaged-entries] ${error.message}`)
    process.exitCode = 1
  }
}
