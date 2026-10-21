import { randomUUID } from 'node:crypto'
import { createServer, request, type Server } from 'node:http'
import { AddressInfo } from 'node:net'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { afterEach, describe, expect, test } from 'vitest'
import { createDesktopGuguMcpHost, type DesktopGuguMcpHost } from '../../../../apps/desktop/electron/acp-engine-utils'
import { buildSessionBundle, renderSessionPromptBlocks } from '../../../../apps/desktop/electron/capability-bundle'

// #3575 —— owner 第 4 条(「能 2 次调用工具的你调用了 3 次就是行为不对劲」)只能由**调用计数**承载。
// 本文件建的是那台仪器,并且**先证明它数的是那件事**,再拿它去数 agent。
//
// 为什么不能用宿主自己的 `trackRequest`:`gugu-mcp-host.ts:241-247` 把它接成
// `record.activeRequests` 这个**在飞请求 Set**(settle 即 delete) —— 它没有累计量,
// 从来就不是计数器。⇒ 计数只能自己建。
//
// 两个数、一台仪器、同一个窗口:
//   B = 到达宿主边界的 `tools/call` 请求数        ← 必须在宿主侧取(客户端数自己发了几个是错的一侧)
//   A = 其中真正进了 dispatch 的那些              ← 由响应正文分类;正文在代理与在 client 是同一份字节,
//                                                  ⇒ 分类在哪一侧读都一样 ⇒ 不必解 SSE 帧
//
// ⚠️ 那个 `2` 只在 vitest 里是**判据**,在 rig 里必须降级成**读数**:真跑的传输层还会有
// GET(开 SSE)/DELETE(关会话)/断线重连/多次 initialize ⇒ 硬断言 2 会把一次【合法的】真跑判红,
// 而偏离会被归到 agent 头上、读成「它多调了 N 次」。⇒ **同一个数字,一处是判据、一处是上下文。**
// 这条分割是**结构性**的,不靠注释:`startCountingProxy` / `wireWithAccounting` 里一个
// `expect(` 都没有 —— 它们只产出数字,断言全在下面的 test 体内。rig 复用 helper 就只拿到读数。
// ⇒ rig 里唯一保留的硬判别是 `mcpHandshakeObserved`(allPosts >= 2):它是活性锚,与调用次数正交。
//
// ⚠️ B 必须按 JSON-RPC method 过滤,不能数「到达的 HTTP 请求」:StreamableHTTP 还有
// initialize / notifications/initialized / GET(开 SSE 流) / DELETE(关会话)。数它们会让 B−A
// 被传输层开销污染,读成「agent 发了 N 次畸形调用」。请求**体**是明文 JSON(SSE 只在响应侧),
// 所以按 method 过滤仍然不需要解帧。

const OWNER_ID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'

/** 已知的错误签名。⚠️ 认不出的一律 fail loud —— 措辞一改就静默错桶、而总数仍然对得上。 */
const SIGNATURES = [
  { key: 'schema' as const, marker: '参数不合法', reachedDispatch: false },
  { key: 'schema' as const, marker: 'Input validation error', reachedDispatch: false },
  { key: 'command-context' as const, marker: 'agent command context is missing', reachedDispatch: true },
  { key: 'command-rpc' as const, marker: 'command RPC transport failed', reachedDispatch: true },
]

const hosts: DesktopGuguMcpHost[] = []
const clients: Client[] = []
const proxies: Server[] = []

afterEach(async () => {
  await Promise.all(clients.splice(0).map((client) => client.close().catch(() => undefined)))
  await Promise.all(hosts.splice(0).map((host) => host.dispose().catch(() => undefined)))
  await Promise.all(proxies.splice(0).map((proxy) => new Promise<void>((resolve) => proxy.close(() => resolve()))))
})

/**
 * 测试侧转发代理 —— 只计数,不改写。产品码零改动(仓规:❌ 产品内测试探针)。
 * 计的是**请求体里 method === 'tools/call'** 的那些,不是「到达的 HTTP 请求」。
 */
