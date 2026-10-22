import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from 'vitest'
import { riskyEntries, scan } from '../../../scripts/check-packaged-entries.mjs'

const excludedTargets = [
  './src/index.ts', './types.d.mts', './README.md', './test/run.js', './src/binding.cc',
  ...['iobj', 'ipdb', 'exp', 'ilk', 'obj', 'tlog'].map((ext) => `./build/output.${ext}`),
  './build/Release/binding.lib', 'build/Release/binding.lib',
  ...['mk', 'gyp', 'gypi'].map((ext) => `./build/binding.${ext}`),
  './build/Release/obj/gen/x.js',
]

test.each(excludedTargets)('detects the excluded runtime entry %s', (target) => {
  expect(riskyEntries({ main: target })).toEqual([{ field: 'main', target }])
})

test.each(['./index.js', './build/Release/binding.node', './data/reference.lib', './LICENSE',
  './LICENSE.md', './license-MIT.md', './Notice.markdown', './COPYING.md'])('preserves runtime or license file %s', (target) => {
  expect(riskyEntries({ main: target })).toEqual([])
})

test('checks command names and runtime export conditions without treating types or custom conditions as runtime', () => {
  expect(riskyEntries({ bin: { tool: './test/run.js' } })).toHaveLength(1)
  expect(riskyEntries({ exports: { '.': { require: ['./lib/a.ts'] } } })).toHaveLength(1)
  expect(riskyEntries({ main: './index.js', types: './index.d.ts', exports: {
    '.': { '@zod/source': './src/index.ts', source: './src/index.ts', types: './index.d.ts', default: './index.js' },
  } })).toEqual([])
})

test('reports excluded artifact entries even when their files have already been removed', () => {
  const root = mkdtempSync(join(tmpdir(), 'packaged-entries-'))
  try {
    writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'runtime-package', main: 'test/runtime.js' }))
    expect(() => scan(root, true)).toThrow('runtime-package main -> test/runtime.js')
    writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'runtime-package', main: 'index.js' }))
    expect(scan(root, true)).toBe(1)
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('fails on unresolved required dependencies and invalid manifests; only declared optional dependencies may be absent', () => {
  const root = mkdtempSync(join(tmpdir(), 'packaged-deps-'))
  const missing = 'gugu-packaging-missing-dependency-fixture'
  try {
    const manifest = join(root, 'package.json')
    writeFileSync(manifest, JSON.stringify({ dependencies: { [missing]: '*' } }))
    expect(() => scan(root, false)).toThrow(`Cannot resolve required production dependency ${missing}`)
    writeFileSync(manifest, JSON.stringify({ dependencies: { [missing]: '*' }, optionalDependencies: { [missing]: '*' } }))
    expect(scan(root, false)).toBe(0)
    const dir = join(root, 'node_modules', missing)
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'package.json'), '{bad json')
    expect(() => scan(root, false)).toThrow()
  } finally { rmSync(root, { recursive: true, force: true }) }
})
