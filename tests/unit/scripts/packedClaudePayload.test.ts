import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'
import { afterEach, describe, expect, it } from 'vitest'

const require = createRequire(import.meta.url)
const { verifyPackedClaudePayload } = require('../../../scripts/checks/verify-packed-claude-payload.cjs')
const roots: string[] = []

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'thin-claude-payload-'))
  roots.push(root)
  fs.mkdirSync(path.join(root, 'app/node_modules'), { recursive: true })
  return root
}

function put(root: string, relative: string) {
  const file = path.join(root, relative)
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, 'synthetic payload')
  return file
}

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true })
})

describe('materialized thin Claude payload', () => {
  const variants = ['darwin-arm64', 'darwin-x64', 'win32-x64', 'win32-arm64', 'linux-x64', 'linux-arm64']
  it.each(variants)('rejects the nested %s package from an actual copied tree', variant => {
    const root = fixture()
    put(root, `app/node_modules/@agentclientprotocol/claude-agent-acp/node_modules/@anthropic-ai/claude-agent-sdk-${variant}/claude`)
    expect(() => verifyPackedClaudePayload(root)).toThrow('bundled Claude native packages')
  })

  it('rejects a top-level native package', () => {
    const root = fixture()
    put(root, 'app/node_modules/@anthropic-ai/claude-agent-sdk-darwin-arm64/claude')
    expect(() => verifyPackedClaudePayload(root)).toThrow('bundled Claude native packages')
  })

  it('checks a legacy full ACP extraResource too', () => {
    const root = fixture()
    put(root, 'acp/node_modules/outer/node_modules/@anthropic-ai/claude-agent-sdk-win32-x64/claude.exe')
    expect(() => verifyPackedClaudePayload(root)).toThrow('acp/node_modules/outer')
  })

  it('keeps the JavaScript SDK and bridge untouched', () => {
    const root = fixture()
    const sdk = put(root, 'app/node_modules/@anthropic-ai/claude-agent-sdk/sdk.mjs')
    const bridge = put(root, 'app/node_modules/@agentclientprotocol/claude-agent-acp/dist/index.js')
    expect(verifyPackedClaudePayload(root).nativePackages).toBe(0)
    expect(fs.readFileSync(sdk, 'utf8')).toBe('synthetic payload')
    expect(fs.readFileSync(bridge, 'utf8')).toBe('synthetic payload')
  })

  it('follows internal directory aliases and terminates cycles', () => {
    const root = fixture()
    fs.symlinkSync(path.join(root, 'app/node_modules'), path.join(root, 'app/node_modules/cycle'), 'junction')
    expect(verifyPackedClaudePayload(root).nativePackages).toBe(0)
    put(root, 'app/node_modules/inner/node_modules/@anthropic-ai/claude-agent-sdk-darwin-x64/claude')
    fs.symlinkSync(path.join(root, 'app/node_modules/inner'), path.join(root, 'app/node_modules/alias'), 'junction')
    expect(() => verifyPackedClaudePayload(root)).toThrow('bundled Claude native packages')
  })

  it('fails when an external alias cannot be verified inside the package', () => {
    const root = fixture()
    const outside = fixture()
    fs.symlinkSync(outside, path.join(root, 'app/node_modules/outside'), 'junction')
    expect(() => verifyPackedClaudePayload(root)).toThrow('cannot verify dependency outside resources')
  })

  it('does not report a missing packaged dependency tree as clean', () => {
    const root = fixture()
    fs.rmdirSync(path.join(root, 'app/node_modules'))
    expect(() => verifyPackedClaudePayload(root)).toThrow()
  })
})
