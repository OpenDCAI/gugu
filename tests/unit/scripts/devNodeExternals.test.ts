import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
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
    'entry.ts': 'import { bundled } from "bundler-only"; import { dual } from "dual-entry"; import { sep } from "node:path"; import { legacy, legacyDual } from "legacy-dep"; import { value } from "runtime-dep/sub"; import { scoped } from "@fixture/runtime"; import { linked, nested, nestedScoped } from "linked-dep"; import { other } from "runtime-dependency"; import { own } from "./own"; export const answer = [value, scoped, linked, other, own, legacy, nested, nestedScoped, dual, legacyDual, bundled]; export const separator = sep',
    'node_modules/legacy-dep/package.json': JSON.stringify({ name: 'legacy-dep', main: 'index.js' }),
    'node_modules/legacy-dep/index.js': 'exports.legacy = require("runtime-dep/sub").value; exports.legacyDual = require("dual-entry").dual',
    'own.ts': 'export const own = 91003',
    'node_modules/bundler-only/package.json': JSON.stringify({ name: 'bundler-only', type: 'module', exports: { import: './index.js' } }),
    'node_modules/bundler-only/index.js': 'export const bundled = 74001',
    'node_modules/dual-entry/package.json': JSON.stringify({ name: 'dual-entry', main: 'cjs/index.cjs', module: 'esm/index.js', type: 'module' }),
    'node_modules/dual-entry/cjs/index.cjs': 'exports.dual = 73001',
    'node_modules/dual-entry/esm/index.js': 'export { dual } from "./value"',
    'node_modules/dual-entry/esm/value.js': 'export const dual = 73001',
    'node_modules/runtime-dep/package.json': JSON.stringify({ name: 'runtime-dep', main: 'sub.js' }),
    'node_modules/runtime-dep/sub.js': 'exports.value = 71001',
    'node_modules/@fixture/runtime/package.json': JSON.stringify({ name: '@fixture/runtime', type: 'module', main: 'index.js' }),
    'node_modules/@fixture/runtime/index.js': 'export const scoped = 71002',
    'node_modules/linked-dep/package.json': JSON.stringify({ name: 'linked-dep', main: 'index.js' }),
    'node_modules/linked-dep/index.js': 'exports.linked = 81002; exports.nested = require("runtime-dep/sub").value; exports.nestedScoped = require("@fixture/runtime").scoped',
    'node_modules/linked-dep/node_modules/runtime-dep/package.json': JSON.stringify({ name: 'runtime-dep', main: 'sub.js' }),
    'node_modules/linked-dep/node_modules/runtime-dep/sub.js': 'exports.value = 72001',
    'node_modules/linked-dep/node_modules/@fixture/runtime/package.json': JSON.stringify({ name: '@fixture/runtime', type: 'module', main: 'index.js' }),
    'node_modules/linked-dep/node_modules/@fixture/runtime/index.js': 'export const scoped = 72002',
    'node_modules/runtime-dependency/package.json': JSON.stringify({ name: 'runtime-dependency', main: 'index.js' }),
    'node_modules/runtime-dependency/index.js': 'exports.other = 81003',
  }
  for (const [file, code] of Object.entries(files)) {
    mkdirSync(join(root, file, '..'), { recursive: true })
    writeFileSync(join(root, file), code)
  }
  return root
}

