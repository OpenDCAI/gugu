import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { expect, test } from 'vitest'

const script = join(import.meta.dirname, '../../../scripts/check-packaged-entries.mjs')

test('the packaging documentation filter preserves Markdown license notices', () => {
  const require = createRequire(import.meta.url)
  const builderRequire = createRequire(require.resolve('app-builder-lib'))
  const { minimatch } = builderRequire('minimatch') as { minimatch: (file: string, pattern: string) => boolean }
  const config = readFileSync(join(import.meta.dirname, '../../../electron-builder.cjs'), 'utf8')
  const rule = config.split('\n').find((line) => line.includes('.{md,markdown}'))?.trim().slice(1, -2)
  expect(rule).toBeDefined()
  const excluded = rule!.slice(1)
  expect(minimatch('node_modules/example/README.md', excluded)).toBe(true)
  for (const name of ['LICENSE.md', 'license-MIT.md', 'Notice.markdown', 'COPYING.md']) {
    expect(minimatch(`node_modules/example/${name}`, excluded), name).toBe(false)
  }
})

test('reports an excluded runtime entry even after packaging has removed the target', () => {
  const root = mkdtempSync(join(tmpdir(), 'packaged-entries-'))
  try {
    const dir = join(root, 'node_modules', 'runtime-package')
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'runtime-package', main: 'test/runtime.js' }))
    const result = spawnSync(process.execPath, [script, '--root', root], { encoding: 'utf8' })
    expect(result.status).toBe(1)
    expect(result.stderr).toContain('runtime-package')
    expect(result.stderr).toContain('test/runtime.js')

    writeFileSync(join(dir, 'package.json'), JSON.stringify({
      name: 'runtime-package', main: 'index.js', types: 'index.d.ts',
      exports: { '.': { '@zod/source': './src/index.ts', default: './index.js' } },
    }))
    writeFileSync(join(dir, 'index.js'), 'module.exports = {}\n')
    const valid = spawnSync(process.execPath, [script, '--root', root], { encoding: 'utf8' })
    expect(valid.status).toBe(0)
    expect(valid.stdout).toContain('scanned 1 packages')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
