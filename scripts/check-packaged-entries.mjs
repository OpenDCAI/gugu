#!/usr/bin/env node
// @@@installer-payload: reject runtime package entries removed by the packaging exclusions.
// Custom export conditions and type declarations are outside runtime resolution.
import { createRequire } from 'node:module'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
// Keep these categories aligned with the development-file exclusions in electron-builder.cjs.
const EXCLUDED = /\.(m|c)?ts$|\.(c|h|cc|cpp|hpp|iobj|ipdb|exp|ilk|obj|tlog)$|(^|\/)(test|tests|__tests__|__mocks__|spec)\/|\/build\/Release\/obj\/|\/build\/Release\/[^/]+\.lib$|\/build\/[^/]+\.(mk|gyp|gypi)$/
const RUNTIME_CONDITIONS = new Set(['node', 'require', 'import', 'default', 'node-addons', 'electron'])

export function* runtimeTargets(value, condition = '<root>') {
  if (typeof value === 'string') { yield { condition, target: value }; return }
  if (Array.isArray(value)) { for (const v of value) yield* runtimeTargets(v, condition); return }
  if (value && typeof value === 'object') {
    for (const [key, v] of Object.entries(value)) {
      if (key.startsWith('.')) yield* runtimeTargets(v, condition)
      else if (RUNTIME_CONDITIONS.has(key)) yield* runtimeTargets(v, key)
    }
  }
}

export function* binTargets(value) {
  if (typeof value === 'string') { yield { condition: '<bin>', target: value }; return }
  if (Array.isArray(value)) { for (const v of value) yield* binTargets(v); return }
  if (value && typeof value === 'object') {
    for (const [name, v] of Object.entries(value)) {
      for (const hit of binTargets(v)) yield { ...hit, condition: `<bin:${name}>` }
    }
  }
}

export function riskyEntries(pkg, { exists = () => true } = {}) {
  const found = []
  for (const field of ['main', 'module', 'bin', 'exports']) {
    if (!(field in pkg)) continue
    const targets = field === 'bin' ? binTargets(pkg[field]) : runtimeTargets(pkg[field])
    for (const { condition, target } of targets) {
      const relativeTarget = `/${target.replace(/^\.\//, '')}`
      const isMarkdownNotice = /^(license|notice|copying).*\.(md|markdown)$/i.test(path.posix.basename(target))
      const isDocumentation = /\.(md|markdown)$/.test(target) && !isMarkdownNotice
      if ((EXCLUDED.test(relativeTarget) || isDocumentation) && exists(target)) found.push({ field, condition, target })
    }
  }
  return found
}

function resolvePackageDir(name, fromDir) {
  const require_ = createRequire(path.join(fromDir, 'noop.js'))
  try {
    return path.dirname(require_.resolve(`${name}/package.json`))
  } catch {
    for (const base of [fromDir, repoRoot]) {
      const guess = path.join(base, 'node_modules', name)
      if (existsSync(path.join(guess, 'package.json'))) return guess
    }
    return null
  }
}

function scanUnpacked(root) {
  const risky = []
  let scanned = 0
  const stack = [root]
  while (stack.length > 0) {
    const dir = stack.pop()
    let entries
    try { entries = readdirSync(dir, { withFileTypes: true }) } catch { continue }
    if (entries.some((e) => e.isFile() && e.name === 'package.json')) {
      try {
        const pkg = JSON.parse(readFileSync(path.join(dir, 'package.json'), 'utf8'))
        scanned += 1
        // The excluded file is already absent in a packaged artifact; its declared entry is still broken.
        for (const hit of riskyEntries(pkg)) {
          risky.push({ package: pkg.name ?? '<anonymous>', dir: path.relative(root, dir), ...hit })
        }
      } catch { /* Invalid package manifests are not entry-point evidence. */ }
    }
    for (const e of entries) if (e.isDirectory() && !e.isSymbolicLink()) stack.push(path.join(dir, e.name))
  }
  return { risky, scanned }
}