function configuration(root: string, watch: boolean, loaded: string[] = []): InlineConfig {
  return {
    root,
    configFile: false,
    publicDir: false,
    logLevel: 'silent',
    plugins: [devNodeExternals({
      dependencies: { 'runtime-dep': '^1.0.0', 'linked-dep': 'workspace:*', 'dual-entry': '^1.0.0', 'bundler-only': '^1.0.0' },
      devDependencies: { '@fixture/runtime': '^1.0.0' },
    }), {
      name: 'observe-externalized-package-loads',
      load(id) {
        // CommonJS creates tiny virtual external bridges; the dependency source must never load.
        if (!id.startsWith('\0') && /\/node_modules\/(?:runtime-dep|dual-entry)\//.test(id)) loaded.push(id)
      },
    }],
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
  it('externalizes installed CommonJS packages, bundles ESM and local source, and rebuilds changes', async () => {
    const root = fixture()
    const loaded: string[] = []
    const watcher = await build(configuration(root, true, loaded))
    if (!('on' in watcher)) throw new Error('Expected a Rollup watcher')
    cleanup.push(() => watcher.close())
    const completed = () => new Promise<void>((resolve, reject) => {
      watcher.on('event', (event) => {
        if (event.code === 'END') resolve()
        if (event.code === 'ERROR') reject(event.error)
      })
    })
    await completed()
    expect(loaded).toEqual([])
    const output = () => readFileSync(join(root, 'out/bundle.cjs'), 'utf8')
    expect(output()).toContain('node_modules/runtime-dep/sub.js')
    expect(output()).not.toContain('71001')
    expect(output()).toContain('71002')
    expect(output()).not.toContain('72001')
    expect(output()).toContain('72002')
    expect(output()).not.toContain('73001')
    expect(output()).toContain('dual-entry/cjs/index.cjs')
    expect(output()).toContain('74001')
    expect(output()).toContain('81002')
    expect(output()).toContain('81003')
    expect(output()).toContain('91003')
    expect(runArtifact(root)).toEqual([71001, 71002, 81002, 81003, 91003, 71001, 72001, 72002, 73001, 73001, 74001])
    // Rollup emits END right after *starting* to watch the files it just built, not after the watcher
    // is subscribed, and exposes no readiness signal. On macOS FSEvents an edit made in that window is
    // never reported (mac1, 8 runs in parallel: 6 of 32 hung until the case cap). So the edit stays
    // applied until the watcher reports it: this waits for that fact, and asserts the rebuild once.
    const rebuilt = completed()
    const edit = () => writeFileSync(join(root, 'own.ts'), 'export const own = 91004')
    edit()
    const reapply = setInterval(edit, 100)
    await rebuilt.finally(() => clearInterval(reapply))
    expect(output()).toContain('91004')
    expect(output()).not.toContain('91003')
    expect(runArtifact(root)).toEqual([71001, 71002, 81002, 81003, 91004, 71001, 72001, 72002, 73001, 73001, 74001])
    expect(loaded).toEqual([])
  }, 60_000)

  it('shares the same Yjs constructors with bundled ESM file-content helpers', async () => {
    const root = fixture()
    mkdirSync(join(root, 'node_modules/@gugu'), { recursive: true })
    for (const name of ['yjs', '@gugu/files-core']) {
      const installed = fileURLToPath(new URL('../../../node_modules/' + name, import.meta.url))
      symlinkSync(installed, join(root, 'node_modules', name), 'junction')
    }
    writeFileSync(join(root, 'entry.ts'), `
      import * as Y from 'yjs'
      import { applyJson } from '@gugu/files-core/content'
      const doc = new Y.Doc()
      const root = doc.getMap('root')
      applyJson(root, { child: { value: 1 }, items: [{ value: 2 }] })
      applyJson(root, { child: { value: 3 }, items: [{ value: 4 }, { value: 5 }] })
      export const answer = {
        json: root.toJSON(), childIsMap: root.get('child') instanceof Y.Map,
        itemsIsArray: root.get('items') instanceof Y.Array,
      }
      doc.destroy()
    `)
    const config = configuration(root, true)
    config.plugins = [devNodeExternals({ dependencies: { yjs: '13.6.33', '@gugu/files-core': '0.1.0' } })]
    const watcher = await build(config)
    if (!('on' in watcher)) throw new Error('Expected a Rollup watcher')
    cleanup.push(() => watcher.close())
    await new Promise<void>((resolve, reject) => {
      watcher.on('event', event => {
        if (event.code === 'END') resolve()
        if (event.code === 'ERROR') reject(event.error)
      })
    })
    expect(runArtifact(root)).toEqual({
      json: { child: { value: 3 }, items: [{ value: 4 }, { value: 5 }] },
      childIsMap: true, itemsIsArray: true,
    })
  }, 60_000)

  it('keeps installed dependencies bundled in ordinary production builds', async () => {
    const root = fixture()
    await build(configuration(root, false))
    const output = readFileSync(join(root, 'out/bundle.cjs'), 'utf8')
    expect(output).toContain('71001')
    expect(output).toContain('71002')
    expect(output).not.toMatch(/require\(['"](?:runtime-dep\/sub|@fixture\/runtime)['"]\)/)
    // The production artifact must run on its own, including CJS/ESM interop, without its source packages.
    rmSync(join(root, 'node_modules'), { recursive: true })
    expect(runArtifact(root)).toEqual([71001, 71002, 81002, 81003, 91003, 71001, 72001, 72002, 73001, 73001, 74001])
  }, 60_000)
})