async function startCountingProxy(
  target: string,
): Promise<{ url: string; toolCalls: () => number; allPosts: () => number }> {
  const upstream = new URL(target)
  let toolCalls = 0
  // ② 不过滤的那个数一起记 —— 让仪器在【每一次真跑】里重新证明自己没瞎:
  // 两者之差应当恒等于传输层那几发(vitest 实测 2 = initialize + notifications/initialized)。
  // 真跑里若偏离,差值读数当场存疑,而不是等别人事后发现。
  let allPosts = 0
  const proxy = createServer((clientReq, clientRes) => {
    const chunks: Buffer[] = []
    clientReq.on('data', (chunk) => chunks.push(chunk))
    clientReq.on('end', () => {
      const body = Buffer.concat(chunks)
      if (clientReq.method === 'POST' && body.length > 0) {
        allPosts += 1
        // 非 JSON-RPC 体不计数;它不是「0 次调用」,是「这条不是工具调用」。
        try {
          if ((JSON.parse(body.toString('utf8')) as { method?: string }).method === 'tools/call') toolCalls += 1
        } catch { /* 保持不计数 */ }
      }
      const forwarded = request(
        {
          hostname: upstream.hostname,
          port: upstream.port,
          path: clientReq.url,
          method: clientReq.method,
          headers: { ...clientReq.headers, host: upstream.host, 'content-length': String(body.length) },
        },
        (upstreamRes) => {
          clientRes.writeHead(upstreamRes.statusCode ?? 502, upstreamRes.headers)
          // SSE 必须**流式**透传 —— 缓冲会让响应永远不到达,表现成「工具调用卡住」。
          upstreamRes.pipe(clientRes)
        },
      )
      forwarded.on('error', () => clientRes.writeHead(502).end())
      forwarded.end(body)
    })
  })
  proxies.push(proxy)
  await new Promise<void>((resolve) => proxy.listen(0, '127.0.0.1', () => resolve()))
  const { port } = proxy.address() as AddressInfo
  return {
    url: `http://127.0.0.1:${port}${upstream.pathname}`,
    toolCalls: () => toolCalls,
    allPosts: () => allPosts,
  }
}

/**
 * 把每次工具调用的返回分类成 A 的一格。
 *
 * ⚠️ 认不出的签名**不归桶**,但也**不抛** —— 真 agent 跑起来会带来网络/认证/REST 那些
 * 没列过的正文,一抛就把整轮读数变成【缺席】,而缺席读起来像"没跑到"不像"有个没认出的签名"。
 * ⇒ 收进 `unclassified` 当读数:作废的是【差值这一个指标】,不是整轮。
 * ⇒ fail loud 由调用方断言 `unclassified` 为空来承担(vitest 里那就是红)。
 */
function classify(text: string): { reachedDispatch: boolean; recognized: boolean } {
  const hit = SIGNATURES.find((signature) => text.includes(signature.marker))
  if (!hit) return { reachedDispatch: false, recognized: false }
  return { reachedDispatch: hit.reachedDispatch, recognized: true }
}

