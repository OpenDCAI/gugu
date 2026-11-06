import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import { createServer } from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import type { FamilyDeps } from '../../../../apps/desktop/electron/device-actions/catalog'
import { execFileAsync } from '../../../../apps/desktop/electron/device-actions/mac-scripts'

let home: string
let register: typeof import('@gugu/core/local/state/protectedPrivateStorage').registerProtectedPrivateStorage
let run: (name: string, args: Record<string, unknown>) => Promise<unknown>
let paths: string[]
const canary = 'synthetic-vault-ciphertext-canary'
const cleanup: (() => Promise<unknown>)[] = []
const outputs: string[] = []

beforeEach(async () => {
  vi.resetModules()
  home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'gugu-protected-storage-')))
  vi.stubEnv('HOME', home)
  vi.stubEnv('GUGU_HOME', path.join(home, 'host-state'))
  fs.mkdirSync(path.join(home, 'ordinary'))
  fs.mkdirSync(path.join(home, 'private'))
  paths = ['vault', 'key.material', 'recovery.material', 'audit', 'switch.json'].map(name => path.join(home, 'private', name))
  for (const file of paths.slice(0, -1)) fs.writeFileSync(file, canary)
  ;({ registerProtectedPrivateStorage: register } = await import('@gugu/core/local/state/protectedPrivateStorage'))
  register({ id: 'vault', paths })
  const { createFilesFamily } = await import('../../../../apps/desktop/electron/device-actions/families/files')
  const { createDeviceActionGrantsStore } = await import('../../../../apps/desktop/electron/device-actions/grants-store')
  const { createDeviceActionsProvider } = await import('../../../../apps/desktop/electron/device-actions/provider')
  const store = createDeviceActionGrantsStore(path.join(home, 'grants.json'))
  store.setGroup('files.other', true)
  const deps = {
    platform: 'darwin', nativeDir: null, now: () => new Date(), homedir: () => home,
    clipboardRead: () => '', clipboardWrite: () => undefined, notify: async () => ({ shown: true }),
    openExternal: async () => undefined,
    trashItem: vi.fn(async () => { throw new Error('must not trash protected material') }),
    jxa: vi.fn(), macHelper: () => ({ available: () => ({ ok: true }), call: vi.fn(), dispose: () => undefined }),
    cua: vi.fn(), exec: async (file: string, args: readonly string[]) => {
      const result = await execFileAsync(file, args, { timeoutMs: 10_000 })
      outputs.push(result.stdout)
      return result
    },
  } as unknown as FamilyDeps
  const provider = createDeviceActionsProvider({ store, families: [createFilesFamily({ findRipgrep: async () => 'rg' })], deps })
  run = (name, args) => provider.provider.run(name, args, { callId: 'private-storage', signal: new AbortController().signal, note: () => undefined })
})

afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close()
  vi.unstubAllEnvs()
  fs.rmSync(home, { recursive: true, force: true })
  outputs.length = 0
})

