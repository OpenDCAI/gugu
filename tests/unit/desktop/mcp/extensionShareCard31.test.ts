// 摩擦单 F31(L5,S1 第三轮):app_install(chat_id) 两次都报「refusing to double-encode "msg:…" as a msg: id」——
// 装上了、卡片也发了,错在回包:MCP 层把 message_id 编成 msg: 之后,工具层(sessionpage-tool-registrar)又编一次。
// 这里走真的 MCP 面(会话 MCP server + 工具层),只把「发卡片」这一步换成假的(它自己的单测在 guguImMcp)。
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { afterEach, describe, expect, it, vi } from 'vitest'

const CARD = '0c000000-0000-4000-8000-000000000031'
const sendCard = vi.fn()
vi.mock('../../../../apps/desktop/electron/mcp/gugu-im-server.mjs', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  sendExtensionCardOf: (...args: unknown[]) => sendCard(...args),
}))

const { createDesktopGuguMcpHost } = await import('../../../../apps/desktop/electron/acp-engine-utils')
type Host = ReturnType<typeof createDesktopGuguMcpHost>

const hosts: Host[] = []
const clients: Client[] = []
afterEach(async () => {
  sendCard.mockReset()
  await Promise.all(clients.splice(0).map((client) => client.close().catch(() => undefined)))
  await Promise.all(hosts.splice(0).map((host) => host.dispose().catch(() => undefined)))
})

const text = (result: unknown): string =>
  ((result as { content?: Array<{ text?: string }> }).content ?? []).map((part) => part.text ?? '').join('')

async function agent(first: string) {
  const seen: unknown[] = []
  let version = first
  const host = createDesktopGuguMcpHost()
  hosts.push(host)
  await host.start()
  const grant = await host.grant('f31', {
    kind: 'social',
    expectedOwnerUserId: 'owner-1',
    subjectId: 'agent-1',
    supabaseUrl: 'https://supabase.example',
    anonKey: 'anon-key',
    agentId: 'agent-1',
    threadRootId: null,
    guguHome: '/tmp/gugu-f31-test',
    getAccessToken: async () => 'token',
    runSessionAction: async () => ({}),
    runExtensionAction: async (action: unknown) => {
      seen.push(action)
      const name = (action as { action: string }).action
      if (name === 'bump') {
        const [major, minor, patch] = version.split('.').map(Number)
        version = `${major}.${minor}.${patch! + 1}`
        return { version }
      }
      if (name === 'install') return { installed: true, id: 'dinner-vote', version, next: 'It is in the chat as a card now.' }
      if (name === 'pack_installed') return { file_path: '/tmp/gugu-app-cards/dinner-vote-1.0.0.guguext', file_name: 'dinner-vote-1.0.0.guguext', sha256: 'e'.repeat(64), version }
      return { file_path: `/tmp/dinner-vote-${version}.guguext`, file_name: `dinner-vote-${version}.guguext`, sha256: 'f'.repeat(64), version }
    },
  })
  const client = new Client({ name: 'f31', version: '1' })
  clients.push(client)
  await client.connect(new StreamableHTTPClientTransport(new URL(grant.url), { requestInit: { headers: { Authorization: `Bearer ${grant.capability}` } } }))
  const call = async (tool: string, args: Record<string, unknown> = { source_dir: '/tmp/vote', chat_id: 'chat-1' }) => {
    // app_install is in the catalog (#7335) but still answers to its own name; app_pack goes through catalog_call.
    const result = tool === 'app_install'
      ? await client.callTool({ name: tool, arguments: args })
      : await client.callTool({ name: 'catalog_call', arguments: { tool, args } })
    return { isError: result.isError === true, body: text(result) }
  }
  return { install: (args?: Record<string, unknown>) => call('app_install', args), pack: () => call('app_pack'), seen }
}