function report(risky, scanned, mode) {
  if (risky.length > 0) {
    console.error(`[check-packaged-entries] ${risky.length} runtime entries reference files excluded by electron-builder(${mode}):`)
    for (const r of risky) console.error(`  ${r.package} (${r.dir}) ${r.field}[${r.condition}] → ${r.target}`)
    console.error('Remove the exclusion from electron-builder.cjs or explicitly include the required runtime file.')
    process.exitCode = 1
    return
  }
  console.log(`[check-packaged-entries] OK — ${mode}: scanned ${scanned} packages; no excluded runtime entries`)
}

function main() {
  const rootArg = process.argv.indexOf('--root')
  if (rootArg !== -1) {
    const rootValue = process.argv[rootArg + 1]
    if (!rootValue || rootValue.startsWith('--')) { console.error('--root requires an unpacked directory'); process.exitCode = 1; return }
    const root = path.resolve(rootValue)
    if (!existsSync(root)) { console.error(`--root does not exist: ${root}`); process.exitCode = 1; return }
    const { risky, scanned } = scanUnpacked(root)
    report(risky, scanned, 'unpacked directory')
    return
  }
  const rootPkg = JSON.parse(readFileSync(path.join(repoRoot, 'package.json'), 'utf8'))
  const queue = Object.keys(rootPkg.dependencies ?? {}).map((name) => ({ name, fromDir: repoRoot }))
  const seen = new Set()
  const risky = []
  let scanned = 0

  while (queue.length > 0) {
    const { name, fromDir } = queue.shift()
    const dir = resolvePackageDir(name, fromDir)
    if (dir === null || seen.has(dir)) continue
    seen.add(dir)
    let pkg
    try { pkg = JSON.parse(readFileSync(path.join(dir, 'package.json'), 'utf8')) } catch { continue }
    scanned += 1
    for (const hit of riskyEntries(pkg, { exists: (t) => existsSync(path.resolve(dir, t)) })) {
      risky.push({ package: name, dir: path.relative(repoRoot, dir), ...hit })
    }
    for (const dep of Object.keys(pkg.dependencies ?? {})) queue.push({ name: dep, fromDir: dir })
  }

  if (risky.length > 0) {
    report(risky, scanned, 'dependency tree')
    return
  }
  console.log(`[check-packaged-entries] OK — scanned ${scanned} production dependencies; no excluded runtime entries`)
  console.log('  Dependency traversal may not cover all packaged dependencies. Also run --root <unpacked directory> on the artifact.')
}

function selfTest() {
  const positives = [
    { main: './src/index.ts' },
    { exports: { '.': { require: './lib/a.ts', types: './lib/a.d.ts' } } },
    { bin: { tool: './test/run.js' } },
    { main: './README.md' },
    { main: './src/binding.cc' },
    ...['iobj', 'ipdb', 'exp', 'ilk', 'obj', 'tlog'].map((ext) => ({ main: `./build/output.${ext}` })),
    { main: './build/Release/binding.lib' },
    { main: 'build/Release/binding.lib' },
    ...['mk', 'gyp', 'gypi'].map((ext) => ({ main: `./build/binding.${ext}` })),
    { exports: { '.': { node: './build/Release/obj/gen/x.js' } } },
  ]
  const negatives = [
    { exports: { '.': { '@zod/source': './src/index.ts', default: './index.js' } } },
    { exports: { '.': { source: './src/index.ts', import: './dist/index.mjs' } } },
    { main: './dist/index.js', types: './dist/index.d.ts' },
    { main: './data/reference.lib' },
    { main: './build/Release/binding.node' },
    { main: './LICENSE' },
    { main: './LICENSE.md' },
    { main: './Notice.markdown' },
  ]
  let failed = 0
  positives.forEach((pkg, i) => {
    if (riskyEntries(pkg).length === 0) { console.error(`Positive control #${i} did not detect an excluded runtime entry`); failed += 1 }
  })
  negatives.forEach((pkg, i) => {
    const hits = riskyEntries(pkg)
    if (hits.length > 0) { console.error(`Negative control #${i} incorrectly reported ${JSON.stringify(hits)}`); failed += 1 }
  })
  if (failed > 0) { process.exitCode = 1; return }
  console.log(`[check-packaged-entries] self-test OK — ${positives.length} positive controls detected; ${negatives.length} negative controls clear`)
}

if (process.argv.includes('--self-test')) selfTest()
else main()
