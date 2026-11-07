import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { randomUUID } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { SessionBrowserTools, createBrowserAppProgram, closeSessionBrowserTools } from '../../../../apps/desktop/electron/browser-agent-mcp'
import { createPageProtocol } from '../../../../apps/desktop/electron/session/main/core/browser/page-protocol'
import { page } from '../../../../apps/desktop/electron/session/main/core/browser/test-support/page-protocol-fixture'
import { privatePasswordVaultDirectory } from '@gugu/core/local/state/protectedPrivateStorage'

let root: string
let secret: string
const sessions: string[] = []
beforeEach(() => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'gugu-private-browser-')))
  vi.stubEnv('GUGU_HOME', path.join(root, 'host-state'))
  fs.mkdirSync(privatePasswordVaultDirectory(), { recursive: true })
  secret = path.join(privatePasswordVaultDirectory(), 'vault.bin')
  fs.writeFileSync(secret, 'synthetic-browser-private-canary')
})
afterEach(async () => {
  await Promise.all(sessions.splice(0).map(closeSessionBrowserTools))
  vi.restoreAllMocks()
  vi.unstubAllEnvs()
  fs.rmSync(root, { recursive: true, force: true })
})

it.each(['upload', 'directory upload', 'drop', 'symbolic link', 'hard link', 'nested symbolic file', 'nested symbolic directory', 'snapshot filename', 'screenshot filename', 'network filename'])('refuses browser %s before Playwright sees a private path', async kind => {
  let source = secret
  if (kind.startsWith('nested symbolic')) {
    source = path.join(root, 'ordinary-upload')
    fs.mkdirSync(source)
    fs.symlinkSync(kind === 'nested symbolic file' ? secret : privatePasswordVaultDirectory(), path.join(source, 'nested'))
  }
  if (kind === 'symbolic link' || kind === 'hard link') {
    source = path.join(root, 'alias')
    if (kind === 'symbolic link') fs.symlinkSync(secret, source)
    else fs.linkSync(secret, source)
  }
  const output = kind.endsWith('filename')
  const name = output ? kind.startsWith('snapshot') ? 'browser_snapshot' : kind.startsWith('screenshot') ? 'browser_take_screenshot' : 'browser_network_requests'
    : kind === 'drop' ? 'browser_drop' : 'browser_file_upload'
  const args = output ? { filename: path.relative(root, path.join(privatePasswordVaultDirectory(), 'missing-control.json')) }
    : { paths: [kind === 'directory upload' ? root : source] }
  const called = vi.fn(async () => ({ content: [{ type: 'text', text: 'ordinary result' }] }))
  const client = vi.spyOn(SessionBrowserTools.prototype, 'client').mockResolvedValue({ callTool: called } as unknown as Client)
  const bridge = { openTransport: vi.fn(), toolStarting: () => ({ ok: true as const }), toolFinished: vi.fn(), setInitialUrl: vi.fn(), workspaceRoot: async () => root }
  const provider = createBrowserAppProgram(() => bridge)
  const id = randomUUID()
  sessions.push(id)
  const result = await provider.call({ extensionId: 'browser-use', server: 'browser-use', native: 'browser-use', digest: 'fixture',
    command: 'test', args: [], env: {}, cwd: root, dataDir: root }, { name, arguments: args, _meta: { 'gugu/sessionId': id } }, new AbortController().signal)
  expect(result).toMatchObject({ isError: true })
  expect(client).not.toHaveBeenCalled()
  expect(called).not.toHaveBeenCalled()
})

it('refuses a protected CDP upload before native debugger dispatch, including an ancestor directory', async () => {
  const upload = path.join(root, 'ordinary-upload')
  fs.mkdirSync(upload)
  fs.symlinkSync(privatePasswordVaultDirectory(), path.join(upload, 'nested'))
  for (const file of [secret, root, upload]) {
    const fixture = page(['https://example.test/']), lease = createPageProtocol(fixture.contents)
    try {
      await expect(lease.send('DOM.setFileInputFiles', { files: [file], backendNodeId: 1 })).rejects.toThrow()
      expect(fixture.debuggerApi.sendCommand).not.toHaveBeenCalled()
    } finally { lease.close() }
  }
})

it('permits directory uploads with ordinary internal and external symbolic links', async () => {
  const upload = path.join(root, 'ordinary-upload'), other = path.join(root, 'other')
  fs.mkdirSync(upload)
  fs.mkdirSync(other)
  fs.writeFileSync(path.join(upload, 'ordinary.txt'), 'ordinary')
  fs.writeFileSync(path.join(other, 'other.txt'), 'ordinary')
  fs.symlinkSync(path.join(upload, 'ordinary.txt'), path.join(upload, 'internal'))
  fs.symlinkSync(other, path.join(upload, 'external-directory'))
  const fixture = page(['https://example.test/']), lease = createPageProtocol(fixture.contents)
  try {
    await expect(lease.send('DOM.setFileInputFiles', { files: [upload], backendNodeId: 1 })).resolves.toBeDefined()
    expect(fixture.debuggerApi.sendCommand).toHaveBeenCalledWith('DOM.setFileInputFiles', expect.anything(), undefined)
  } finally { lease.close() }
})

it('refuses a cyclic directory upload without dispatching it', async () => {
  const upload = path.join(root, 'ordinary-upload')
  fs.mkdirSync(upload)
  fs.symlinkSync(upload, path.join(upload, 'cycle'))
  const fixture = page(['https://example.test/']), lease = createPageProtocol(fixture.contents)
  try {
    await expect(lease.send('DOM.setFileInputFiles', { files: [upload], backendNodeId: 1 })).rejects.toThrow()
    expect(fixture.debuggerApi.sendCommand).not.toHaveBeenCalled()
  } finally { lease.close() }
})

it('permits an ordinary browser upload path through the same host wrapper', async () => {
  const file = path.join(root, 'ordinary.txt')
  fs.writeFileSync(file, 'ordinary')
  const called = vi.fn(async () => ({ content: [{ type: 'text', text: 'ordinary result' }] }))
  vi.spyOn(SessionBrowserTools.prototype, 'client').mockResolvedValue({ callTool: called } as unknown as Client)
  const bridge = { openTransport: vi.fn(), toolStarting: () => ({ ok: true as const }), toolFinished: vi.fn(), setInitialUrl: vi.fn(), workspaceRoot: async () => root }
  const provider = createBrowserAppProgram(() => bridge)
  const id = randomUUID()
  sessions.push(id)
  const result = await provider.call({ extensionId: 'browser-use', server: 'browser-use', native: 'browser-use', digest: 'fixture',
    command: 'test', args: [], env: {}, cwd: root, dataDir: root }, { name: 'browser_file_upload', arguments: { paths: [file] }, _meta: { 'gugu/sessionId': id } }, new AbortController().signal)
  expect(result.isError).not.toBe(true)
  expect(called).toHaveBeenCalledOnce()
})
