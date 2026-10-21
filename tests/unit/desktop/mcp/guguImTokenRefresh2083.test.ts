// @vitest-environment jsdom
import { createServer, type IncomingMessage } from 'node:http'
import { type AddressInfo } from 'node:net'
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { describe, expect, test, vi } from 'vitest'
import { createDesktopGuguMcpHost } from '../../../../apps/desktop/electron/acp-engine-utils'

vi.hoisted(() => {
  process.env.GUGU_AGENT_ID = 'agent-1'
  process.env.GUGU_ACCESS_TOKEN = 'STALE_TOKEN'
})
// @ts-expect-error -- the injectable MCP server is an untyped ESM module.
import { callTool as callToolImpl, restGet as restGetImpl, RpcHttpError } from '../../../../apps/desktop/electron/mcp/gugu-im-server.mjs'

const SESSION_CONTEXT = {
  supabaseUrl: '', anonKey: '', agentId: 'agent-1', threadRootId: null,
  guguHome: '/tmp/gugu-im-token-test',
}
function callTool(name: string, args: Record<string, unknown>, deps: Record<string, unknown>) {
  const { readHostSessionToken, ...injected } = deps
  const getAccessToken = typeof readHostSessionToken === 'function'
    ? () => readHostSessionToken()
    : async () => 'STALE_TOKEN'
  return callToolImpl({ ...SESSION_CONTEXT, getAccessToken }, name, args, injected)
}
const restGet = (path: string) => restGetImpl({
  ...SESSION_CONTEXT,
  getAccessToken: async () => 'STALE_TOKEN',
}, path)

// S2b:per-turn command lease/context 已退役 —— 发帖是稳定 id 直插 restInsert('messages', row)。
function makeDeps(overrides: Record<string, unknown> = {}) {
  const inserted: Array<{ table: string; row: Record<string, unknown> }> = []
  const deps: Record<string, unknown> = {
    restGet: async () => [],
    restPatch: async () => {},
    restInsert: async (table: string, row: Record<string, unknown>) => { inserted.push({ table, row }) },
    // @@@5856 同上:kind / 成员名单现在是 RPC 读,发帖路径必经。
    restRpc: async (name: string) => {
      if (name === 'chat_facts') return [{ id: 'c1', kind: 'group', source_chat_id: null, group_prompt: null }]
      if (name === 'list_member_ids') {
        return ['agent-1', 'owner-1', '77777777-7777-4777-8777-777777777777'].map((user_id) => ({ user_id, role: 'member' }))
      }
      return null
    },
    readHostSessionToken: async () => null,
    storageUpload: async () => {},
    storagePublicUrl: (_bucket: string, path: string) => `https://storage.test/${path}`,
    storageRemove: async () => {},
    ...overrides,
  }
  return { deps, inserted }
}

