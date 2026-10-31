import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest'

const require = createRequire(import.meta.url)
const builderRequire = createRequire(require.resolve('electron-builder/package.json'))
const { FileMatcher } = builderRequire('app-builder-lib/out/fileMatcher') as {
  FileMatcher: new (from: string, to: string, expand: (value: string) => string, patterns: string[]) => {
    createFilter(): (file: string, stat: fs.Stats) => boolean
  }
}
const configFile = path.resolve(__dirname, '../../../electron-builder.cjs')
type Resource = { from: string; to: string; filter: string[] }

function config(legacy: 'none' | 'claude' | 'both' = 'none') {
  vi.spyOn(fs, 'existsSync').mockImplementation((file) => {
    const name = String(file)
    return name.includes('acp-bundle') && (
      name.includes('claude-agent-acp') ? legacy !== 'none' : legacy === 'both'
    )
  })
  delete require.cache[configFile]
  return require(configFile) as { files: string[]; extraResources: Resource[] }
}

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-package-'))
afterAll(() => fs.rmSync(root, { recursive: true, force: true }))
afterEach(() => {
  vi.restoreAllMocks()
  delete require.cache[configFile]
})

function accepts(patterns: string[], relative: string) {
  const file = path.join(root, relative)
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, 'fixture')
  return new FileMatcher(root, root, (value) => value, patterns).createFilter()(file, fs.statSync(file))
}

const platforms = ['darwin-arm64', 'darwin-x64', 'win32-arm64', 'win32-x64', 'linux-arm64', 'linux-x64']
const depths = ['', 'node_modules/@agentclientprotocol/claude-agent-acp/', 'node_modules/outer/node_modules/inner/']

describe('Claude CLI belongs to the host installation, not the app package', () => {
  it.each(platforms)('excludes %s at every dependency depth', (platform) => {
    // electron-builder includes production dependencies separately and applies files exclusions to them.
    const patterns = ['**/*', ...config().files.filter((pattern) => pattern.startsWith('!'))]
    for (const prefix of depths) {
      const directory = `${prefix}node_modules/@anthropic-ai/claude-agent-sdk-${platform}`
      expect(accepts(patterns, `${directory}/${platform.startsWith('win32') ? 'claude.exe' : 'claude'}`)).toBe(false)
      expect(accepts(patterns, `${directory}/package.json`)).toBe(false)
    }
  })

  it('keeps the SDK JavaScript and the ACP bridge, including a nested SDK version', () => {
    const patterns = ['**/*', ...config().files.filter((pattern) => pattern.startsWith('!'))]
    for (const prefix of depths) {
      expect(accepts(patterns, `${prefix}node_modules/@anthropic-ai/claude-agent-sdk/sdk.mjs`)).toBe(true)
    }
    expect(accepts(patterns, 'node_modules/@agentclientprotocol/claude-agent-acp/dist/index.js')).toBe(true)
  })

  it('excludes native packages from a stale full bundle while keeping codex-acp', () => {
    const resource = config('both').extraResources.find((item) => item.to === 'acp')!
    expect(resource).toBeDefined()
    expect(accepts(resource.filter, 'node_modules/@zed-industries/codex-acp/bin/codex-acp.js')).toBe(true)
    for (const platform of platforms) {
      for (const prefix of depths) {
        expect(accepts(resource.filter, `${prefix}node_modules/@anthropic-ai/claude-agent-sdk-${platform}/package.json`)).toBe(false)
      }
    }
  })

  it('does not select a leftover Claude-only full bundle', () => {
    expect(config('claude').extraResources.some((item) => item.to === 'acp')).toBe(false)
  })
})
