import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'
import { afterEach, describe, expect, it } from 'vitest'
import { build, type InlineConfig } from 'vite'
import { devNodeExternals } from '../../../scripts/build/dev-node-externals.mjs'

const cleanup: Array<() => void | Promise<void>> = []
afterEach(async () => {
  for (const dispose of cleanup.splice(0).reverse()) await dispose()
})

function fixture(): string {
  const root = mkdtempSync(join(tmpdir(), 'gugu-dev-externals-'))
  cleanup.push(() => rmSync(root, { recursive: true, force: true }))
  const files = {
    'package.json': JSON.stringify({ name: 'fixture' }),
    'entry.ts': 'import { sep } from "node:path"; import { legacy } from "legacy-dep"; import { value } from "runtime-dep/sub"; import { scoped } from "@fixture/runtime"; import { linked } from "linked-dep"; import { other } from "runtime-dependency"; import { own } from "./own"; export const answer = [value, scoped, linked, other, own, legacy]; export const separator = sep',
    'node_modules/legacy-dep/package.json': JSON.stringify({ name: 'legacy-dep', main: 'index.js' }),
    'node_modules/legacy-dep/index.js': 'exports.legacy = require("runtime-dep/sub").value',
    'own.ts': 'export const own = 91003',
    'node_modules/runtime-dep/package.json': JSON.stringify({ name: 'runtime-dep', main: 'sub.js' }),
    'node_modules/runtime-dep/sub.js': 'exports.value = 71001',
    'node_modules/@fixture/runtime/package.json': JSON.stringify({ name: '@fixture/runtime', type: 'module', main: 'index.js' }),
    'node_modules/@fixture/runtime/index.js': 'export const scoped = 71002',
    'node_modules/linked-dep/package.json': JSON.stringify({ name: 'linked-dep', main: 'index.js' }),
    'node_modules/linked-dep/index.js': 'exports.linked = 81002',
    'node_modules/runtime-dependency/package.json': JSON.stringify({ name: 'runtime-dependency', main: 'index.js' }),
    'node_modules/runtime-dependency/index.js': 'exports.other = 81003',
  }
  for (const [file, code] of Object.entries(files)) {
    mkdirSync(join(root, file, '..'), { recursive: true })
    writeFileSync(join(root, file), code)
  }
  return root
}

function configuration(root: string, watch: boolean): InlineConfig {
  return {
    root,
    configFile: false,
    publicDir: false,
    logLevel: 'silent',
    plugins: [devNodeExternals({
      dependencies: { 'runtime-dep': '^1.0.0', 'linked-dep': 'workspace:*' },
      devDependencies: { '@fixture/runtime': '^1.0.0' },
    })],
    build: {
      watch: watch ? {} : null,
      minify: false,
      outDir: 'out',
      lib: { entry: join(root, 'entry.ts'), formats: ['cjs'], fileName: () => 'bundle.cjs' },
      rollupOptions: { external: [/^node:path$/] },
    },
  }
}

function runArtifact(root: string): unknown {
  // A fresh Node process matches Electron restarting after a main-process rebuild.
  // It also avoids the test runner's own CJS module cache when the output path is reused.
  return JSON.parse(execFileSync(process.execPath, [
    '-e', 'process.stdout.write(JSON.stringify(require("./out/bundle.cjs").answer))',
  ], { cwd: root, encoding: 'utf8' }))
}

describe('Electron development dependency externalization', () => {
  it('leaves installed packages to Node, keeps local source bundled, and rebuilds source changes', async () => {
    const root = fixture()
    const watcher = await build(configuration(root, true))
    if (!('on' in watcher)) throw new Error('Expected a Rollup watcher')
    cleanup.push(() => watcher.close())
    const completed = () => new Promise<void>((resolve, reject) => {
      watcher.on('event', (event) => {
        if (event.code === 'BUNDLE_END') resolve()
        if (event.code === 'ERROR') reject(event.error)
      })
    })
    await completed()
    const output = () => readFileSync(join(root, 'out/bundle.cjs'), 'utf8')
    expect(output()).toMatch(/require\(['"]runtime-dep\/sub['"]\)/)
    expect(output()).toMatch(/require\(['"]@fixture\/runtime['"]\)/)
    expect(output()).not.toContain('71001')
    expect(output()).not.toContain('71002')
    expect(output()).toContain('81002')
    expect(output()).toContain('81003')
    expect(output()).toContain('91003')
    expect(runArtifact(root)).toEqual([71001, 71002, 81002, 81003, 91003, 71001])
    const rebuilt = completed()
    writeFileSync(join(root, 'own.ts'), 'export const own = 91004')
    await rebuilt
    expect(output()).toContain('91004')
    expect(output()).not.toContain('91003')
    expect(runArtifact(root)).toEqual([71001, 71002, 81002, 81003, 91004, 71001])
  }, 20_000)

  it('keeps installed dependencies bundled in ordinary production builds', async () => {
    const root = fixture()
    await build(configuration(root, false))
    const output = readFileSync(join(root, 'out/bundle.cjs'), 'utf8')
    expect(output).toContain('71001')
    expect(output).toContain('71002')
    expect(output).not.toMatch(/require\(['"](?:runtime-dep\/sub|@fixture\/runtime)['"]\)/)
    // The production artifact must run on its own, including CJS/ESM interop, without its source packages.
    rmSync(join(root, 'node_modules'), { recursive: true })
    expect(runArtifact(root)).toEqual([71001, 71002, 81002, 81003, 91003, 71001])
  }, 20_000)
})