describe('registered private storage through the actual native file actions', () => {
  it.each([0, 1, 2, 3])('refuses reads, copies and writes of registered material %i', async index => {
    const file = paths[index]!
    expect(await run('fs.read', { path: file })).toMatchObject({ ok: false })
    expect(await run('fs.copy', { source: file, destination: path.join(home, 'ordinary', 'copy'), confirmed: true })).toMatchObject({ ok: false })
    expect(await run('fs.write', { path: file, mode: 'append', content: 'altered', confirmed: true })).toMatchObject({ ok: false })
    expect(fs.readFileSync(file, 'utf8')).toBe(canary)
    expect(fs.existsSync(path.join(home, 'ordinary', 'copy'))).toBe(false)
  })

  it.each(['direct', 'relative link chain', 'directory link', 'traversal', 'case alias'])('cannot create an absent protection switch via %s', async kind => {
    let target = paths[4]!
    const alias = path.join(home, 'ordinary', 'alias')
    if (kind === 'relative link chain') {
      fs.symlinkSync(path.relative(path.dirname(alias), target), `${alias}-second`)
      fs.symlinkSync('alias-second', alias)
      target = alias
    } else if (kind === 'directory link') {
      fs.symlinkSync(path.dirname(target), alias)
      target = path.join(alias, path.basename(target))
    } else if (kind === 'traversal') target = `${path.dirname(target)}/../private/switch.json`
    else if (kind === 'case alias') target = `${path.dirname(target)}/SWITCH.JSON`
    expect(await run('fs.write', { path: target, mode: 'append', content: '{"enabled":true}', confirmed: true })).toMatchObject({ ok: false })
    expect(fs.existsSync(paths[4]!)).toBe(false)
  })

  it('refuses pre-existing hard links and their containing copy/move tree', async () => {
    const alias = path.join(home, 'ordinary', 'linked')
    fs.linkSync(paths[0]!, alias)
    expect(await run('fs.read', { path: alias })).toMatchObject({ ok: false })
    expect(await run('fs.write', { path: alias, mode: 'append', content: 'altered' })).toMatchObject({ ok: false })
    for (const name of ['fs.copy', 'fs.move']) {
      expect(await run(name, { source: path.dirname(alias), destination: path.join(home, 'exposed'), confirmed: true })).toMatchObject({ ok: false })
    }
    expect(fs.readFileSync(paths[0]!, 'utf8')).toBe(canary)
    expect(fs.existsSync(path.join(home, 'exposed'))).toBe(false)
  })

  it('refuses copy/move/trash of a containing directory before any effect', async () => {
    for (const name of ['fs.copy', 'fs.move']) {
      expect(await run(name, { source: path.join(home, 'private'), destination: path.join(home, 'exposed'), confirmed: true })).toMatchObject({ ok: false })
    }
    expect(await run('fs.trash', { path: path.join(home, 'private'), confirmed: true })).toMatchObject({ ok: false })
    expect(fs.readFileSync(paths[0]!, 'utf8')).toBe(canary)
    expect(fs.existsSync(path.join(home, 'exposed'))).toBe(false)
  })

  it('omits protected entries and never feeds protected bytes to real ripgrep', async () => {
    fs.writeFileSync(path.join(home, 'private', 'ordinary.txt'), `${canary} public-marker`)
    const listing = await run('fs.list', { path: path.join(home, 'private'), recursive: true, showHidden: true })
    expect(JSON.stringify(listing)).not.toMatch(/key\.material|recovery\.material|"vault"|"audit"/)
    expect(JSON.stringify(listing)).toContain('ordinary.txt')
    const result = await run('fs.grep', { path: path.join(home, 'private'), pattern: canary })
    expect(JSON.stringify(result)).toContain('public-marker')
    expect(outputs.join('')).not.toMatch(/key\.material|recovery\.material|\/vault|\/audit/)
  })

  it('protects future directory trees while permitting an ordinary sibling', async () => {
    const future = path.join(home, 'ordinary', 'future-private')
    register({ id: 'future', paths: [future] })
    expect(await run('fs.write', { path: path.join(future, 'control.json'), mode: 'create', content: 'private' })).toMatchObject({ ok: false })
    expect(fs.existsSync(future)).toBe(false)
    expect(await run('fs.write', { path: path.join(home, 'ordinary', 'allowed.txt'), mode: 'create', content: 'ordinary' })).toMatchObject({ ok: true })
  })
})

async function connected(mode: string) {
  const { GuguMcpHost } = await import('../../../../apps/desktop/electron/gugu-mcp-host')
  const { registerGuguCatalogTools } = await import('../../../../apps/desktop/electron/mcp/gugu-catalog-tools')
  const { PrivatePermissionRecords } = await import('../../../../apps/desktop/electron/permissions/private-records')
  const { ServicePermissionRuntime } = await import('../../../../apps/desktop/electron/permissions/runtime')
  const { defaultPermissionPolicy } = await import('../../../../apps/desktop/electron/permissions/rules')
  const runtime = mode === 'disabled' ? undefined : new ServicePermissionRuntime({
    records: new PrivatePermissionRecords(path.join(home, 'host-state', 'private-service-permissions')),
    readPolicy: async () => mode === 'policy unavailable' ? null : { policy: defaultPermissionPolicy() },
  })
  let executions = 0
  const host = new GuguMcpHost<null>(() => {
    const server = new McpServer({ name: 'protected-file-fixture', version: '1' })
    server.registerTool('device_call', { inputSchema: z.object({ name: z.string(), args: z.record(z.string(), z.unknown()) }) }, async args => {
      executions++
      return { content: [{ type: 'text' as const, text: JSON.stringify(await run(String(args.name), args.args as Record<string, unknown>)) }] }
    })
    registerGuguCatalogTools(server, async () => [], undefined, undefined, new Set())
    return server
  }, () => ({ ownerId: 'owner', subjectId: 'agent', toolScope: 'gugu' }), undefined, runtime)
  cleanup.push(() => host.dispose())
  await host.start()
  const grant = await host.grant('session', null)
  const client = new Client({ name: 'negative-file-client', version: '1' })
  cleanup.push(() => client.close())
  await client.connect(new StreamableHTTPClientTransport(new URL(grant.url), { requestInit: { headers: { Authorization: `Bearer ${grant.capability}` } } }))
  return { client, executions: () => executions }
}

