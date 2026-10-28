// L4 10-02 (主人「现在做」): app_install { device } — installed on another of the owner's machines, which takes the package the
// way it takes a card's. A folder only this machine has goes there as the package app_pack makes, over the device channel
// itself, part by part (#7290: no storage in between), with the sha256 packed here (that machine installs it as a folder,
// those bytes or none); a card is handed over as its message. Naming this machine is the usual install. Goes through the
// real MCP face (session MCP server + tool layer); the machines are fakes.
// Control (parent ff3c98b307): the tool has no device — a strict schema refuses it.
import { mkdtempSync, rmSync, truncateSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest'

const MESSAGE = '0c000000-0000-4000-8000-0000000010a2'
vi.mock('../../../../apps/desktop/electron/mcp/gugu-im-server.mjs', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  extensionAttachmentOf: async () => ({ message_id: MESSAGE }),
}))
// The package app_pack made: 600 KiB, so it goes in two parts (512 KiB, then the rest).
const work = mkdtempSync(join(tmpdir(), 'gugu-l4-device-'))
const PACKAGE = join(work, 'reader-1.0.0.guguext')
const BYTES = Buffer.alloc(600 * 1024, 7)
writeFileSync(PACKAGE, BYTES)
afterAll(() => rmSync(work, { recursive: true, force: true }))

const { createDesktopGuguMcpHost } = await import('../../../../apps/desktop/electron/acp-engine-utils')
type Host = ReturnType<typeof createDesktopGuguMcpHost>

const hosts: Host[] = []
const clients: Client[] = []
afterEach(async () => {
  await Promise.all(clients.splice(0).map((client) => client.close().catch(() => undefined)))
  await Promise.all(hosts.splice(0).map((host) => host.dispose().catch(() => undefined)))
})

const text = (result: unknown): string =>
  ((result as { content?: Array<{ text?: string }> }).content ?? []).map((part) => part.text ?? '').join('')

/** An agent on machine `here`; `other` is another of its owner's machines, answering an install as `otherAnswers` says. */
async function agent(
  otherAnswers: (action: Record<string, unknown>) => Promise<unknown> = async () => ({ installed: true, outcome: 'confirmed', id: 'reader' }),
  // D-31 The person, asked here as this agent's approval.
  asked: (action: Record<string, unknown>) => Promise<unknown> = async () => ({ outcome: 'confirmed' }),
  packageFile = PACKAGE,
) {
  const sessions: Record<string, unknown>[] = []
  const extensions: Record<string, unknown>[] = []
  const host = createDesktopGuguMcpHost()
  hosts.push(host)
  await host.start()
  const grant = await host.grant('l4-device', {
    kind: 'social',
    expectedOwnerUserId: 'owner-1',
    subjectId: 'agent-1',
    supabaseUrl: 'https://supabase.example',
    anonKey: 'anon-key',
    agentId: 'agent-1',
    threadRootId: null,
    guguHome: '/tmp/gugu-l4-device-test',
    getAccessToken: async () => 'token',
    runSessionAction: async (action: unknown) => {
      const record = action as Record<string, unknown>
      sessions.push(record)
      if (record.action === 'devices') return [{ device_id: 'here', this_machine: true }, { device_id: 'other', label: 'mac1 B', this_machine: false }]
      return otherAnswers(record)
    },
    runExtensionAction: async (action: unknown) => {
      extensions.push(action as Record<string, unknown>)
      if ((action as { action: string }).action === 'pack') return { file_path: packageFile, file_name: 'reader-1.0.0.guguext', sha256: 'f'.repeat(64) }
      if ((action as { action: string }).action === 'ask_install') return asked(action as Record<string, unknown>)
      return { installed: true, outcome: 'confirmed', id: 'reader', version: '1.0.0' }
    },
  })
  const client = new Client({ name: 'l4-device', version: '1' })
  clients.push(client)
  await client.connect(new StreamableHTTPClientTransport(new URL(grant.url), { requestInit: { headers: { Authorization: `Bearer ${grant.capability}` } } }))
  const install = async (args: Record<string, unknown>) => {
    const result = await client.callTool({ name: 'app_install', arguments: args })
    return { isError: result.isError === true, body: text(result) }
  }
  const manage = async (args: Record<string, unknown>) => {
    const result = await client.callTool({ name: 'app_manage', arguments: args })
    return { isError: result.isError === true, body: text(result) }
  }
  return { install, manage, sessions, extensions }
}

