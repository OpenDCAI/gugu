// #6921 签发响应的 `callable_routes` 从宿主一路走到 codex 的两条起法:
//  · ACP 腿:acpInjector → AcpPlatformInjection(真 zod schema)→ codex 的 buildSpawn argv;
//  · app-server 腿:platformModelForSession → withPlatformDeclaration → 物化器的 argsAppend;
// 以及咕咕的本机凭据代理不把那个开关头送出本机。
import { createServer, type IncomingHttpHeaders } from 'node:http'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const listAgents = vi.fn<(...args: unknown[]) => Promise<unknown>>()
const loadEngine = vi.fn<(...args: unknown[]) => Promise<unknown>>()
const resolveAgentModelLaunch = vi.fn<(...args: unknown[]) => Promise<unknown>>()
const revokePlatformModelAccess = vi.fn<(...args: unknown[]) => Promise<void>>(async () => undefined)
vi.mock('@gugu/core', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  listAgents: (...args: unknown[]) => listAgents(...args),
}))
vi.mock('../../../../apps/desktop/electron/acp-engine-utils', () => ({
  loadEngine: (...args: unknown[]) => loadEngine(...args),
}))
vi.mock('../../../../apps/desktop/electron/model-access', async (importOriginal) => ({
  ModelAccessHttpError: (await importOriginal<Record<string, unknown>>()).ModelAccessHttpError,
  modelAccessFailureReason: (await importOriginal<Record<string, unknown>>()).modelAccessFailureReason,
  checkpointPlatformModelAccess: async () => undefined,
  issuePlatformModelAccess: async () => { throw new Error('not expected in this test') },
  resolveAgentModelLaunch: (...args: unknown[]) => resolveAgentModelLaunch(...args),
  revokePlatformModelAccess: (...args: unknown[]) => revokePlatformModelAccess(...args),
  renewPlatformModelAccess: async () => ({ expiresAt: new Date(Date.now() + 60_000).toISOString() }),
  markPlatformAccessDetached: async () => undefined,
  settleAdoptedPlatformAccessAtExit: async () => undefined,
}))
vi.mock('../../../../apps/desktop/electron/session/main/core/sessions/getSessions', () => ({
  getSessions: async () => [],
}))
vi.mock('../../../../apps/desktop/electron/sessionpage/emdash-agent-provisioning', () => ({
  SESSION_CACHE_KEY: 'emdash_session_id',
  awaitSessionpageCloudIdentity: async () => undefined,
  provisionSessionpageAgentForSession: async () => null,
}))
vi.mock('../../../../apps/desktop/electron/capability-report-store', () => ({
  noteHostInjectedModel: async () => undefined,
}))

const {
  platformModelForSession,
  releasePlatformModelForSession,
  resetPlatformRelayPersistenceForTest,
  withPlatformDeclaration,
} = await import('../../../../apps/desktop/electron/sessionpage/sessionpage-platform-model')
const { createSessionpagePlatformHooks } = await import('../../../../apps/desktop/electron/sessionpage/sessionpage-platform-hooks')
const { acpPlatformInjectionSchema } = await import('../../../../packages/session-core/src/acp/api/runtime-contract')
const { provider: codex } = await import('../../../../packages/session-plugins/src/agents/impl/codex/index')
const {
  CODEX_GUGU_CAPABILITY_PACKAGE,
  materializeCodexSessionBundle,
} = await import('../../../../packages/session-plugins/src/agents/impl/codex/session-bundle')

const SESSION = 'conv-6921'
const ACTOR_HEADER = 'x-openai-actor-authorization'
const GRANTED = {
  '/v1/responses': ['gpt-6-astra'],
  '/v1/images/generations': ['gpt-image-2'],
}
const authProvider = {
  getAuth: async () => ({ accessToken: 't', refreshToken: null, userId: 'owner-1' }),
} as never