async function wireWithAccounting() {
  const agentUserId = randomUUID()
  const chatId = randomUUID()
  const host = createDesktopGuguMcpHost()
  hosts.push(host)
  // 走**产品自己的组装点**(`capability-bundle.ts:224`),不是直接 buildSocialBridge ——
  // 于是 rig 拿到的 grant 与 promptBlocks 出自同一次组装,投给 agent 的系统文本就是产品的那份。
  // ⚠️ 三块各有各的判定,❌ 不并成一句可见域:
  //   platform        编译期常量 ⇒ 这里【有】真实文本
  //   identity        要查库 ⇒ 这里【没有】。读过它的模板:只给 participant_id/display_name,
  //                   ❌ 不给 per-turn chat_id、❌ 无发送指令 ⇒ 不覆盖本票的按轮显式事实。
  //                   但 special_focus 是创建者自由文本 ⇒ ❌ 不覆盖带 special_focus 的 agent。
  //   threadBootstrap 空历史时产品自己也返回空串 ⇒ 对 fresh conversation【不是缺口】;
  //                   ❌ 不覆盖有历史的 thread 首轮(且该块在场会推 agent 更靠近工具 ⇒
  //                   缺它时若仍调用,读数更强不更弱)。
  const bundle = await buildSessionBundle({
    runtime: {
      authProvider: { getAuth: async () => ({ accessToken: 'token', userId: OWNER_ID }) },
      env: { GUGU_HOME: '/tmp/gugu-tool-call-accounting-3575' },
    },
    agentUserId,
    threadRootId: null,
    autonomy: null,
    socialBridgeDeps: {
      host,
      grantKey: `accounting-${agentUserId}`,
      getSupabaseUrl: () => 'https://supabase.example',
      getSupabaseAnonKey: () => 'anon-key',
    },
  })
  const [server] = bundle.mcpServers
  if (!('url' in server)) throw new Error('expected the Gugu bridge to use HTTP transport')
  const proxy = await startCountingProxy(server.url)
  const client = new Client({ name: 'gugu-accounting-probe', version: '1.0.0' })
  clients.push(client)
  await client.connect(new StreamableHTTPClientTransport(new URL(proxy.url), {
    requestInit: { headers: Object.fromEntries(server.headers!.map((h) => [h.name, h.value])) },
  }))

  let reached = 0
  const unclassified: string[] = []
  const call = async (args: Record<string, unknown>) => {
    const result = await client.callTool({ name: 'message_send', arguments: args })
    const content = (result as { content?: Array<{ text?: string }> }).content
    const text = content?.[0]?.text ?? ''
    const verdict = classify(text)
    if (!verdict.recognized) unclassified.push(text)
    if (verdict.reachedDispatch) reached += 1
    return text
  }
  return {
    call,
    chatId,
    B: proxy.toolCalls,
    A: () => reached,
    allPosts: proxy.allPosts,
    unclassified: () => unclassified,
    // ⚠️ 一身两职:差值里要**减掉**这几发,活性判别里要**靠**它们。
    // `initialize` + `notifications/initialized` 是 agent 的 MCP 客户端活着的证明,
    // 而它与「调了几次工具」**正交** —— 不随被测命题的真假一起消失。
    // ⇒ 于是「调用次数 0」的两种成因可以在【读数层】分开,不必等人看首屏截图:
    //     allPosts == 0            ⇒ MCP 面从未连上(TLS/装配死在更早)⇒ 装置读数,❌ 不是产品读数
    //     allPosts >= 2 且 B == 0  ⇒ 连上了、握了手、一次工具都没调 ⇒ 这才是产品读数
    // ⇒ 所以它是结论里的一个**字段**,❌ 不只是校正项。
    mcpHandshakeObserved: () => proxy.allPosts() >= 2,
    // 投给 agent 的系统文本 —— 产品的 `renderSessionPromptBlocks`,❌ 不是我手写的一段话。
    // 提示词是被测主语的一部分:手写的能跑通、结果还好看,它不会红,只是安静地测另一件事。
    systemPrompt: () => renderSessionPromptBlocks(bundle.promptBlocks),
  }
}

describe('#3575 tool-call accounting measures tool calls, not transport traffic', () => {
  /**
   * ⚠️ **先跑这条**:它比 schema 阳控更早可得,且 schema 阳控**抓不到**它守的东西 ——
   * 传输层那几发(initialize / GET SSE / DELETE)发生在**建连时**,不在 schema 阳控的观测窗口里。
   * ⇒ 「阳控证明仪器会数」不等于「它数的是那件事」。
   */
  test('connect without calling any tool → B is 0 (transport traffic is not counted)', async () => {
    const { B, A, allPosts, mcpHandshakeObserved } = await wireWithAccounting()

    expect(B()).toBe(0)
    expect(A()).toBe(0)
    // 「零调用」在这里是**产品读数**,不是装置死了 —— 由握手活性把两者分开。
    expect(mcpHandshakeObserved()).toBe(true)
    // 传输层那几发**确实存在**(否则 B==0 可能只是代理根本没在数) —— 这是 B==0 的阳性对照。
    expect(allPosts()).toBe(2)
  })

  /** 洞 2:schema 不合法的调用在 SDK 入参校验阶段就被拒,永远到不了 dispatch。 */
  test('one schema-rejected call → B increments, A does not', async () => {
    const { call, B, A, allPosts, unclassified } = await wireWithAccounting()

    const text = await call({}) // text/chat_id 缺失 ⇒ schema 必拒

    expect(text).toContain('Input validation error')
    expect(B()).toBe(1)
    expect(A()).toBe(0)
    expect(unclassified()).toEqual([])
    expect(allPosts() - B()).toBe(2) // 传输层开销恒定;偏离即差值读数存疑
  })

  /** 第 1 条的反向:B 只数 tools/call,但**不得漏数**真的工具调用。 */
  test('one dispatched call → B and A both increment', async () => {
    const { call, chatId, B, A, allPosts, unclassified } = await wireWithAccounting()

    const text = await call({ chat_id: chatId, text: 'reply', to_user_ids: [`user:${OWNER_ID}`] })

    expect(text).toContain('command RPC transport failed') // schema 通过，dispatch 已进入 command-gated RPC
    expect(B()).toBe(1)
    expect(A()).toBe(1)
    expect(unclassified()).toEqual([])
    expect(allPosts() - B()).toBe(2)
  })
})