describe('app_install { device }: installed on another of the owner\'s machines', () => {
  it('a folder only this machine has: packed, sent there part by part over the device channel, then installed by that upload with its digest', async () => {
    const { install, sessions, extensions } = await agent()
    const answer = await install({ source_dir: '/apps/reader', device: 'device:other' })
    expect(answer.isError, answer.body).toBe(false)
    expect(JSON.parse(answer.body)).toMatchObject({ installed: true, outcome: 'confirmed', id: 'reader', device_id: 'device:other' })
    expect(extensions).toEqual([{ action: 'pack', source_dir: '/apps/reader' }])
    const parts = sessions.slice(1, 3).map((action) => action.package_part as { upload_id: string; offset: number; total: number; final: boolean; data: string })
    expect(sessions.slice(1, 3).map((action) => [action.action, action.device])).toEqual([['app_install', 'other'], ['app_install', 'other']])
    expect(parts.map(({ offset, total, final }) => ({ offset, total, final }))).toEqual([
      { offset: 0, total: BYTES.length, final: false },
      { offset: 512 * 1024, total: BYTES.length, final: true },
    ])
    expect(Buffer.concat(parts.map((part) => Buffer.from(part.data, 'base64')))).toEqual(BYTES)
    expect(parts[1]!.upload_id).toBe(parts[0]!.upload_id)
    expect(sessions.slice(3)).toEqual([{ action: 'app_install', device: 'other', package_upload: parts[0]!.upload_id, package_digest: 'f'.repeat(64), consent: { kind: 'return' } }])
  })

  it('a package over 25 MiB is refused here, before a byte goes', async () => {
    const big = join(work, 'big.guguext')
    writeFileSync(big, '')
    truncateSync(big, 25 * 1024 * 1024 + 1)
    const { install, sessions } = await agent(undefined, undefined, big)
    const answer = await install({ source_dir: '/apps/reader', device: 'device:other' })
    expect(answer.isError).toBe(true)
    expect(answer.body).toMatch(/up to 26214400/)
    expect(sessions).toEqual([{ action: 'devices' }])
    rmSync(big)
  })

  it('a card: handed over as its message — nothing packed, nothing sent but the message id', async () => {
    const { install, sessions, extensions } = await agent()
    const answer = await install({ source_message_id: `msg:${MESSAGE}`, device: 'device:other' })
    expect(answer.isError, answer.body).toBe(false)
    expect(extensions).toEqual([])
    expect(sessions).toEqual([{ action: 'devices' }, { action: 'app_install', device: 'other', message_id: MESSAGE, consent: { kind: 'return' } }])
  })

  it('that machine refused or was out of reach: the error is the answer', async () => {
    const { install } = await agent(async () => {
      throw new Error('"mac1 B" (device:other) is offline (last seen 3 min ago); nothing was sent there')
    })
    const answer = await install({ source_dir: '/apps/reader', device: 'device:other' })
    expect(answer.isError).toBe(true)
    expect(answer.body).toContain('is offline')
  })

  it("naming this machine is the usual install: nothing goes anywhere (main's action schema reads no device)", async () => {
    const { install, sessions, extensions } = await agent()
    const answer = await install({ source_dir: '/apps/reader', device: 'device:here' })
    expect(answer.isError, answer.body).toBe(false)
    expect(extensions).toEqual([{ action: 'install', source_dir: '/apps/reader', device: 'here' }])
    expect(sessions).toEqual([{ action: 'devices' }])
  })

  // D-31 The person is asked here, as this agent's approval: that machine hands back its ask, and installs only what they agreed to.
  it('that machine asks: the person is asked here (naming it), and it installs only the bytes agreed to, given where ticked', async () => {
    const ask = { manifest: { id: 'reader', name: 'Reader' }, manifestDigest: 'digest-r', revokedPermissions: [], sourceDir: '/there/x' }
    const asked = vi.fn(async () => ({ outcome: 'confirmed' }))
    const { install, sessions, extensions } = await agent(
      async (action) => (action.consent as { kind: string }).kind === 'return'
        ? { installed: false, outcome: 'ask', id: 'reader', ask }
        : { installed: true, outcome: 'confirmed', id: 'reader' },
      asked,
    )
    const answer = await install({ source_message_id: `msg:${MESSAGE}`, device: 'device:other' })
    expect(answer.isError, answer.body).toBe(false)
    expect(JSON.parse(answer.body)).toMatchObject({ installed: true, device_id: 'device:other' })
    expect(extensions).toEqual([{ action: 'ask_install', request: { ...ask, machine: 'mac1 B' } }])
    expect(sessions.slice(1)).toEqual([
      { action: 'app_install', device: 'other', message_id: MESSAGE, consent: { kind: 'return' } },
      { action: 'app_install', device: 'other', message_id: MESSAGE, consent: { kind: 'given', digest: 'digest-r' } },
    ])
  })

  it('the person says no here: nothing is installed there (what was sent there is swept there)', async () => {
    const ask = { manifest: { id: 'reader', name: 'Reader' }, manifestDigest: 'digest-r', revokedPermissions: [], sourceDir: '/there/x' }
    const { install, sessions } = await agent(async () => ({ installed: false, outcome: 'ask', id: 'reader', ask }), async () => ({ outcome: 'declined' }))
    const answer = await install({ source_dir: '/apps/reader', device: 'device:other' })
    expect(JSON.parse(answer.body)).toEqual({ installed: false, outcome: 'declined', device_id: 'device:other' })
    expect(sessions.filter((action) => action.action === 'app_install' && action.consent)).toHaveLength(1)
  })

  it('device with chat_id is refused before anything happens: the group\'s card goes from here', async () => {
    const { install, sessions, extensions } = await agent()
    const answer = await install({ source_dir: '/apps/reader', chat_id: 'chat-1', device: 'device:other' })
    expect(answer.isError).toBe(true)
    expect(answer.body).toContain('device installs it on that machine only')
    expect([...sessions, ...extensions]).toEqual([])
  })
})


