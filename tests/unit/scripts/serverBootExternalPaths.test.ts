import { spawnSync } from 'node:child_process'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { beforeAll, describe, expect, it } from 'vitest'

const repoRoot = join(import.meta.dirname, '../../..')
const windows = String.raw`C:\actions-runner\_work\client\apps\desktop\electron\server\server-boot.cjs`
const bootIds = [windows, windows.replaceAll('\\', '/'), '/checkout/apps/desktop/electron/server/server-boot.cjs', './server-boot.cjs', '../server/server-boot.cjs']
const otherIds = ['node:fs', 'ws', String.raw`C:\checkout\server\other.cjs`, '/checkout/server/other.cjs', './other.cjs']

function readBuildPaths() {
  const code = `
    import { build } from 'vite'
    import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
    import { tmpdir } from 'node:os'
    import { join } from 'node:path'
    const config = await import(${JSON.stringify(pathToFileURL(join(repoRoot, 'vite.config.mts')).href)})
    const { assertNoResidualRelativeRequires } = await import(${JSON.stringify(pathToFileURL(join(repoRoot, 'apps/desktop/electron/sessionpage/sessionpage-main-build.mjs')).href)})
    const entries = [config.electronBuildEntries[0], ...config.sessionHostBuildEntries]
    const readings = []
    for (const entry of entries) {
      const paths = entry.vite.build.rollupOptions.output.paths
      const dir = mkdtempSync(join(tmpdir(), 'gugu-boot-path-'))
      try {
        const input = join(dir, 'entry.mjs')
        writeFileSync(input, 'export { inspectAccountLayout } from "boot"')
        const result = await build({ configFile: false, logLevel: 'silent', plugins: [{
          name: 'external-id-fixture',
          resolveId(id) { return id === 'boot' ? { id: ${JSON.stringify(windows)}, external: true } : null },
        }], build: { write: false, minify: false, lib: { entry: input, formats: ['cjs'] }, rollupOptions: { output: { paths } } } })
        const output = (Array.isArray(result) ? result[0] : result).output.find(item => item.type === 'chunk')
        writeFileSync(join(dir, 'server.js'), output.code)
        writeFileSync(join(dir, 'server-boot.cjs'), 'exports.inspectAccountLayout = () => "ready"')
        let error = null
        try { assertNoResidualRelativeRequires(join(dir, 'server.js')) } catch (e) { error = e.message }
        readings.push({ boot: ${JSON.stringify(bootIds)}.map(id => paths(id)), other: ${JSON.stringify(otherIds)}.map(id => paths(id)), code: output.code, error })
      } finally { rmSync(dir, { recursive: true, force: true }) }
    }
    console.log('BOOT_PATHS ' + JSON.stringify(readings))
  `
  const run = spawnSync(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', code], { cwd: repoRoot, encoding: 'utf8', env: process.env })
  expect(run.status, run.stdout + run.stderr).toBe(0)
  const line = run.stdout.split(/\r?\n/).find(value => value.startsWith('BOOT_PATHS '))
  expect(line, run.stdout + run.stderr).toBeTruthy()
  return JSON.parse(line!.slice('BOOT_PATHS '.length)) as Array<{ boot: string[]; other: string[]; code: string; error: string | null }>
}

describe('shared main/server external bootstrap paths', () => {
  let readings: ReturnType<typeof readBuildPaths>
  beforeAll(() => { readings = readBuildPaths() }, 120_000)

  it('maps Windows absolute bootstrap ids to the emitted sibling', () => {
    for (const reading of readings) {
      expect(reading.boot.slice(0, 2)).toEqual(['./server-boot.cjs', './server-boot.cjs'])
    }
  })

  it('keeps POSIX and relative bootstrap ids working and leaves other externals unchanged', () => {
    for (const reading of readings) {
      expect(reading.boot.slice(2)).toEqual(bootIds.slice(2).map(() => './server-boot.cjs'))
      expect(reading.other).toEqual(otherIds)
    }
  })

  it('emits a resolvable CJS require for a Windows absolute external id and passes the unchanged residual gate', () => {
    for (const reading of readings) {
      expect(reading.code).toMatch(/require\(["']\.\/server-boot\.cjs["']\)/)
      expect(reading.code).not.toContain('./C:/')
      expect(reading.error).toBeNull()
    }
  })
})