function launch(callableRoutes: Record<string, string[]> | undefined, relayUrl = 'https://relay.example') {
  listAgents.mockResolvedValue([{ gugu_user_id: 'agent-1', cache: { emdash_session_id: SESSION } }])
  loadEngine.mockResolvedValue({ id: 'codex', modelConfigInjection: 'codex-config-flags' })
  resolveAgentModelLaunch.mockResolvedValue({
    selection: { source: 'platform', modelId: 'gpt-6-astra', protocol: 'openai-responses' },
    model: 'gpt-6-astra',
    env: { OPENAI_BASE_URL: `${relayUrl}/v1`, OPENAI_API_KEY: 'sk-session' },
    access: {
      accessSessionId: 'sess-6921',
      relayUrl,
      token: 'sk-session',
      model: 'gpt-6-astra',
      modelId: 'gpt-6-astra',
      protocol: 'openai-responses',
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      contextWindow: null,
      reasoningEfforts: null,
      switchableModels: [], membershipLocked: [],
      // 与 model-access 的解析同形:老服务端 ⇒ 空表。
      callableRoutes: callableRoutes ?? {},
    },
  })
}

/** argv 里 `-c <value>` 这一对里,值带着开关头。 */
function carriesActorHeader(args: readonly string[]): boolean {
  return args.some((arg, index) => args[index - 1] === '-c' && arg.startsWith('model_providers.gugu_platform.http_headers=')
    && arg.includes(ACTOR_HEADER))
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.stubEnv('GUGU_HOME', mkdtempSync(join(tmpdir(), 'gugu-6921-')))
})
afterEach(async () => {
  await releasePlatformModelForSession(SESSION).catch(() => undefined)
  vi.unstubAllEnvs()
})
// 凭据代理是模块级的本机端点:收掉它,别把监听句柄留给同一 worker 里的下一份测试文件。
afterAll(() => resetPlatformRelayPersistenceForTest())

describe('#6921 ACP 腿:签发响应 → 注入信封 → codex 的 argv', () => {
  async function acpSpawnArgs(): Promise<{ args: string[]; callableRoutes: unknown }> {
    const hooks = createSessionpagePlatformHooks({
      authProvider: () => authProvider,
      provisionDeps: {} as never,
      env: process.env,
    })
    const injection = await hooks.acpInjector({
      sessionId: SESSION,
      projectId: 'project-1',
      providerId: 'codex',
      cwd: '/work',
      platformModel: { modelId: 'gpt-6-astra' },
    })
    if (injection?.kind !== 'adapter-spawn') throw new Error(`expected adapter-spawn, got ${injection?.kind}`)
    // 宿主 → worker 那一跳按这份 schema 解析;没声明的键在这里被静默丢掉。
    const platform = acpPlatformInjectionSchema.parse(injection.platform)
    const { args } = codex.behavior.acp!.buildSpawn({
      cwd: '/work',
      env: { GUGU_CODEX_BIN: '/x/codex' },
      cli: 'codex',
      adapterEntry: '/x/gugu-codex-app-server-acp.mjs',
      platform,
    })
    return { args, callableRoutes: platform.callableRoutes }
  }

  it('令牌能调 gpt-image-2 ⇒ 信封带着路由表,桥的 argv 带开关头', async () => {
    launch(GRANTED)
    const { args, callableRoutes } = await acpSpawnArgs()
    expect(callableRoutes).toEqual(GRANTED)
    expect(carriesActorHeader(args)).toBe(true)
  })

  it('服务端没给 callable_routes ⇒ 信封里没有这一项,argv 不带头', async () => {
    launch(undefined)
    const { args, callableRoutes } = await acpSpawnArgs()
    expect(callableRoutes).toBeUndefined()
    expect(args.join('\n')).not.toContain(ACTOR_HEADER)
  })
})

describe('#6921 app-server 腿:签发响应 → 模型声明 → 物化器 argv', () => {
  async function appServerArgs(): Promise<readonly string[]> {
    const platform = await platformModelForSession({
      surface: 'tui', sessionId: SESSION, providerId: 'codex', authProvider,
      platformModel: { modelId: 'gpt-6-astra' },
    })
    // main.ts 的 codex PTY divert:把整份平台声明嫁接到会话包的模型上,再交给物化器。
    const model = withPlatformDeclaration({ dialect: 'codex-config-flags' as const, model: 'gpt-6-astra' }, platform)
    return materializeCodexSessionBundle(
      { surface: 'app-server', lifecycle: 'fresh', cwd: '/work' },
      {
        mcpServers: [],
        env: { GUGU_HOME: '/gugu' },
        model,
        autonomy: null,
        promptBlocks: {},
        packages: [CODEX_GUGU_CAPABILITY_PACKAGE],
      },
    ).argsAppend
  }

  it('令牌能调 gpt-image-2 ⇒ app-server argv 带开关头', async () => {
    launch(GRANTED)
    expect(carriesActorHeader(await appServerArgs())).toBe(true)
  })

  it.each([
    ['字段缺失', undefined],
    ['出图路由上没有 codex 的模型', { '/v1/images/generations': ['dall-e-3'] }],
  ])('%s ⇒ app-server argv 不带头', async (_case, routes) => {
    launch(routes)
    expect((await appServerArgs()).join('\n')).not.toContain(ACTOR_HEADER)
  })
})