describe('app_install { chat_id }: the answer carries the card, typed once (F31)', () => {
  it('first install sends the card: message_id is msg:<id>, not an error', async () => {
    sendCard.mockResolvedValue({ messageId: CARD, alreadyThere: false, differs: false })
    const { install, seen } = await agent('1.0.0')
    const answer = await install()
    expect(answer.isError, answer.body).toBe(false)
    expect(JSON.parse(answer.body)).toMatchObject({ installed: true, message_id: `msg:${CARD}`, next: 'It is in the chat as a card now.' })
    expect(seen).toEqual([{ action: 'install', source_dir: '/tmp/vote', chat_id: 'chat-1' }, { action: 'pack', source_dir: '/tmp/vote' }])
    expect(sendCard).toHaveBeenCalledWith(expect.anything(), {
      chatId: 'chat-1', filePath: '/tmp/dinner-vote-1.0.0.guguext', fileName: 'dinner-vote-1.0.0.guguext', sha256: 'f'.repeat(64),
    })
  })

  it('same version again: the card already there is answered, and the agent is told nothing new went out', async () => {
    sendCard.mockResolvedValue({ messageId: CARD, alreadyThere: true, differs: false })
    const answer = await (await agent('1.0.0')).install()
    expect(answer.isError, answer.body).toBe(false)
    const body = JSON.parse(answer.body)
    expect(body.message_id).toBe(`msg:${CARD}`)
    expect(body.next).toMatch(/^Already in the chat: it has this version's card \(message_id\), so nothing new was sent\./)
  })

  // 摩擦单 F107(L5 S22 对照组):改了内容、没改版本号,旧写法回「Raise version…」,agent 只好自己改了再装一遍。
  // 现在由这一次调用把补丁号升上去(写回 manifest.json),装上、打包、发出那一版的卡,回包照实说升到了几。
  it('same version, other contents: the version goes up one patch, that version is installed and its card sent', async () => {
    const NEXT = '0c000000-0000-4000-8000-000000000107'
    sendCard
      .mockResolvedValueOnce({ messageId: CARD, alreadyThere: true, differs: true })
      .mockResolvedValueOnce({ messageId: NEXT, alreadyThere: false, differs: false })
    const { install, seen } = await agent('1.0.0')
    const body = JSON.parse((await install()).body)
    expect(seen).toEqual([
      { action: 'install', source_dir: '/tmp/vote', chat_id: 'chat-1' },
      { action: 'pack', source_dir: '/tmp/vote' },
      { action: 'bump', source_dir: '/tmp/vote' },
      { action: 'install', source_dir: '/tmp/vote', chat_id: 'chat-1' },
      { action: 'pack', source_dir: '/tmp/vote' },
    ])
    expect(sendCard.mock.calls[1][1]).toMatchObject({ fileName: 'dinner-vote-1.0.1.guguext' })
    expect(body).toMatchObject({ version: '1.0.1', message_id: `msg:${NEXT}` })
    expect(body.next).toMatch(/1\.0\.1/)
  })

  // L3's review of F107: the answer says what the second card did, the new version first — never "sent" when it was not.
  it('bumped, and the group has that version\'s card too: the version is said, and that nothing new was sent', async () => {
    sendCard
      .mockResolvedValueOnce({ messageId: CARD, alreadyThere: true, differs: true })
      .mockResolvedValueOnce({ messageId: CARD, alreadyThere: true, differs: false })
    const body = JSON.parse((await (await agent('1.0.0')).install()).body)
    expect(body.next).toMatch(/^The chat had a card of dinner-vote-1\.0\.0\.guguext with other contents, so the version went up to 1\.0\.1/)
    expect(body.next).toMatch(/nothing new was sent/)
  })

  it('bumped, then the card could not be sent: the answer says manifest.json now holds the new version', async () => {
    sendCard
      .mockResolvedValueOnce({ messageId: CARD, alreadyThere: true, differs: true })
      .mockRejectedValueOnce(new Error('message_send_file: read the group rules first'))
    const body = JSON.parse((await (await agent('1.0.0')).install()).body)
    expect(body.message_id).toBeUndefined()
    expect(body.next).toMatch(/went up to 1\.0\.1 \(manifest\.json says so now\)[\s\S]*The card was not sent/)
  })

  // L6 S8:pack(chat_id) 同样报 double-encode,而卡片早已发出 —— 群里最后 4 张一样的卡。
  it('app_pack with chat_id: the same answer — msg:<id> once, not an error', async () => {
    sendCard.mockResolvedValue({ messageId: CARD, alreadyThere: false, differs: false })
    const { pack, seen } = await agent('1.0.0')
    const answer = await pack()
    expect(answer.isError, answer.body).toBe(false)
    expect(JSON.parse(answer.body)).toMatchObject({ file_name: 'dinner-vote-1.0.0.guguext', message_id: `msg:${CARD}` })
    expect(seen).toEqual([{ action: 'pack', source_dir: '/tmp/vote', chat_id: 'chat-1' }])
  })

  // 副作用已经发生的,回包绝不能是 error:装上了、卡没发出去,是一句话,不是一次失败的调用。
  it('installed but the card could not be sent: not an error — installed, and the reason said', async () => {
    sendCard.mockRejectedValue(new Error('message_send_file: read the group rules first'))
    const answer = await (await agent('1.0.0')).install()
    expect(answer.isError, answer.body).toBe(false)
    const body = JSON.parse(answer.body)
    expect(body.installed).toBe(true)
    expect(body.message_id).toBeUndefined()
    expect(body.next).toBe('The card was not sent (message_send_file: read the group rules first); nothing went into the chat.')
  })

  it('a card of this version whose bytes could not be read back: answered as there, nothing sent', async () => {
    sendCard.mockResolvedValue({ messageId: CARD, alreadyThere: true, differs: null })
    const body = JSON.parse((await (await agent('1.0.0')).install()).body)
    expect(body.message_id).toBe(`msg:${CARD}`)
    expect(body.next).toMatch(/^Already in the chat: it has a card of dinner-vote-1\.0\.0\.guguext \(message_id\); its contents could not be compared/)
  })

  // 5-minute game rounds 2-3 (10-29): an App installed here goes into another chat as its installed copy, as a market App does.
  it('an App installed here (app): its installed copy is packed for the card; never bumped, it has no folder', async () => {
    sendCard.mockResolvedValue({ messageId: CARD, alreadyThere: true, differs: true })
    const { install, seen } = await agent('1.0.0')
    const answer = await install({ app: 'dinner-vote', chat_id: 'chat-1' })
    expect(answer.isError, answer.body).toBe(false)
    expect(seen).toEqual([{ action: 'install', app: 'dinner-vote', chat_id: 'chat-1' }, { action: 'pack_installed', id: 'dinner-vote' }])
    expect(JSON.parse(answer.body).next).toMatch(/with other contents too, so nothing new was sent/)
  })

  it('app without chat_id is refused on the tool face: it is installed already', async () => {
    const answer = await (await agent('1.0.0')).install({ app: 'dinner-vote' })
    expect(answer.isError).toBe(true)
    expect(answer.body).toContain('app is installed here already — give chat_id')
  })

  it('a new version sends a new card', async () => {
    const NEXT = '0c000000-0000-4000-8000-000000000032'
    sendCard.mockResolvedValue({ messageId: NEXT, alreadyThere: false, differs: false })
    const body = JSON.parse((await (await agent('1.1.0')).install()).body)
    expect(body.message_id).toBe(`msg:${NEXT}`)
    expect(sendCard.mock.calls[0][1]).toMatchObject({ fileName: 'dinner-vote-1.1.0.guguext' })
  })
})
