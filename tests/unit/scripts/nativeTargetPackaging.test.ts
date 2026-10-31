import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'
import { afterAll, afterEach, describe, expect, test, vi } from 'vitest'

const require = createRequire(import.meta.url)
const builderRequire = createRequire(require.resolve('electron-builder/package.json'))
const { getNodeModuleFileMatcher } = builderRequire('app-builder-lib/out/fileMatcher') as {
  getNodeModuleFileMatcher: (...args: unknown[]) => {
    createFilter(): (file: string, stat: fs.Stats) => boolean
  }
}
const configFile = path.resolve(__dirname, '../../../electron-builder.cjs')
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'native-target-package-'))
const nativeTargets = ['darwin-x64', 'darwin-arm64', 'win32-x64', 'win32-arm64', 'linux-x64', 'linux-arm64']
const depths = ['', 'node_modules/outer/', 'node_modules/outer/node_modules/inner/']
type Platform = 'mac' | 'win' | 'linux'
type Config = { files: string[] } & Record<Platform, { files: string[] }>

afterAll(() => fs.rmSync(root, { recursive: true, force: true }))
afterEach(() => {
  vi.unstubAllEnvs()
  delete require.cache[configFile]
})

function accepts(platform: Platform, arch: string) {
  vi.stubEnv('GUGU_TIER', 'production')
  delete require.cache[configFile]
  const config = require(configFile) as Config
  // Use builder's production-dependency matcher: it merges root and platform exclusions,
  // expands the target macro, and reads the installed module's destination path from stat.
  const filter = getNodeModuleFileMatcher(
    root, root, (value: string) => value.replaceAll('${arch}', arch), config[platform],
    { config, debugLogger: { isEnabled: false } },
  ).createFilter()
  const file = path.join(root, 'source-file')
  fs.writeFileSync(file, 'fixture')
  return (relative: string) => filter(file, Object.assign(fs.statSync(file), { moduleFullFilePath: relative }))
}

describe('desktop native payloads follow the package target', () => {
  test.each(nativeTargets)('%s keeps its loader closure and excludes other prebuild targets', (target) => {
    const [os, arch] = target.split('-')
    const platform: Platform = os === 'darwin' ? 'mac' : os === 'win32' ? 'win' : 'linux'
    const includes = accepts(platform, arch)
    for (const depth of depths) {
      for (const candidate of nativeTargets) {
        const pty = `${depth}node_modules/node-pty/prebuilds/${candidate}`
        for (const file of ['pty.node', 'spawn-helper', 'conpty/conpty.dll', 'conpty/OpenConsole.exe']) {
          expect(includes(`${pty}/${file}`), `${target}: ${pty}/${file}`).toBe(candidate === target)
        }
        const suffixes = candidate.startsWith('linux-') ? ['-glibc', '-musl'] : ['']
        for (const suffix of suffixes) {
          const watcher = `${depth}node_modules/@parcel/watcher-${candidate}${suffix}`
          expect(includes(`${watcher}/package.json`), `${target}: ${watcher}`).toBe(candidate === target)
          expect(includes(`${watcher}/watcher.node`), `${target}: ${watcher}`).toBe(candidate === target)
        }
      }
      for (const file of [
        'node-pty/lib/index.js',
        'node-pty/build/Release/pty.node',
        'node-pty/build/Release/spawn-helper',
        'node-pty/build/Release/conpty.node',
        'node-pty/build/Release/conpty/conpty.dll',
        'node-pty/build/Release/conpty/OpenConsole.exe',
        'better-sqlite3/build/Release/better_sqlite3.node',
        '@parcel/watcher/index.js',
        'playwright/lib/mcp/test/test.js',
        'playwright/lib/mcp/browser/README.md',
        'npm/node_modules/node-gyp/src/win_delay_load_hook.cc',
        'npm/LICENSE',
      ]) {
        expect(includes(`${depth}node_modules/${file}`), `${target}: ${file}`).toBe(true)
      }
      expect(includes(`${depth}node_modules/better-sqlite3/build/Release/test_extension.node`)).toBe(false)
    }
  })
})
