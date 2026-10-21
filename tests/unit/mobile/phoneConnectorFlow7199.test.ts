import { createServer, type IncomingMessage, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { buildIntegrationListPayload } from '../../../apps/desktop/electron/session/main/core/integrations/integration-payload-builder'
import { phoneNextRoute, phoneParentRoute } from '../../../apps/desktop/src/mobile/assistant/phoneRoutes'
import {
  accountLabel,
  connectorHealth,
  connectSub,
  connectWithInput,
  disconnectIntegration,
  failureKey,
  formatDay,
  OAUTH_TIMEOUT_MS,
  parseAuthorizationReturn,
  parseConnectorSub,
  randomOauthAttempt,
  removeGithubAccount,
  setupPlanOf,
  startCliSetup,
  startGithubSetup,
  startOauthSetup,
  type CliPrompt,
  type CliSetupState,
  type ConnectOutcome,
  type GithubDeviceCode,
  type GithubSetupState,
  type OauthPending,
  type OauthSetupDeps,
  type OauthState,
} from '../../../apps/desktop/src/mobile/assistant/phoneConnectorFlow'
import { beginMcpAuthorization } from '../../../apps/desktop/src/session/shared/mcp-oauth-client'

// #7199 手机助理 App 的「连接应用」:桌面连一家的那几步在手机上换成等价的(表单页、系统浏览器授权 + 贴回地址、
// 命令行的链接 / 二维码、GitHub 设备码),断开先确认。机器那一头用假的 rpc(记下调用与参数),OAuth 那一头用一个真的
// 本机授权服务(同桌面 mcp-oauth-flow.test.ts),由真的 MCP SDK 走完发现 → 注册 → PKCE → 换令牌。

describe('setupPlanOf —— 每一家在手机上走哪条路', () => {
  const catalog = buildIntegrationListPayload('zh-CN')
  const plan = (id: string, platformKind: 'capacitor' | 'web' = 'capacitor') => setupPlanOf(catalog.find((item) => item.id === id)!, platformKind)

  it('目录里的二十家都有手机上走得通的路:没有一家落到 no-method', () => {
    expect(catalog.length).toBeGreaterThanOrEqual(20)
    const stuck = catalog.filter((item) => {
      const result = setupPlanOf(item, 'capacitor')
      return result.kind === 'unavailable'
    })
    expect(stuck.map((item) => item.id)).toEqual([])
  })

  it('GitHub 设备码、官方命令行(钉钉 / 企业微信)、浏览器授权(五家)、其余填表', () => {
    expect(plan('github')).toEqual({ kind: 'github' })
    expect(plan('dingtalk')).toEqual({ kind: 'cli' })
    expect(plan('wecom')).toEqual({ kind: 'cli' })
    expect(plan('feishu')).toEqual({ kind: 'cli' })
    expect(plan('tencent-docs')).toMatchObject({ kind: 'browser' })
    expect(plan('dida')).toMatchObject({ kind: 'browser' })
    expect(plan('notion')).toMatchObject({ kind: 'browser' })
    expect(plan('linear')).toMatchObject({ kind: 'browser' })
    for (const id of ['qq-mail', 'netease-mail', 'enterprise-mail', 'jira', 'asana', 'gitlab', 'forgejo', 'trello', 'monday', 'plain', 'plane', 'featurebase']) {
      expect(plan(id)).toEqual({ kind: 'form' })
    }
  })

  it('手机浏览器里的网页版没有原生 HTTP:浏览器授权的五家如实说要 App,其余不变', () => {
    expect(plan('feishu', 'web')).toEqual({ kind: 'cli' })
    expect(plan('qq-mail', 'web')).toEqual({ kind: 'form' })
    expect(plan('dingtalk', 'web')).toEqual({ kind: 'cli' })
    expect(plan('github', 'web')).toEqual({ kind: 'github' })
  })

  it('目录里没有认得的连接方式 = 说去电脑连,❌ 摆一个必败的钮', () => {
    expect(setupPlanOf({ id: 'future', auth: { methods: [{ kind: 'oauth' }] } }, 'capacitor')).toEqual({ kind: 'unavailable', reason: 'no-method' })
  })
})

describe('连接页的路由名', () => {
  it('connector:<id> 详情、connector:<id>:connect 连接页;别的不认', () => {
    expect(parseConnectorSub('connector:feishu')).toEqual({ id: 'feishu', view: 'detail' })
    expect(parseConnectorSub(connectSub('qq-mail'))).toEqual({ id: 'qq-mail', view: 'connect' })
    expect(parseConnectorSub('connector:feishu:edit')).toBeNull()
    expect(parseConnectorSub('connectors')).toBeNull()
    expect(parseConnectorSub(null)).toBeNull()
  })

  it('返回箭头:连接页回详情,详情回列表(手机自己的表)', () => {
    expect(phoneParentRoute({ tab: 'profile', sub: connectSub('feishu') })).toEqual({ tab: 'profile', sub: 'connector:feishu' })
    expect(phoneParentRoute({ tab: 'profile', sub: 'connector:feishu' })).toEqual({ tab: 'profile', sub: 'connectors' })
  })

  it('资料页直接连接:取消和完成都回资料页,不绕详情', () => {
    const connect = phoneNextRoute({ tab: 'profile' }, { tab: 'profile', sub: connectSub('qq-mail') })
    expect(phoneParentRoute(connect)).toEqual({ tab: 'profile', sub: undefined })
    expect(phoneNextRoute(connect, { tab: 'profile', sub: 'connector:qq-mail' })).toEqual({ tab: 'profile', sub: undefined })
  })

  it('从连接列表或详情进入,分别回到原来的列表或详情', () => {
    const list = { tab: 'profile', sub: 'connectors' }
    const detail = { tab: 'profile', sub: 'connector:qq-mail' }
    expect(phoneParentRoute(phoneNextRoute(list, { tab: 'profile', sub: connectSub('qq-mail') }))).toEqual(list)
    expect(phoneParentRoute(phoneNextRoute(detail, { tab: 'profile', sub: connectSub('qq-mail') }))).toEqual(detail)
  })
})

describe('parseAuthorizationReturn —— 人贴回来的回跳', () => {
  const expected = { state: 'st-1' }

  it('完整网址、没带协议的、只复制了查询串,都认得出授权码', () => {
    expect(parseAuthorizationReturn('http://127.0.0.1:50000/callback?code=abc&state=st-1', expected)).toEqual({ kind: 'code', code: 'abc' })
    expect(parseAuthorizationReturn('  127.0.0.1:50000/callback?code=abc&state=st-1#x ', expected)).toEqual({ kind: 'code', code: 'abc' })
    expect(parseAuthorizationReturn('code=abc&state=st-1', expected)).toEqual({ kind: 'code', code: 'abc' })
  })

  it('拒绝授权:带出对方的说明', () => {
    expect(parseAuthorizationReturn('http://127.0.0.1:1/callback?error=access_denied&error_description=No&state=st-1', expected)).toEqual({ kind: 'denied', description: 'No' })
    expect(parseAuthorizationReturn('http://127.0.0.1:1/callback?error=access_denied&state=st-1', expected)).toEqual({ kind: 'denied', description: 'access_denied' })
  })

  it('state 不对 = 另一次授权的或被改过的,不收(与桌面监听同样严)', () => {
    expect(parseAuthorizationReturn('http://127.0.0.1:1/callback?code=abc&state=other', expected)).toEqual({ kind: 'invalid', reason: 'state-mismatch' })
    expect(parseAuthorizationReturn('http://127.0.0.1:1/callback?code=abc', expected)).toEqual({ kind: 'invalid', reason: 'state-mismatch' })
    expect(parseAuthorizationReturn('http://127.0.0.1:1/callback?error=access_denied&state=other', expected)).toEqual({ kind: 'invalid', reason: 'state-mismatch' })
  })

  it('不是回跳:空的、授权页地址、随手一段话', () => {
    expect(parseAuthorizationReturn('   ', expected)).toEqual({ kind: 'invalid', reason: 'empty' })
    expect(parseAuthorizationReturn('https://accounts.example/authorize?client_id=c&state=st-1', expected)).toEqual({ kind: 'invalid', reason: 'not-callback' })
    expect(parseAuthorizationReturn('我复制错了', expected)).toEqual({ kind: 'invalid', reason: 'not-callback' })
  })
})

describe('randomOauthAttempt', () => {
  it('回跳是回环地址的动态端口,state 是 URL 安全的随机串,每次不同', () => {
    const a = randomOauthAttempt()
    const b = randomOauthAttempt()
    expect(a.redirectUrl).toMatch(/^http:\/\/127\.0\.0\.1:(49[1-9]\d\d|[5-6]\d{4})\/callback$/)
    expect(Number(new URL(a.redirectUrl).port)).toBeGreaterThanOrEqual(49152)
    expect(a.state).toMatch(/^[A-Za-z0-9_-]{24}$/)
    expect(a.state).not.toBe(b.state)
  })
})

describe('connectWithInput —— 表单 / 凭据交给助理的家', () => {
  it('提交:原样把输入交给 connect,成功带回账号名', async () => {
    const calls: Array<Record<string, unknown>> = []
    const connect = async (input: Record<string, unknown>): Promise<ConnectOutcome> => {
      calls.push(input)
      return { success: true, displayName: 'me@qq.com' }
    }
    const result = await connectWithInput(connect, { email: 'me@qq.com', password: 'code-1' })
    expect(calls).toEqual([{ email: 'me@qq.com', password: 'code-1' }])
    expect(result).toEqual({ ok: true, displayName: 'me@qq.com' })
  })

  it('对方不认:说是「保存」这一步没成,带那一家分好的类,原话作补充', async () => {
    const result = await connectWithInput(async () => ({ success: false, error: 'IMAP login failed', errorType: 'auth_failed' }), {})
    expect(result).toEqual({ ok: false, failure: { step: 'save', reason: 'rejected', errorType: 'auth_failed', detail: 'IMAP login failed' } })
  })

  it('请求本身抛了(线断了):也是这一步没成,❌ 往外抛', async () => {
    const result = await connectWithInput(async () => {
      throw new Error('link closed')
    }, {})
    expect(result).toEqual({ ok: false, failure: { step: 'save', reason: 'failed', detail: 'link closed' } })
  })

  it('对方的话很长只留一小段', async () => {
    const result = await connectWithInput(async () => ({ success: false, error: 'x'.repeat(500) }), {})
    expect(result.ok === false && result.failure.detail?.length).toBe(201)
  })
})

describe('failureKey / connectorHealth / 小件', () => {
  it('拒绝、超时各一句,其余按哪一步', () => {
    expect(failureKey({ step: 'authorize', reason: 'denied' })).toBe('denied')
    expect(failureKey({ step: 'authorize', reason: 'timeout' })).toBe('timeout')
    expect(failureKey({ step: 'exchange', reason: 'failed' })).toBe('failedAt.exchange')
    expect(failureKey({ step: 'save', reason: 'rejected' })).toBe('failedAt.save')
  })

  it('核得通 ok;对方不认 / 授权失效 = 重新授权;限流这类不当成要重新授权;没核到不当成有问题', () => {
    expect(connectorHealth({ connected: true })).toBe('ok')
    expect(connectorHealth({ connected: false, errorType: 'authorization_expired' })).toBe('reauth')
    expect(connectorHealth({ connected: false, errorType: 'auth_failed' })).toBe('reauth')
    expect(connectorHealth({ connected: false, errorType: 'rate_limited' })).toBe('issue')
    expect(connectorHealth({ connected: false })).toBe('issue')
    expect(connectorHealth(undefined)).toBe('unknown')
  })

  it('账号名 > 邮箱 > 这一家的名字;连接日期用本地日', () => {
    expect(accountLabel({ displayName: '小明', fields: { email: 'a@b.c' } }, 'QQ 邮箱')).toBe('小明')
    expect(accountLabel({ fields: { email: 'a@b.c' } }, 'QQ 邮箱')).toBe('a@b.c')
    expect(accountLabel({ fields: {} }, 'QQ 邮箱')).toBe('QQ 邮箱')
    expect(formatDay(new Date(2026, 9, 16, 12).getTime())).toBe('2026-10-16')
  })
})

describe('断开', () => {
  it('整家断开不带 accountId;多账号只断开点的那一个', async () => {
    const calls: Array<[string, string | undefined]> = []
    const disconnect = async (id: string, accountId?: string) => {
      calls.push([id, accountId])
      return { success: true }
    }
    await disconnectIntegration(disconnect, 'dida')
    await disconnectIntegration(disconnect, 'qq-mail', 'imap.qq.com:me@qq.com')
    expect(calls).toEqual([
      ['dida', undefined],
      ['qq-mail', 'imap.qq.com:me@qq.com'],
    ])
  })

  it('没断成就抛(确认卡留在原地说「没断开」,❌ 关了卡当作断开了)', async () => {
    await expect(disconnectIntegration(async () => ({ success: false, error: 'locked' }), 'dida')).rejects.toThrow('locked')
    await expect(removeGithubAccount(async () => ({ success: false }), 'gh-1')).rejects.toThrow()
  })

  it('GitHub 的账号走自己的移除口', async () => {
    const removed: string[] = []
    await removeGithubAccount(async (accountId) => {
      removed.push(accountId)
      return { success: true }
    }, 'gh-1')
    expect(removed).toEqual(['gh-1'])
  })
})

// ── 浏览器授权:真授权服务 + 真 SDK ─────────────────────────────────────────────

type Recorded = { path: string; body: string }
const servers: Server[] = []

afterEach(async () => {
  vi.useRealTimers()
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((resolve) => {
          server.closeAllConnections()
          server.close(() => resolve())
        }),
    ),
  )
})