describe('#2051 command message token refresh', () => {
  test('REST preflight 401 is structured so the same fresh-token retry path can handle it', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('secret body', { status: 401 })))
    const error = await restGet('chat_members?chat_id=eq.c1').catch((value: unknown) => value)
    expect(error).toBeInstanceOf(RpcHttpError)
    expect((error as RpcHttpError).status).toBe(401)
    vi.unstubAllGlobals()
  })

  test('HTTP adapter status errors are normalized instead of escaping as generic errors', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => {
      const error = new Error('adapter response') as Error & { status?: number }
      error.status = 401
      throw error
    }))
    const error = await restGet('chat_members?chat_id=eq.c1').catch((value: unknown) => value)
    expect(error).toBeInstanceOf(RpcHttpError)
    expect((error as RpcHttpError).status).toBe(401)
    vi.unstubAllGlobals()
  })

  test('401 followed by a fresh owner token retries the same stable row', async () => {
    const rows: Array<Record<string, unknown>> = []
    let attempts = 0
    const { deps } = makeDeps({
      restInsert: async (_table: string, row: Record<string, unknown>) => {
        rows.push(structuredClone(row))
        attempts += 1
        if (attempts === 1) throw new RpcHttpError(401, { accessToken: 'STALE_TOKEN' })
      },
      readHostSessionToken: async () => 'FRESH_TOKEN',
    })
    const result = await callTool('message_send', { chat_id: 'c1', text: 'retry' }, deps)
    expect(result).toMatch(/^sent \(id=/)
    expect(rows).toHaveLength(2)
    expect(rows[1].id).toBe(rows[0].id)
  })

  test('preflight REST 401 reloads the host token and retries the same stable row once', async () => {
    let reads = 0
    let restAttempts = 0
    const { deps, inserted } = makeDeps({
      restGet: async () => {
        restAttempts += 1
        if (restAttempts === 1) throw new RpcHttpError(401, { accessToken: 'STALE_TOKEN' })
        return []
      },
      readHostSessionToken: async () => {
        reads += 1
        return 'FRESH_TOKEN_PREFLIGHT'
      },
    })
    const result = await callTool('message_send', { chat_id: 'c1', text: 'preflight retry' }, deps)
    expect(result).toMatch(/^sent \(id=/)
    expect(reads).toBe(1)
    expect(restAttempts).toBeGreaterThan(1)
    expect(inserted).toHaveLength(1)
  })

  test.each([
    ['missing', null],
    ['unchanged', 'STALE_TOKEN'],
  ])('401 with %s host token fails the current command instead of queuing', async (_label, token) => {
    const { deps } = makeDeps({
      restInsert: async () => { throw new RpcHttpError(401, { accessToken: 'STALE_TOKEN' }) },
      readHostSessionToken: async () => token,
    })
    await expect(
      callTool('message_send', { chat_id: 'c1', text: 'x' }, deps),
    ).rejects.toThrow(/401/)
  })

  // #4191:gugu_ask / gugu_widget 已删除(假面/裁撤)。
  // 'file' 一例已删 —— message_send_file 的发帖不再有 401 刷新重试:isRefreshableAuthError 重试
  // 只包在 handleMessage 的 attemptSend(send/reply)外面(S2b 后共享的 lease post helper 退役)。
  test('message output retries one stable row after insert 401', async () => {
    const rows: Array<Record<string, unknown>> = []
    let insertCalls = 0
    let tokenReads = 0
    const { deps } = makeDeps({
      restInsert: async (_table: string, row: Record<string, unknown>) => {
        insertCalls += 1
        rows.push(structuredClone(row))
        if (insertCalls === 1) throw new RpcHttpError(401, { accessToken: 'STALE_TOKEN' })
      },
      readHostSessionToken: async () => {
        tokenReads += 1
        return `FRESH_message_${tokenReads}`
      },
    })
    await expect(
      callTool('message_send', { chat_id: 'c1', text: 'message' }, deps),
    ).resolves.toEqual(expect.any(String))
    expect(tokenReads).toBe(1)
    expect(insertCalls).toBe(2)
    expect(rows[1]).toEqual(rows[0])
  })

  test('two real MCP grants read current tokens from only their owning context', async () => {
    type HostLabel = 'A' | 'B'
    const agentId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
    const chatId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
    const observed: Record<HostLabel, Array<{ authorization: string; rowId: string }>> = { A: [], B: [] }
    const readBody = async (request: IncomingMessage): Promise<string> => {
      const chunks: Buffer[] = []
      for await (const chunk of request) chunks.push(Buffer.from(chunk))
      return Buffer.concat(chunks).toString('utf8')
    }
    const server = createServer((request, response) => {
      void (async () => {
        if (request.method === 'GET') {
          const path = String(request.url ?? '')
          response.writeHead(200, { 'content-type': 'application/json' })
          response.end(path.includes('/chat_members')
            ? JSON.stringify([
                { user_id: agentId },
                { user_id: '77777777-7777-4777-8777-777777777777' },
              ])
            : path.includes('/chats') ? JSON.stringify([{ kind: 'dm' }]) : '[]')
          return
        }
        // 发送边界不读取收件箱；其余 RPC 仍返回空以覆盖无关调用。
        const rpcUrl = String(request.url ?? '')
        if (rpcUrl.includes('/rest/v1/rpc/')) {
          await readBody(request)
          response.writeHead(200, { 'content-type': 'application/json' })
          // @@@5856 kind 与成员名单从裸读 /chats、/chat_members 改成按 actor 的 DEFINER RPC
          // (MCP 拿的是主人的 JWT,agent 在「主人不在的那条线」上裸读一行都拿不到)。
          // 这个假上游照着原来那两条 GET 的答案答,发送边界的行为一行不变。
          response.end(rpcUrl.includes('/rpc/chat_facts')
            ? JSON.stringify([{ id: chatId, kind: 'dm', source_chat_id: null, group_prompt: null }])
            : rpcUrl.includes('/rpc/list_member_ids')
              ? JSON.stringify([
                  { user_id: agentId, role: 'member', listen_mode: 'active' },
                  { user_id: '77777777-7777-4777-8777-777777777777', role: 'member', listen_mode: 'active' },
                ])
              : '[]')
          return
        }
        const authorization = String(request.headers.authorization ?? '')
        const label: HostLabel | null = authorization.endsWith('_A') ? 'A' : authorization.endsWith('_B') ? 'B' : null
        // S2b:发帖是稳定 id 直插 /rest/v1/messages,body 就是 row 本身(不再包 p_message)。
        const body = JSON.parse(await readBody(request)) as { id?: string }
        if (!label || typeof body.id !== 'string') {
          response.writeHead(403)
          response.end()
          return
        }
        observed[label].push({ authorization, rowId: body.id })
        if (authorization === `Bearer STALE_${label}`) {
          response.writeHead(401)
          response.end()
          return
        }
        if (authorization !== `Bearer FRESH_${label}`) {
          response.writeHead(403)
          response.end()
          return
        }
        response.writeHead(201, { 'content-type': 'application/json' })
        response.end()
      })().catch(() => {
        response.writeHead(500)
        response.end()
      })
    })
    await new Promise<void>((resolveListen, rejectListen) => {
      server.once('error', rejectListen)
      server.listen(0, '127.0.0.1', resolveListen)
    })
    const address = server.address() as AddressInfo
    const root = await mkdtemp(join(tmpdir(), 'gugu-mcp-host-home-'))
    const mcpHost = createDesktopGuguMcpHost()
    await mcpHost.start()

    const listRelativeFiles = async (directory: string, prefix = ''): Promise<string[]> => {
      const files: string[] = []
      for (const entry of await readdir(directory, { withFileTypes: true })) {
        const relative = prefix ? `${prefix}/${entry.name}` : entry.name
        if (entry.isDirectory()) files.push(...await listRelativeFiles(join(directory, entry.name), relative))
        else files.push(relative)
      }
      return files
    }
    const runHost = async (label: HostLabel): Promise<void> => {
      const home = join(root, `home-${label}`)
      await mkdir(join(home, 'runtime-sessions'), { recursive: true, mode: 0o700 })
      await writeFile(
        join(home, 'runtime-sessions', `${agentId}.json`),
        JSON.stringify({ access_token: `FRESH_${label}`, refresh_token: `NEVER_READ_${label}` }),
        { mode: 0o600 },
      )
      const surfaceKey = `token-refresh:${label}`
      const surface = await mcpHost.grant(surfaceKey, {
        kind: 'social',
        expectedOwnerUserId: `owner-${label}`,
        subjectId: agentId,
        supabaseUrl: `http://127.0.0.1:${address.port}`,
        anonKey: 'public-test-key',
        guguHome: home,
        agentId,
        threadRootId: null,
        getAccessToken: async () => {
          const raw = await readFile(join(home, 'runtime-sessions', `${agentId}.json`), 'utf8')
          return JSON.parse(raw).access_token as string
        },
      })
      // 交给客户端的字节里没有 refresh token，也没有 owner 的长期凭据 —— 只有一把会话 capability。
      expect(JSON.stringify(surface)).not.toContain('refresh')
      expect(JSON.stringify(surface)).not.toContain('STALE_')
      const client = new Client({ name: `host-${label}`, version: '1.0.0' })
      const transport = new StreamableHTTPClientTransport(new URL(surface.url), {
        requestInit: { headers: { Authorization: `Bearer ${surface.capability}` } },
      })
      try {
        await client.connect(transport)
        const result = await client.callTool({
          name: 'message_send',
          arguments: {
            chat_id: chatId,
            to_user_ids: ['user:77777777-7777-4777-8777-777777777777'],
            text: `host ${label} retry`,
          },
        })
        expect(result.isError).not.toBe(true)
      } finally {
        await client.close().catch(() => undefined)
        await mcpHost.revoke(surfaceKey).catch(() => undefined)
      }
      expect((await listRelativeFiles(home)).filter((path) => /outbox/i.test(path))).toEqual([])
    }

    try {
      await runHost('A')
      await runHost('B')
      for (const label of ['A', 'B'] as const) {
        expect(observed[label].map((call) => call.authorization)).toEqual([
          `Bearer FRESH_${label}`,
        ])
        expect(observed[label]).toHaveLength(1)
      }
      expect(observed.A.some((call) => call.authorization.includes('FRESH_B'))).toBe(false)
      expect(observed.B.some((call) => call.authorization.includes('FRESH_A'))).toBe(false)
      expect(JSON.stringify(observed)).not.toContain('NEVER_READ')
    } finally {
      await mcpHost.dispose()
      await new Promise<void>((resolveClose) => server.close(() => resolveClose()))
      await rm(root, { recursive: true, force: true })
    }
  })
})