describe('#6921 可见客户端拿到的是同一份声明', () => {
  // remote TUI 建 thread / resume 时把它**自己**的 web_search 当线程配置送给 app-server
  // (codex-rs tui/src/app_server_session.rs:1856),盖过 app-server 的进程级 -c;没有 divert 的宿主
  // (applyPlatformToPtyLaunch / main.ts 的 plain case)更是让可见 codex 自己推理 —— 必须同一句话。
  it.each([
    ['令牌能调 gpt-image-2', GRANTED, true, true],
    ['字段缺失', undefined, false, false],
    ['起步模型在搜索路由上', { ...GRANTED, '/v1/alpha/search': ['gpt-6-astra'] }, true, false],
    ['搜索路由上只有别的模型', { ...GRANTED, '/v1/alpha/search': ['gpt-5.6-sol'] }, true, true],
  ])('%s ⇒ clientArgs 的开关头、搜索开关', async (_case, routes, header, searchOffExpected) => {
    launch(routes)
    const platform = await platformModelForSession({
      surface: 'tui', sessionId: SESSION, providerId: 'codex', authProvider,
      platformModel: { modelId: 'gpt-6-astra' },
    })
    expect(platform.clientArgs).toContain('model_provider=gugu_platform')
    expect(carriesActorHeader(platform.clientArgs)).toBe(header)
    const searchOff = (args: readonly string[]) => args.some((arg, index) => arg === 'web_search="disabled"' && args[index - 1] === '-c')
    expect(searchOff(platform.clientArgs)).toBe(searchOffExpected)
  })
})

describe('#6921 开关头只在本机:咕咕的凭据代理不把它转给网关', () => {
  it('转发时去掉 x-openai-actor-authorization,其它请求头照转', async () => {
    let received: IncomingHttpHeaders | undefined
    const upstream = createServer((request, response) => {
      received = request.headers
      request.resume()
      request.on('end', () => {
        response.writeHead(200, { 'content-type': 'application/json' })
        response.end('{"ok":true}')
      })
    })
    await new Promise<void>((resolve, reject) => {
      upstream.once('error', reject)
      upstream.listen(0, '127.0.0.1', () => resolve())
    })
    const address = upstream.address()
    if (!address || typeof address === 'string') throw new Error('expected TCP upstream')
    try {
      launch(GRANTED, `http://127.0.0.1:${address.port}`)
      const platform = await platformModelForSession({
        surface: 'tui', sessionId: SESSION, providerId: 'codex', authProvider,
        platformModel: { modelId: 'gpt-6-astra' },
      })
      if (!platform.platformProvider) throw new Error('expected proxied platform provider')
      const response = await fetch(`${platform.platformProvider.baseUrl}/images/generations`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${platform.platformProvider.apiKey}`,
          'content-type': 'application/json',
          [ACTOR_HEADER]: 'gugu-image-generation-switch',
          // 阳控:codex 出图请求自带的另一个自定义头,必须照转 —— 证明不是「所有 x- 头都丢」。
          'x-codex-image-turn-id': 'turn-1',
        },
        body: '{"model":"gpt-image-2","prompt":"probe"}',
      })
      expect(response.status).toBe(200)
      expect(received?.['x-codex-image-turn-id']).toBe('turn-1')
      expect(received?.authorization).toBe('Bearer sk-session')
      expect(received).not.toHaveProperty(ACTOR_HEADER)
    } finally {
      await new Promise<void>((resolve) => upstream.close(() => resolve()))
    }
  })
})