it.each(['disabled', 'observe', 'policy unavailable'])('keeps direct/catalog MCP results and persisted/uploaded history safe with permissions %s', async mode => {
  const { client, executions } = await connected(mode)
  const history = path.join(home, 'ordinary', 'transcript.jsonl')
  for (const name of ['device_call', 'catalog_call']) {
    const args = { name: 'fs.read', args: { path: paths[0] } }
    const result = await client.callTool({ name, arguments: name === 'catalog_call' ? { tool: 'device_call', args } : args })
    expect(result.isError, JSON.stringify(result)).not.toBe(true)
    fs.appendFileSync(history, JSON.stringify({ type: 'response_item', payload: { type: 'function_call_output', call_id: name, output: JSON.stringify(result) } }) + '\n')
  }
  expect(executions()).toBe(2)
  const { uploadSessionFile } = await import('@gugu/core/local/agent/sessionFileHandoff')
  const { endpoint, received } = await uploadReceiver()
  await uploadSessionFile(endpoint, { file_path: history }, { agentId: 'agent', sessionId: 'session', recipients: [] })
  expect(received).toHaveLength(1)
  expect(received[0]!.toString()).toBe(fs.readFileSync(history, 'utf8'))
  expect(received[0]!.toString()).not.toContain(canary)
})

async function uploadReceiver() {
  const received: Buffer[] = []
  const receiver = createServer(async (req, res) => {
    const chunks: Buffer[] = []
    for await (const chunk of req) chunks.push(Buffer.from(chunk))
    const body = Buffer.concat(chunks)
    if (req.url === '/object') {
      received.push(body)
      res.writeHead(204).end()
    } else if (req.url?.endsWith('/upload')) res.end(JSON.stringify({ staging_key: 'fixture', url: `${url}/object`, method: 'PUT', fields: {}, max_bytes: 1024 * 1024 }))
    else {
      const args = JSON.parse(body.toString())
      const bytes = received.at(-1)!
      res.end(JSON.stringify({ attachment: { attachment_id: args.attachment_id, file_name: args.file_name, content_type: args.content_type,
        size_bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') } }))
    }
  })
  await new Promise<void>(resolve => receiver.listen(0, '127.0.0.1', resolve))
  cleanup.push(() => new Promise<void>((resolve, reject) => receiver.close(error => error ? reject(error) : resolve())))
  const url = `http://127.0.0.1:${(receiver.address() as { port: number }).port}`
  const endpoint = { supabaseUrl: url, anonKey: 'synthetic', token: 'synthetic' }
  return { endpoint, received }
}

it.each(['chat bytes', 'session upload'])('refuses %s of private material and delivers zero bytes, including symbolic and hard links', async route => {
  // @ts-expect-error -- injectable MCP implementation is an untyped ESM module.
  const { readUploadBytes } = await import('../../../../apps/desktop/electron/mcp/gugu-im-server.mjs')
  const { uploadSessionFile } = await import('@gugu/core/local/agent/sessionFileHandoff')
  const { endpoint, received } = await uploadReceiver()
  const symbolic = path.join(home, 'ordinary', 'symbolic')
  const hard = path.join(home, 'ordinary', 'hard')
  fs.symlinkSync(paths[0]!, symbolic)
  fs.linkSync(paths[1]!, hard)
  for (const file of [...paths.slice(0, -1), symbolic, hard]) {
    if (route === 'chat bytes') await expect(readUploadBytes('message_send_file', { file_path: file }, 1024)).rejects.toThrow()
    else await expect(uploadSessionFile(endpoint, { file_path: file }, { agentId: 'agent', sessionId: 'session', recipients: [] })).rejects.toThrow()
  }
  expect(received).toHaveLength(0)
})