async function readBody(request: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = []
  for await (const chunk of request) chunks.push(chunk as Buffer)
  return Buffer.concat(chunks).toString('utf8')
}

/** 一个最小的 OAuth 授权服务(受保护资源元数据、AS 元数据、动态注册、令牌)。`tokenStatus` 非 200 = 换令牌失败。 */
async function startAuthServer(options: { tokenStatus?: number } = {}) {
  const requests: Recorded[] = []
  let base = ''
  const server = createServer((request, response) => {
    void (async () => {
      const url = new URL(request.url ?? '/', base)
      const body = await readBody(request)
      requests.push({ path: url.pathname, body })
      const json = (status: number, value: unknown) => {
        response.writeHead(status, { 'Content-Type': 'application/json' })
        response.end(JSON.stringify(value))
      }
      if (url.pathname === '/mcp' && request.method === 'POST') {
        response.writeHead(401, { 'WWW-Authenticate': 'Bearer' })
        response.end()
      } else if (url.pathname.startsWith('/.well-known/oauth-protected-resource')) {
        json(200, { resource: base, authorization_servers: [base] })
      } else if (url.pathname === '/.well-known/oauth-authorization-server') {
        json(200, {
          issuer: base,
          authorization_endpoint: `${base}/authorize`,
          token_endpoint: `${base}/token`,
          registration_endpoint: `${base}/register`,
          response_types_supported: ['code'],
          grant_types_supported: ['authorization_code', 'refresh_token'],
          code_challenge_methods_supported: ['S256'],
          token_endpoint_auth_methods_supported: ['none'],
        })
      } else if (url.pathname === '/register') {
        json(201, { ...(JSON.parse(body) as Record<string, unknown>), client_id: 'client-1' })
      } else if (url.pathname === '/token') {
        if (options.tokenStatus && options.tokenStatus !== 200) json(options.tokenStatus, { error: 'invalid_grant' })
        else json(200, { access_token: 'access-1', token_type: 'bearer', refresh_token: 'refresh-1', expires_in: 3600 })
      } else {
        response.writeHead(404).end()
      }
    })()
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  servers.push(server)
  return { serverUrl: `${base}/mcp`, requests, tokenRequests: () => requests.filter((request) => request.path === '/token') }
}

type Harness = {
  states: OauthState[]
  opened: string[]
  connected: Array<Record<string, unknown>>
  deps: OauthSetupDeps
  attempt: { redirectUrl: string; state: string }
}

function harness(options: { connect?: (credentials: Record<string, unknown>) => Promise<ConnectOutcome>; timeoutMs?: number; begin?: OauthSetupDeps['begin']; fetchFn?: Parameters<typeof beginMcpAuthorization>[0]['fetchFn'] } = {}): Harness {
  const attempt = randomOauthAttempt()
  const states: OauthState[] = []
  const opened: string[] = []
  const connected: Array<Record<string, unknown>> = []
  const deps: OauthSetupDeps = {
    begin: options.begin ?? ((input) => beginMcpAuthorization({ ...input, ...(options.fetchFn ? { fetchFn: options.fetchFn } : {}) }) as Promise<OauthPending>),
    openUrl: (url) => opened.push(url),
    connect:
      options.connect ??
      (async (credentials) => {
        connected.push(credentials)
        return { success: true, displayName: '张三' }
      }),
    newAttempt: () => attempt,
    ...(options.timeoutMs ? { timeoutMs: options.timeoutMs } : {}),
  }
  return { states, opened, connected, deps, attempt }
}

/** 等状态序列里出现某一相(状态机是异步的:准备、换令牌都要走网络)。 */
async function until(states: OauthState[], phase: OauthState['phase']): Promise<OauthState> {
  for (let i = 0; i < 400; i += 1) {
    const hit = states.find((state) => state.phase === phase)
    if (hit) return hit
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
  throw new Error(`never reached ${phase}: ${states.map((state) => state.phase).join(',')}`)
}

/** 扮演浏览器:授权页地址 → 同意后的回跳地址(回环端口上没人听,人从地址栏复制它)。 */
function approve(authorizationUrl: string, mutate: (redirect: URL) => void = () => {}): string {
  const authorization = new URL(authorizationUrl)
  const redirect = new URL(authorization.searchParams.get('redirect_uri') ?? '')
  redirect.searchParams.set('code', 'code-1')
  redirect.searchParams.set('state', authorization.searchParams.get('state') ?? '')
  mutate(redirect)
  return redirect.toString()
}

describe('startOauthSetup —— 浏览器授权的状态机(手机这一半)', () => {
  it('开系统浏览器等人贴回地址 → 换令牌 → 凭据交给助理的家 connect → 已连接带账号名', async () => {
    const auth = await startAuthServer()
    const h = harness()
    const handle = startOauthSetup(h.deps, { serverUrl: auth.serverUrl }, (state) => h.states.push(state))
    expect(h.states[0]).toEqual({ phase: 'preparing' })
    const awaiting = await until(h.states, 'awaiting')
    expect(awaiting).toMatchObject({ phase: 'awaiting' })

    // 系统浏览器被交了授权页地址:带 PKCE、带这一次的 state、回跳是我们登记过的那个回环地址。
    expect(h.opened).toHaveLength(1)
    const authorization = new URL(h.opened[0]!)
    expect(authorization.searchParams.get('code_challenge_method')).toBe('S256')
    expect(authorization.searchParams.get('state')).toBe(h.attempt.state)
    expect(authorization.searchParams.get('redirect_uri')).toBe(h.attempt.redirectUrl)
    const registration = auth.requests.find((request) => request.path === '/register')
    expect(JSON.parse(registration?.body ?? '{}')).toMatchObject({ redirect_uris: [h.attempt.redirectUrl], token_endpoint_auth_method: 'none' })

    handle.submit(approve(h.opened[0]!))
    const done = await until(h.states, 'done')
    expect(done).toEqual({ phase: 'done', displayName: '张三' })
    expect(h.states.map((state) => state.phase)).toEqual(['preparing', 'awaiting', 'finishing', 'done'])

    const [exchange] = auth.tokenRequests()
    const form = new URLSearchParams(exchange?.body)
    expect(form.get('grant_type')).toBe('authorization_code')
    expect(form.get('code')).toBe('code-1')
    expect(form.get('code_verifier')).toBeTruthy()
    // 交给 connect 的就是桌面远程授权交的那份记录(令牌 + 注册的客户端 + 回跳地址)。
    expect(h.connected).toHaveLength(1)
    expect(h.connected[0]).toMatchObject({
      serverUrl: auth.serverUrl,
      redirectUrl: h.attempt.redirectUrl,
      clientInformation: { client_id: 'client-1' },
      tokens: { access_token: 'access-1', refresh_token: 'refresh-1' },
    })
  })

  it('人在授权页点了拒绝:说是「拒绝」,不换令牌、不 connect', async () => {
    const auth = await startAuthServer()
    const h = harness()
    const handle = startOauthSetup(h.deps, { serverUrl: auth.serverUrl }, (state) => h.states.push(state))
    await until(h.states, 'awaiting')
    handle.submit(
      approve(h.opened[0]!, (redirect) => {
        redirect.searchParams.delete('code')
        redirect.searchParams.set('error', 'access_denied')
        redirect.searchParams.set('error_description', 'The user denied access')
      }),
    )
    const failed = await until(h.states, 'failed')
    expect(failed).toEqual({ phase: 'failed', failure: { step: 'authorize', reason: 'denied', detail: 'The user denied access' } })
    expect(auth.tokenRequests()).toEqual([])
    expect(h.connected).toEqual([])
  })

  it('贴了另一次授权的回跳:留在等待并提示,不换令牌;贴对的接着走', async () => {
    const auth = await startAuthServer()
    const h = harness()
    const handle = startOauthSetup(h.deps, { serverUrl: auth.serverUrl }, (state) => h.states.push(state))
    await until(h.states, 'awaiting')
    handle.submit(approve(h.opened[0]!, (redirect) => redirect.searchParams.set('state', 'forged')))
    expect(h.states.at(-1)).toMatchObject({ phase: 'awaiting', hint: 'state-mismatch' })
    handle.submit('随手复制的一句话')
    expect(h.states.at(-1)).toMatchObject({ phase: 'awaiting', hint: 'not-callback' })
    expect(auth.tokenRequests()).toEqual([])
    handle.submit(approve(h.opened[0]!))
    await until(h.states, 'done')
    expect(auth.tokenRequests()).toHaveLength(1)
  })

  it('没人贴回来:超时(与桌面等回跳同一个五分钟),之后晚到的回跳不再收', async () => {
    const auth = await startAuthServer()
    const h = harness({ timeoutMs: 60 })
    const handle = startOauthSetup(h.deps, { serverUrl: auth.serverUrl }, (state) => h.states.push(state))
    await until(h.states, 'awaiting')
    const failed = await until(h.states, 'failed')
    expect(failed).toEqual({ phase: 'failed', failure: { step: 'authorize', reason: 'timeout' } })
    const before = h.states.length
    handle.submit(approve(h.opened[0]!))
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(h.states).toHaveLength(before)
    expect(auth.tokenRequests()).toEqual([])
    expect(OAUTH_TIMEOUT_MS).toBe(5 * 60_000)
  })

  it('等回跳时取消:终局是 cancelled,晚到的回跳不换令牌、不 connect', async () => {
    const auth = await startAuthServer()
    const h = harness()
    const handle = startOauthSetup(h.deps, { serverUrl: auth.serverUrl }, (state) => h.states.push(state))
    await until(h.states, 'awaiting')
    handle.cancel()
    expect(h.states.at(-1)).toEqual({ phase: 'cancelled' })
    handle.submit(approve(h.opened[0]!))
    handle.reopen()
    await new Promise((resolve) => setTimeout(resolve, 30))
    expect(h.states.at(-1)).toEqual({ phase: 'cancelled' })
    expect(h.opened).toHaveLength(1)
    expect(auth.tokenRequests()).toEqual([])
    expect(h.connected).toEqual([])
  })

  it('准备到一半取消:不会再弹出浏览器', async () => {
    const auth = await startAuthServer()
    const h = harness()
    let release: () => void = () => {}
    const gate = new Promise<void>((resolve) => (release = resolve))
    const slowBegin: OauthSetupDeps['begin'] = async (input) => {
      await gate
      return beginMcpAuthorization(input)
    }
    const handle = startOauthSetup({ ...h.deps, begin: slowBegin }, { serverUrl: auth.serverUrl }, (state) => h.states.push(state))
    handle.cancel()
    release()
    await new Promise((resolve) => setTimeout(resolve, 80))
    expect(h.states.map((state) => state.phase)).toEqual(['preparing', 'cancelled'])
    expect(h.opened).toEqual([])
  })

  it('授权服务连不上:说是「准备」这一步没成,可重试(再来一次换新的 state)', async () => {
    const h = harness()
    const handle = startOauthSetup(h.deps, { serverUrl: 'http://127.0.0.1:1/mcp' }, (state) => h.states.push(state))
    const failed = await until(h.states, 'failed')
    expect(failed).toMatchObject({ phase: 'failed', failure: { step: 'prepare', reason: 'failed' } })
    expect(h.opened).toEqual([])
    handle.submit('code=x&state=y')
    expect(h.states.at(-1)).toBe(failed)
  })

  it('换令牌被拒:说是「换令牌」这一步没成,不 connect', async () => {
    const auth = await startAuthServer({ tokenStatus: 400 })
    const h = harness()
    const handle = startOauthSetup(h.deps, { serverUrl: auth.serverUrl }, (state) => h.states.push(state))
    await until(h.states, 'awaiting')
    handle.submit(approve(h.opened[0]!))
    const failed = await until(h.states, 'failed')
    expect(failed).toMatchObject({ phase: 'failed', failure: { step: 'exchange' } })
    expect(h.connected).toEqual([])
  })

  it('助理的家核对不过:带那一家分好的类,说是「保存」这一步没成', async () => {
    const auth = await startAuthServer()
    const h = harness({ connect: async () => ({ success: false, error: 'token rejected', errorType: 'authorization_expired' }) })
    const handle = startOauthSetup(h.deps, { serverUrl: auth.serverUrl }, (state) => h.states.push(state))
    await until(h.states, 'awaiting')
    handle.submit(approve(h.opened[0]!))
    const failed = await until(h.states, 'failed')
    expect(failed).toEqual({ phase: 'failed', failure: { step: 'save', reason: 'rejected', errorType: 'authorization_expired', detail: 'token rejected' } })
  })

  it('重新打开授权页:同一个地址再交给浏览器', async () => {
    const auth = await startAuthServer()
    const h = harness()
    const handle = startOauthSetup(h.deps, { serverUrl: auth.serverUrl }, (state) => h.states.push(state))
    await until(h.states, 'awaiting')
    handle.reopen()
    expect(h.opened).toHaveLength(2)
    expect(h.opened[1]).toBe(h.opened[0])
  })

  it('手机原生 HTTP 那条线(CapacitorHttp 形状的假实现)一样走得通:JSON 响应已解析成对象、401 的头读得到、表单体是字符串', async () => {
    const { createNativeFetch } = await import('../../../apps/desktop/src/mobile/assistant/phoneNativeFetch')
    const auth = await startAuthServer()
    const seen: Array<{ method?: string; contentType?: string; dataType: string }> = []
    // Capacitor 原生返回 { data, status, headers }:JSON 内容类型的 data 已是对象,别的是字符串。
    const native = createNativeFetch({
      request: async (options) => {
        const headers = options.headers ?? {}
        seen.push({ method: options.method, contentType: headers['Content-Type'] ?? headers['content-type'], dataType: typeof options.data })
        const real = await fetch(options.url, {
          method: options.method,
          headers,
          ...(options.data !== undefined ? { body: options.data as string } : {}),
        })
        const text = await real.text()
        const isJson = (real.headers.get('content-type') ?? '').includes('application/json')
        return { data: isJson && text ? JSON.parse(text) : text, status: real.status, headers: Object.fromEntries(real.headers.entries()), url: options.url }
      },
    })
    const h = harness({ fetchFn: native })
    const handle = startOauthSetup(h.deps, { serverUrl: auth.serverUrl }, (state) => h.states.push(state))
    await until(h.states, 'awaiting')
    handle.submit(approve(h.opened[0]!))
    await until(h.states, 'done')
    expect(seen.length).toBeGreaterThanOrEqual(4)
    expect(seen.some((call) => call.method === 'POST' && call.contentType?.includes('application/json') && call.dataType === 'string')).toBe(true)
    // 换令牌是表单:体是字符串,头是 x-www-form-urlencoded。
    expect(seen.some((call) => call.contentType?.includes('application/x-www-form-urlencoded') && call.dataType === 'string')).toBe(true)
  })
})

// ── 官方命令行 ──────────────────────────────────────────────────────────

function cliHarness(waits: Array<Awaited<ReturnType<Parameters<typeof startCliSetup>[0]['wait']>> | Error>, start?: Awaited<ReturnType<Parameters<typeof startCliSetup>[0]['start']>> | Error) {
  const states: CliSetupState[] = []
  const calls: string[] = []
  const prompt: CliPrompt = { kind: 'device-link', url: 'https://login.dingtalk.com/?user_code=AB-12', code: 'AB-12' }
  const queue = [...waits]
  const deps = {
    start: async () => {
      calls.push('start')
      if (start instanceof Error) throw start
      return start ?? { success: true as const, prompt }
    },
    wait: async () => {
      calls.push('wait')
      const next = queue.shift()
      if (!next) return new Promise<never>(() => {})
      if (next instanceof Error) throw next
      return next
    },
    cancel: async () => {
      calls.push('cancel')
    },
  }
  return { states, calls, deps, prompt }
}

async function untilCli(states: CliSetupState[], phase: CliSetupState['phase']) {
  for (let i = 0; i < 200; i += 1) {
    const hit = states.find((state) => state.phase === phase)
    if (hit) return hit
    await new Promise((resolve) => setTimeout(resolve, 2))
  }
  throw new Error(`never reached ${phase}: ${states.map((state) => state.phase).join(',')}`)
}

describe('startCliSetup —— 官方命令行', () => {
  it('复用已验证的个人授权时直接完成，不再等待另一次扫码', async () => {
    const h = cliHarness([], { success: true, connected: true })
    startCliSetup(h.deps, (state) => h.states.push(state))
    await untilCli(h.states, 'done')
    expect(h.states.map((state) => state.phase)).toEqual(['starting', 'done'])
    expect(h.calls).toEqual(['start'])
  })

  it('飞书第二步的授权提示替换第一步，而不是继续展示已完成的配置链接', async () => {
    const prompt: CliPrompt = { kind: 'qr-code', image: 'data:image/png;base64,USER', url: 'https://accounts.feishu.cn/verify' }
    const h = cliHarness([{ status: 'pending', prompt }, { status: 'connected' }])
    startCliSetup(h.deps, (state) => h.states.push(state))
    await untilCli(h.states, 'done')
    expect(h.states).toContainEqual({ phase: 'waiting', prompt })
    expect(h.states.map((state) => state.phase)).toEqual(['starting', 'waiting', 'waiting', 'done'])
  })

  it('起登录拿到链接 + 授权码 → 一问一答等「还在等」→ 连上', async () => {
    const h = cliHarness([{ status: 'pending' }, { status: 'pending' }, { status: 'connected' }])
    startCliSetup(h.deps, (state) => h.states.push(state))
    await untilCli(h.states, 'done')
    expect(h.states.map((state) => state.phase)).toEqual(['starting', 'waiting', 'done'])
    expect(h.states[1]).toEqual({ phase: 'waiting', prompt: h.prompt })
    expect(h.calls).toEqual(['start', 'wait', 'wait', 'wait'])
  })

  it('二维码那种:提示原样交给界面(图 + 可打开的链接)', async () => {
    const qr: CliPrompt = { kind: 'qr-code', image: 'data:image/png;base64,AAA', url: 'https://work.weixin.qq.com/x' }
    const h = cliHarness([{ status: 'connected' }], { success: true, prompt: qr })
    startCliSetup(h.deps, (state) => h.states.push(state))
    await untilCli(h.states, 'done')
    expect(h.states[1]).toEqual({ phase: 'waiting', prompt: qr })
  })

  it('装 / 起登录没成:说是「装工具」这一步,带工具自己的话', async () => {
    const h = cliHarness([], { success: false, error: 'download failed' })
    startCliSetup(h.deps, (state) => h.states.push(state))
    const failed = await untilCli(h.states, 'failed')
    expect(failed).toEqual({ phase: 'failed', failure: { step: 'install', reason: 'failed', detail: 'download failed' } })
  })

  it('登录没成(过期 / 没确认):说是「登录」这一步', async () => {
    const h = cliHarness([{ status: 'failed', error: 'The login expired before it was confirmed.' }])
    startCliSetup(h.deps, (state) => h.states.push(state))
    const failed = await untilCli(h.states, 'failed')
    expect(failed).toMatchObject({ phase: 'failed', failure: { step: 'login', reason: 'failed' } })
  })

  it('等的时候线断了(手机与助理的家之间):说出来,❌ 一直转圈', async () => {
    const h = cliHarness([{ status: 'pending' }, new Error('link closed')])
    startCliSetup(h.deps, (state) => h.states.push(state))
    const failed = await untilCli(h.states, 'failed')
    expect(failed).toMatchObject({ phase: 'failed', failure: { step: 'login', detail: 'link closed' } })
  })

  it('取消:撤掉那台机器上的登录,之后晚到的结果不再改页面', async () => {
    const h = cliHarness([{ status: 'pending' }])
    const handle = startCliSetup(h.deps, (state) => h.states.push(state))
    await untilCli(h.states, 'waiting')
    handle.cancel()
    expect(h.states.at(-1)).toEqual({ phase: 'cancelled' })
    expect(h.calls).toContain('cancel')
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(h.states.at(-1)).toEqual({ phase: 'cancelled' })
  })
})

// ── GitHub 设备码 ───────────────────────────────────────────────────────

describe('startGithubSetup —— GitHub 设备码', () => {
  function githubHarness(auth: () => Promise<Awaited<ReturnType<Parameters<typeof startGithubSetup>[0]['auth']>>>) {
    const states: GithubSetupState[] = []
    const calls: string[] = []
    let listener: ((code: GithubDeviceCode) => void) | null = null
    const deps = {
      onCode: (next: (code: GithubDeviceCode) => void) => {
        calls.push('subscribe')
        listener = next
        return () => {
          calls.push('unsubscribe')
          listener = null
        }
      },
      auth: async () => {
        calls.push('auth')
        return auth()
      },
      cancel: async () => {
        calls.push('cancel')
      },
    }
    return { states, calls, deps, push: (code: GithubDeviceCode) => listener?.(code) }
  }
  const code: GithubDeviceCode = { userCode: 'WDJB-MJHT', verificationUri: 'https://github.com/login/device', expiresIn: 900 }

  it('先订设备码推送、再发起授权;码到了摆给人,授权成功带账号', async () => {
    let finish: (value: { success: true; account: { login: string } }) => void = () => {}
    const h = githubHarness(() => new Promise((resolve) => (finish = resolve)))
    startGithubSetup(h.deps, (state) => h.states.push(state))
    expect(h.calls).toEqual(['subscribe', 'auth'])
    h.push(code)
    expect(h.states.at(-1)).toEqual({ phase: 'code', code })
    finish({ success: true, account: { login: 'octocat' } })
    await new Promise((resolve) => setTimeout(resolve, 5))
    expect(h.states.at(-1)).toEqual({ phase: 'done', login: 'octocat' })
    expect(h.calls).toContain('unsubscribe')
  })

  it('码过期 / 拒绝:说是 GitHub 这一步没成,带原话', async () => {
    const h = githubHarness(async () => ({ success: false, error: 'Code expired' }))
    startGithubSetup(h.deps, (state) => h.states.push(state))
    await new Promise((resolve) => setTimeout(resolve, 5))
    expect(h.states.at(-1)).toEqual({ phase: 'failed', failure: { step: 'github', reason: 'failed', detail: 'Code expired' } })
  })

  it('取消:退订、撤掉那台机器上的设备码轮询;晚到的成功不再改页面', async () => {
    let finish: (value: { success: true; account: { login: string } }) => void = () => {}
    const h = githubHarness(() => new Promise((resolve) => (finish = resolve)))
    const handle = startGithubSetup(h.deps, (state) => h.states.push(state))
    h.push(code)
    handle.cancel()
    expect(h.states.at(-1)).toEqual({ phase: 'cancelled' })
    expect(h.calls).toEqual(['subscribe', 'auth', 'unsubscribe', 'cancel'])
    finish({ success: true, account: { login: 'octocat' } })
    await new Promise((resolve) => setTimeout(resolve, 5))
    expect(h.states.at(-1)).toEqual({ phase: 'cancelled' })
  })
})

describe('等回跳的时限', () => {
  it('默认五分钟:四分五十九秒还在等,到五分钟超时', async () => {
    const auth = await startAuthServer()
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] })
    const h = harness()
    startOauthSetup(h.deps, { serverUrl: auth.serverUrl }, (state) => h.states.push(state))
    // 准备走真网络:等它到「等回跳」。
    for (let i = 0; i < 200 && !h.states.some((state) => state.phase === 'awaiting'); i += 1) await vi.advanceTimersByTimeAsync(5)
    expect(h.states.at(-1)?.phase).toBe('awaiting')
    await vi.advanceTimersByTimeAsync(OAUTH_TIMEOUT_MS - 1000)
    expect(h.states.at(-1)?.phase).toBe('awaiting')
    await vi.advanceTimersByTimeAsync(1000)
    expect(h.states.at(-1)).toMatchObject({ phase: 'failed', failure: { reason: 'timeout' } })
  })
})