describe('App resource URLs manage the named installed fork without package transfer', () => {
  const url = 'gugu://app/reader?device=other&variant=mine'
  it('reads the target device, with no install or local lookup', async () => {
    const { manage, sessions, extensions } = await agent(async () => ({ active: 'mine', selected: { name: 'mine', dir: '/target/source' } }))
    const answer = await manage({ url })
    expect(answer.isError, answer.body).toBe(false)
    expect(JSON.parse(answer.body).selected.dir).toBe('/target/source')
    expect(sessions).toEqual([{ action: 'devices' }, { action: 'app_manage', device: 'other', operation: 'read', url }])
    expect(extensions).toEqual([])
  })
  it('rejects an unknown device instead of finding a local namesake', async () => {
    const { manage, sessions, extensions } = await agent()
    expect((await manage({ url: url.replace('other', 'missing') })).body).toContain('not registered')
    expect(sessions).toEqual([{ action: 'devices' }])
    expect(extensions).toEqual([])
  })
  it('returns deletion confirmation to the source session, then sends only the exact consent', async () => {
    const ask = { manifest: { id: 'reader', name: 'Reader' }, manifestDigest: 'fork-state', removeVariant: { name: 'mine', active: true } }
    const { manage, sessions, extensions } = await agent(async (action) => (action.consent as { kind: string }).kind === 'return'
      ? { outcome: 'ask', ask, asks: true } : { removed: true, active: 'upstream' })
    const answer = await manage({ url, operation: 'remove' })
    expect(answer.isError, answer.body).toBe(false)
    expect(JSON.parse(answer.body)).toMatchObject({ removed: true, active: 'upstream', device_id: 'device:other' })
    expect(sessions.slice(1).map((row) => row.consent)).toEqual([{ kind: 'return' }, { kind: 'given', digest: 'fork-state' }])
    expect(extensions).toEqual([{ action: 'ask_install', request: { ...ask, machine: 'mac1 B' } }])
  })
  it('a declined switch never sends given consent to the target', async () => {
    const { manage, sessions } = await agent(async () => ({ outcome: 'ask', asks: true, ask: { manifestDigest: 'upstream' } }), async () => ({ outcome: 'declined' }))
    expect(JSON.parse((await manage({ url, operation: 'switch' })).body)).toMatchObject({ installed: false, outcome: 'declined' })
    expect(sessions).toHaveLength(2)
  })
})
