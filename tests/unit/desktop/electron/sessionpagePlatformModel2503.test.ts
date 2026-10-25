import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { execFile } from 'node:child_process'
import { createServer, ServerResponse } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createLogger } from '../../../../apps/desktop/electron/lib/logger'
import { deferred } from '../../../support/testHarness'
const listAgents = vi.fn<(...args: unknown[]) => Promise<unknown>>()
const loadEngine = vi.fn<(...args: unknown[]) => Promise<unknown>>()
const resolveAgentModelLaunch = vi.fn<(...args: unknown[]) => Promise<unknown>>()
const checkpointPlatformModelAccess = vi.fn<(...args: unknown[]) => Promise<void>>()
const issuePlatformModelAccess = vi.fn<(...args: unknown[]) => Promise<unknown>>()
const revokePlatformModelAccess = vi.fn<(...args: unknown[]) => Promise<void>>()
const markPlatformAccessDetached = vi.fn<(...args: unknown[]) => Promise<void>>(async () => undefined)
const renewPlatformModelAccess = vi.fn<(...args: unknown[]) => Promise<{ expiresAt: string; membershipLocked: readonly string[] }>>()
const getHarnessModelCatalog = vi.fn<(...args: unknown[]) => Promise<unknown>>()
const lookupHarnessModelCatalog = vi.fn<(...args: unknown[]) => Promise<unknown>>()
const getSessions = vi.fn<(...args: unknown[]) => Promise<unknown[]>>()
const execFileAsync = promisify(execFile)
// claude 用 shell 跑 `apiKeyHelper`(它是一行命令,不是一个可执行文件路径)——测试照同一方式跑。
const runApiKeyHelper = (command: string, options?: { env?: NodeJS.ProcessEnv }) =>
  execFileAsync('/bin/sh', ['-c', command], options)
// POSIX 的 helper 命令形如 `/bin/sh '<path>'`;取出那份数据文件的路径。
const helperPathOf = (command: string): string => {
  const match = /^\/bin\/sh '([^']+)'$/.exec(command)
  if (!match) throw new Error(`unexpected apiKeyHelper command: ${command}`)
  return match[1]
}
// helper 里 `--config '<path>'` 指向的那份 0600 curl 配置(装着端点 secret)。
const configPathOf = (helper: string): string => {
  const match = /--config '([^']+)'/.exec(helper)
  if (!match) throw new Error(`helper has no --config: ${helper}`)
  return match[1]
}
const legacyHelper = vi.hoisted(() => ({ enabled: false }))
vi.mock('@gugu/session-plugins/agents', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@gugu/session-plugins/agents')>()
  return { ...actual, resolveSessionpageCredentialLifecycle: (...args: Parameters<typeof actual.resolveSessionpageCredentialLifecycle>) => {
    const lifecycle = actual.resolveSessionpageCredentialLifecycle(...args)
    // Persisted pre-proxy helper sessions still need their original recovery path.
    return legacyHelper.enabled && args[0] === 'claude' && lifecycle
      ? { ...lifecycle, delivery: 'credential-helper' as const } : lifecycle
  } }
})
vi.mock('@gugu/core', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  listAgents: (...args: unknown[]) => listAgents(...args),
}))
vi.mock('../../../../apps/desktop/electron/acp-engine-utils', () => ({
  loadEngine: (...args: unknown[]) => loadEngine(...args),
}))
vi.mock('../../../../apps/desktop/electron/model-access', async (importOriginal) => ({
  // 失败分类用真的(签发失败 → 给 agent 看的哪一句,判据就在这两个里)。
  ModelAccessHttpError: (await importOriginal<Record<string, unknown>>()).ModelAccessHttpError,
  modelAccessFailureReason: (await importOriginal<Record<string, unknown>>()).modelAccessFailureReason,
  checkpointPlatformModelAccess: (...args: unknown[]) => checkpointPlatformModelAccess(...args),
  issuePlatformModelAccess: (...args: unknown[]) => issuePlatformModelAccess(...args),
  resolveAgentModelLaunch: (...args: unknown[]) => resolveAgentModelLaunch(...args),
  revokePlatformModelAccess: (...args: unknown[]) => revokePlatformModelAccess(...args),
  renewPlatformModelAccess: (...args: unknown[]) => renewPlatformModelAccess(...args),
  markPlatformAccessDetached: (...args: unknown[]) => markPlatformAccessDetached(...args),
  settleAdoptedPlatformAccessAtExit: async () => undefined,
}))
vi.mock('../../../../apps/desktop/electron/session/main/core/sessions/getSessions', () => ({
  getSessions: (...args: unknown[]) => getSessions(...args),
}))
vi.mock('../../../../apps/desktop/electron/sessionpage/emdash-agent-provisioning', () => ({
  SESSION_CACHE_KEY: 'emdash_session_id',
}))
vi.mock('../../../../apps/desktop/electron/session/main/core/agents/harness-model-catalog', () => ({
  getHarnessModelCatalog: (...args: unknown[]) => getHarnessModelCatalog(...args),
  lookupHarnessModelCatalog: (...args: unknown[]) => lookupHarnessModelCatalog(...args),
}))
const {
  checkpointPlatformModelForSession,
  claudeCredentialHelperFile,
  dynamicClaudeSettings,
  heldPlatformModelForSession,
  assertUserModelAllowed,
  codexPlatformInjection,
  platformModelForSession,
  withPlatformDeclaration,
  reissueExpiredPlatformModelForSession,
  releasePlatformModelForSession,
  releasePlatformModelsAtExit,
  classifyCredentialIssueFailure,
  configurePlatformMembershipListener,
  configurePlatformCredentialRefusalSink,
  credentialIssueBackoffMs,
  renewedLifetimeMs,
  resetPlatformIssueBackoffsForTest,
  clearPlatformIssueBackoff,
} = await import('../../../../apps/desktop/electron/sessionpage/sessionpage-platform-model')
const { ModelAccessHttpError } = await import('../../../../apps/desktop/electron/model-access')
const { RuntimeAuthError } = await import('@gugu/core')
const { acpPlatformInjectionSchema } = await import('../../../../packages/session-core/src/acp/api/runtime-contract')
const { codexPlatformModelFacts } = await import('../../../../packages/session-plugins/src/agents/impl/codex/platform-models')
const SESSION = 'conv-2503'
const CLAUDE_TEST_ENV = { ...process.env, GUGU_HOME: join(tmpdir(), `gugu-platform-model-${process.pid}`) }
const authProvider = {
  getAuth: async () => ({ accessToken: 't', refreshToken: null, userId: 'owner-1' }),
} as never
function agentOnThisSession() {
  listAgents.mockResolvedValue([
    { gugu_user_id: 'agent-1', cache: { emdash_session_id: SESSION } },
  ])
}
/** `expiresInMs` 默认 60s;续期用例传生产量级的 TTL(MODEL_SESSION_TTL_SECONDS 默认 900s)。 */
function platformLaunch(
  model: string,
  expiresInMs = 60_000,
  contextWindow?: number,
  switchableModels: readonly { alias: string; displayName: string; contextWindow: number | null }[] = [],
  accessSessionId = 'sess-1',
  relayUrl = 'https://relay.example',
  token = 'sk-session',
  /** 目录里这个模型认的推理档(#6447);缺省给一组中性的,不影响与推理档无关的用例。 */
  reasoningEfforts: readonly string[] | null = ['low', 'medium', 'high'],
) {
  resolveAgentModelLaunch.mockResolvedValue({
    selection: { source: 'platform', modelId: 'glm-5.2', protocol: 'openai-responses' },
    model,
    env: { OPENAI_BASE_URL: `${relayUrl}/v1`, OPENAI_API_KEY: token },
    access: {
      accessSessionId: accessSessionId,
      relayUrl,
      token,
      model,
      modelId: 'glm-5.2',
      protocol: 'openai-responses',
      expiresAt: new Date(Date.now() + expiresInMs).toISOString(),
      contextWindow: contextWindow ?? null,
      reasoningEfforts,
      switchableModels,
      membershipLocked: [],
    },
  })
}
// 签发退避按会话 id 记、跨过结清(会话重建)活着;用例共用同一个会话 id,别把上一条的窗口带过去。
beforeEach(() => { resetPlatformIssueBackoffsForTest(); legacyHelper.enabled = false })

describe('#2503 session-page sessions carry the designated model', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    lookupHarnessModelCatalog.mockResolvedValue({
      state: {
        kind: 'ready',
        models: [{ id: 'native-haiku-current', name: 'Haiku' }],
        selected: 'native-haiku-current',
        efforts: [],
        selectedEffort: null,
      },
      refreshing: false,
    })
    getHarnessModelCatalog.mockResolvedValue({
      kind: 'ready',
      models: [{ id: 'native-haiku-current', name: 'Haiku' }],
      selected: 'native-haiku-current',
      efforts: [],
      selectedEffort: null,
    })
    getSessions.mockResolvedValue([])
    revokePlatformModelAccess.mockResolvedValue(undefined)
    checkpointPlatformModelAccess.mockResolvedValue(undefined)
  })
  it.each([['tui', 'expired'], ['cui', 'expired'], ['tui', 'rejected'], ['cui', 'rejected']] as const)('keeps %s Claude on loopback for a %s credential', async (surface, recovery) => {
    const forwarded: Array<{ authorization: unknown; apiKey: unknown; body: string }> = []
    const upstream = createServer((request, response) => {
      let body = ''
      request.setEncoding('utf8')
      request.on('data', chunk => { body += chunk })
      request.on('end', () => {
        forwarded.push({ authorization: request.headers.authorization, apiKey: request.headers['x-api-key'], body })
        response.writeHead(recovery === 'rejected' && forwarded.length === 1 ? 401 : 200)
        response.end('accepted')
      })
    })
    await new Promise<void>(resolve => upstream.listen(0, '127.0.0.1', resolve))
    const relayUrl = `http://127.0.0.1:${(upstream.address() as { port: number }).port}`
    try {
      agentOnThisSession()
      loadEngine.mockResolvedValue({ id: 'claude', modelConfigInjection: 'provider-env' })
      platformLaunch('glm-5.2-claude', 60_000, undefined, [], 'old-session', relayUrl, 'raw-old-platform-token')
      const platform = await platformModelForSession({ surface, sessionId: SESSION, providerId: 'claude', authProvider, env: CLAUDE_TEST_ENV })
      const local = platform.platformProvider!
      expect(local.baseUrl).toMatch(/^http:\/\/127\.0\.0\.1:\d+\//)
      expect(local.apiKey).not.toBe('raw-old-platform-token')
      expect(JSON.stringify(platform)).not.toContain('raw-old-platform-token')
      const refused = await fetch(`${local.baseUrl}/messages`, { method: 'POST', headers: { authorization: 'Bearer raw-old-platform-token' }, body: '{}' })
      expect(refused.status).toBe(401)
      expect(forwarded).toHaveLength(0)

      if (recovery === 'expired') {
        vi.useFakeTimers({ toFake: ['Date'] })
        vi.setSystemTime(Date.now() + 65_000)
      }
      const replacement = deferred<unknown>()
      const issuing = deferred<void>()
      issuePlatformModelAccess.mockImplementationOnce(() => { issuing.resolve(); return replacement.promise })
      const resumed = recovery === 'expired' ? reissueExpiredPlatformModelForSession(SESSION) : Promise.resolve(true)
      const result = fetch(`${local.baseUrl}/messages`, { method: 'POST', headers: { authorization: `Bearer ${local.apiKey}`, 'x-api-key': local.apiKey }, body: '{"stream":true} \n' })
      await issuing.promise
      expect(forwarded).toHaveLength(recovery === 'expired' ? 0 : 1)
      replacement.resolve({ accessSessionId: 'fresh-session', relayUrl, token: 'raw-fresh-platform-token', model: 'glm-5.2-claude', modelId: 'glm-5.2', protocol: 'anthropic-messages', expiresAt: new Date(Date.now() + 60_000).toISOString(), contextWindow: null, switchableModels: [], membershipLocked: [] })
      await expect(resumed).resolves.toBe(true)
      expect(await (await result).text()).toBe('accepted')
      const accepted = { authorization: 'Bearer raw-fresh-platform-token', apiKey: 'raw-fresh-platform-token', body: '{"stream":true} \n' }
      expect(forwarded).toEqual(recovery === 'expired' ? [accepted] : [
        { authorization: 'Bearer raw-old-platform-token', apiKey: 'raw-old-platform-token', body: accepted.body }, accepted,
      ])
      expect(issuePlatformModelAccess).toHaveBeenCalledTimes(1)
      expect(heldPlatformModelForSession(SESSION)?.platformProvider).toEqual(local)
    } finally {
      vi.useRealTimers()
      await releasePlatformModelForSession(SESSION)
      upstream.closeAllConnections()
      await new Promise<void>(resolve => upstream.close(() => resolve()))
    }
  })
  it('fails before quota mint when user availableModels excludes the Claude platform alias', async () => {
    const home = await mkdtemp(join(tmpdir(), 'gugu-claude-arm-c-'))
    try {
      const configDir = join(home, '.claude')
      await mkdir(configDir, { recursive: true })
      await writeFile(join(configDir, 'settings.json'), JSON.stringify({
        availableModels: ['claude-sonnet-4-6'],
      }))
      await expect(assertUserModelAllowed({ HOME: home }, 'claude', 'gpt-5.6-sol')).rejects.toThrow(
        "你的 ~/.claude/settings.json availableModels 排除了该模型 'gpt-5.6-sol'。",
      )
      await writeFile(join(configDir, 'settings.json'), JSON.stringify({
        availableModels: ['gpt-5.6-sol'],
      }))
      await expect(assertUserModelAllowed({ HOME: home }, 'claude', 'gpt-5.6-sol')).resolves.toBeUndefined()
    } finally {
      await rm(home, { recursive: true, force: true })
    }
  })
  it('reports the model the quota designated, not the one the composer picked', async () => {
    agentOnThisSession()
    platformLaunch('glm-5.2-codex', 60_000, 1_000_000)
    loadEngine.mockResolvedValue({ id: 'codex', modelConfigInjection: 'codex-config-flags' })
    const platform = await platformModelForSession({ surface: 'tui',
      sessionId: SESSION, providerId: 'codex', authProvider,
    })
    expect(platform.model).toBe('glm-5.2-codex')
    expect(platform.env.OPENAI_API_KEY).toBe(platform.platformProvider?.apiKey)
    expect(platform.env.OPENAI_API_KEY).not.toBe('sk-session')
    expect(platform.spawnEnv).toEqual({})
    expect(platform.platformProvider?.baseUrl).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/gugu-platform-relay\/[a-f0-9-]+\/v1$/)
  })
  it('rotates an expired config-backed credential before proxying the real request', async () => {
    let authorization: string | undefined
    let requestBody = ''
    const upstream = createServer((request, response) => {
      authorization = request.headers.authorization
      request.setEncoding('utf8')
      request.on('data', (chunk: string) => { requestBody += chunk })
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
    const relayUrl = `http://127.0.0.1:${address.port}`
    agentOnThisSession()
    loadEngine.mockResolvedValue({ id: 'codex', modelConfigInjection: 'codex-config-flags' })
    platformLaunch('glm-5.2-codex', -1, 1_000_000, [], 'sess-1', relayUrl, 'sk-expired')
    issuePlatformModelAccess.mockResolvedValue({
      accessSessionId: 'sess-2', relayUrl, token: 'sk-replacement',
      model: 'glm-5.2-codex', modelId: 'glm-5.2', protocol: 'openai-responses',
      expiresAt: new Date(Date.now() + 60_000).toISOString(), contextWindow: 1_000_000, switchableModels: [], membershipLocked: [],
    })
    try {
      const platform = await platformModelForSession({
        surface: 'tui', sessionId: SESSION, providerId: 'codex', authProvider,
      })
      if (!platform.platformProvider) throw new Error('expected proxied platform provider')
      const response = await fetch(`${platform.platformProvider.baseUrl}/responses?probe=1`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${platform.platformProvider.apiKey}`,
          'content-type': 'application/json',
        },
        body: '{"input":"probe"}',
      })
      expect(response.status).toBe(200)
      await expect(response.json()).resolves.toEqual({ ok: true })
      expect(authorization).toBe('Bearer sk-replacement')
      expect(requestBody).toBe('{"input":"probe"}')
      expect(issuePlatformModelAccess).toHaveBeenCalledTimes(1)
      expect(revokePlatformModelAccess).toHaveBeenCalledWith(authProvider, 'sess-1')
    } finally {
      await releasePlatformModelForSession(SESSION).catch(() => undefined)
      await new Promise<void>((resolve) => upstream.close(() => resolve()))
    }
  })
  // #7092 免费档指定了会员模型:签发照常给票、把它锁在票外(`membership_locked`),会话照常起。
  // 调它那一轮网关回 403,中转原样转回 —— 要说清的话由网关自己说,❌ 在本机中转里认出它的报错再改写(owner 2026-10-10)。
  it('#7092 starts a session on a membership-locked model, tells the host, and passes the gateway refusal through untouched', async () => {
    const REFUSAL = '{"error":{"code":"","message":"This token has no access to model glm-5.3 (request id: x)","type":"new_api_error"}}'
    const bodies: string[] = []
    const upstream = createServer((request, response) => {
      let body = ''
      request.setEncoding('utf8')
      request.on('data', (chunk: string) => { body += chunk })
      request.on('end', () => {
        bodies.push(body)
        response.writeHead(403, { 'content-type': 'application/json' })
        response.end(REFUSAL)
      })
    })
    await new Promise<void>((resolve, reject) => {
      upstream.once('error', reject)
      upstream.listen(0, '127.0.0.1', () => resolve())
    })
    const address = upstream.address()
    if (!address || typeof address === 'string') throw new Error('expected TCP upstream')
    const relayUrl = `http://127.0.0.1:${address.port}`
    agentOnThisSession()
    loadEngine.mockResolvedValue({ id: 'codex', modelConfigInjection: 'codex-config-flags' })
    resolveAgentModelLaunch.mockResolvedValue({
      selection: { source: 'platform', modelId: 'glm-5.3', protocol: 'openai-responses' },
      model: 'glm-5.3',
      env: { OPENAI_BASE_URL: `${relayUrl}/v1`, OPENAI_API_KEY: 'sk-free' },
      access: {
        accessSessionId: 'sess-locked', relayUrl, token: 'sk-free', model: 'glm-5.3', modelId: 'glm-5.3',
        protocol: 'openai-responses', expiresAt: new Date(Date.now() + 60_000).toISOString(),
        contextWindow: 1_000_000, reasoningEfforts: null, membershipLocked: ['glm-5.3'],
        switchableModels: [
          { id: 'glm-5.3', alias: 'glm-5.3', displayName: 'GLM-5.3', contextWindow: 1_000_000, reasoningEfforts: null },
          { id: 'glm-5.3-flash', alias: 'glm-5.3-flash', displayName: 'GLM 5.3 Flash', contextWindow: 200_000, reasoningEfforts: null },
        ],
      },
    })
    const changes = vi.fn()
    configurePlatformMembershipListener(changes)
    try {
      const platform = await platformModelForSession({ surface: 'tui', sessionId: SESSION, providerId: 'codex', authProvider })
      // 界面据此刷新目录(通用模式那一行说清、给去路)。
      expect(changes).toHaveBeenCalledWith({ sessionId: SESSION, locked: ['glm-5.3'] })
      if (!platform.platformProvider) throw new Error('expected proxied platform provider')
      const response = await fetch(`${platform.platformProvider.baseUrl}/responses`, {
        method: 'POST',
        headers: { authorization: `Bearer ${platform.platformProvider.apiKey}`, 'content-type': 'application/json' },
        body: '{"model":"glm-5.3","input":"hi"}',
      })
      expect(response.status).toBe(403)
      await expect(response.text()).resolves.toBe(REFUSAL)
      expect(bodies).toEqual(['{"model":"glm-5.3","input":"hi"}'])
      expect(renewPlatformModelAccess).not.toHaveBeenCalled()
    } finally {
      configurePlatformMembershipListener(null)
      await releasePlatformModelForSession(SESSION).catch(() => undefined)
      await new Promise<void>((resolve) => upstream.close(() => resolve()))
    }
  })
  it('answers a relay request it cannot get a ticket for with a 4xx reason, not a retryable 5xx (codex / opencode)', async () => {
    agentOnThisSession()
    loadEngine.mockResolvedValue({ id: 'codex', modelConfigInjection: 'codex-config-flags' })
    platformLaunch('glm-5.2-codex', -1, 1_000_000, [], 'sess-1', 'http://127.0.0.1:1', 'sk-expired')
    issuePlatformModelAccess.mockRejectedValue(new ModelAccessHttpError('model glm-5.3 requires a membership', 403, 'membership_required'))
    const logged = vi.spyOn(createLogger('sessionpage/platform-model'), 'error').mockImplementation(() => undefined)
    try {
      const platform = await platformModelForSession({
        surface: 'tui', sessionId: SESSION, providerId: 'codex', authProvider,
      })
      if (!platform.platformProvider) throw new Error('expected proxied platform provider')
      const send = () => fetch(`${platform.platformProvider!.baseUrl}/responses`, {
        method: 'POST',
        headers: { authorization: `Bearer ${platform.platformProvider!.apiKey}`, 'content-type': 'application/json' },
        body: '{}',
      })
      const response = await send()
      expect(response.status).toBe(403)
      const body = await response.json() as { type: string; error: { type: string; code: string; message: string } }
      expect(body).toMatchObject({ type: 'error', error: { type: 'permission_error', code: 'gugu_credential_unavailable' } })
      expect(body.error.message).toMatch(/^咕咕:你用的咕咕模型要开会员才能用/)
      // 退避窗口内的第二个请求不再打控制面。
      expect((await send()).status).toBe(403)
      expect(issuePlatformModelAccess).toHaveBeenCalledTimes(1)
    } finally {
      logged.mockRestore()
      await releasePlatformModelForSession(SESSION).catch(() => undefined)
    }
  })
  // 开机认回之后、登录之前来要票是常态(#7031):本机没登录(请求发不出去)不记退避,登录后第一次要票立刻就签。
  // 上一条(要会员)与下面 it.each 里的 401(控制面回的登录失效)是阳控:打到了控制面的照旧退避。
  it('本机没登录签不出票:照样当场失败、给出原因,但不记退避 —— 下一次要票照常去签', async () => {
    agentOnThisSession()
    loadEngine.mockResolvedValue({ id: 'codex', modelConfigInjection: 'codex-config-flags' })
    platformLaunch('glm-5.2-codex', -1, 1_000_000, [], 'sess-1', 'http://127.0.0.1:1', 'sk-expired')
    issuePlatformModelAccess.mockRejectedValue(new RuntimeAuthError('platform model token requires authenticated Supabase runtime auth'))
    const logged = vi.spyOn(createLogger('sessionpage/platform-model'), 'error').mockImplementation(() => undefined)
    try {
      const platform = await platformModelForSession({
        surface: 'tui', sessionId: SESSION, providerId: 'codex', authProvider,
      })
      if (!platform.platformProvider) throw new Error('expected proxied platform provider')
      const send = () => fetch(`${platform.platformProvider!.baseUrl}/responses`, {
        method: 'POST',
        headers: { authorization: `Bearer ${platform.platformProvider!.apiKey}`, 'content-type': 'application/json' },
        body: '{}',
      })
      const response = await send()
      expect(response.status).toBe(403)
      const body = await response.json() as { error: { code: string } }
      expect(body.error.code).toBe('gugu_credential_unavailable')
      expect(issuePlatformModelAccess).toHaveBeenCalledTimes(1)
      expect((await send()).status).toBe(403)
      expect(issuePlatformModelAccess).toHaveBeenCalledTimes(2)
    } finally {
      logged.mockRestore()
      await releasePlatformModelForSession(SESSION).catch(() => undefined)
    }
  })
  // 自动唤醒(收件、ACP 重连)不清退避,窗口内照旧不打控制面;人点的出口(重试、恢复重试、我开好了)先清掉
  // 这条会话的退避(#7103),当场真去问一次 ——「开好会员再点一次」❌ 在窗口里拿回旧原因。
  it('重建会话与取票共用同一个退避:窗口内自动重建不打控制面,人点重试清掉退避当场再签', async () => {
    agentOnThisSession()
    loadEngine.mockResolvedValue({ id: 'codex', modelConfigInjection: 'codex-config-flags' })
    platformLaunch('glm-5.2-codex', -1, 1_000_000, [], 'sess-1', 'http://127.0.0.1:1', 'sk-expired')
    issuePlatformModelAccess.mockRejectedValue(new ModelAccessHttpError('model glm-5.2 requires a membership', 403, 'membership_required'))
    const logged = vi.spyOn(createLogger('sessionpage/platform-model'), 'error').mockImplementation(() => undefined)
    const start = () => platformModelForSession({ surface: 'cui', sessionId: SESSION, providerId: 'codex', authProvider })
    try {
      const platform = await start()
      const response = await fetch(`${platform.platformProvider!.baseUrl}/responses`, {
        method: 'POST',
        headers: { authorization: `Bearer ${platform.platformProvider!.apiKey}`, 'content-type': 'application/json' },
        body: '{}',
      })
      expect(response.status).toBe(403)
      expect(issuePlatformModelAccess).toHaveBeenCalledTimes(1)
      expect(resolveAgentModelLaunch).toHaveBeenCalledTimes(1)
      // 运行时死了、宿主自己重建这条会话:结清旧票再签 —— 还在窗口里,当场失败,❌ 打控制面(阴控)。
      await releasePlatformModelForSession(SESSION)
      await expect(start()).rejects.toThrow('gugu-models:membership-required')
      expect(resolveAgentModelLaunch).toHaveBeenCalledTimes(1)
      expect(issuePlatformModelAccess).toHaveBeenCalledTimes(1)
      // 开好了会员,人点恢复重试:先清退避,还在窗口里也照样真去问。
      clearPlatformIssueBackoff(SESSION)
      platformLaunch('glm-5.2-codex', 60_000, 1_000_000, [], 'sess-2')
      await expect(start()).resolves.toMatchObject({ model: 'glm-5.2-codex' })
      expect(resolveAgentModelLaunch).toHaveBeenCalledTimes(2)
    } finally {
      logged.mockRestore()
      await releasePlatformModelForSession(SESSION).catch(() => undefined)
    }
  })
  it('会话起不来(签发失败)之后,窗口内自动再起给同一个原因不打控制面;人点重试真去问一次,拿到新结果', async () => {
    agentOnThisSession()
    loadEngine.mockResolvedValue({ id: 'codex', modelConfigInjection: 'codex-config-flags' })
    resolveAgentModelLaunch.mockRejectedValueOnce(new ModelAccessHttpError('model glm-5.2 requires a membership', 403, 'membership_required'))
    const start = () => platformModelForSession({ surface: 'cui', sessionId: SESSION, providerId: 'codex', authProvider })
    await expect(start()).rejects.toThrow('gugu-models:membership-required')
    platformLaunch('glm-5.2-codex', 60_000, 1_000_000)
    // 没人点:窗口里照旧回同一个原因(阴控 —— 下面那次签成了,只能是清退避的功劳)。
    await expect(start()).rejects.toThrow('gugu-models:membership-required')
    expect(resolveAgentModelLaunch).toHaveBeenCalledTimes(1)
    // 服务端那边原因改了(开好了会员),人点重试:拿到的是这一次的结果,❌ 窗口里的旧原因。
    clearPlatformIssueBackoff(SESSION)
    try {
      await expect(start()).resolves.toMatchObject({ model: 'glm-5.2-codex' })
      expect(resolveAgentModelLaunch).toHaveBeenCalledTimes(2)
    } finally {
      await releasePlatformModelForSession(SESSION).catch(() => undefined)
    }
  })
  // #6938 签发失败说的是那个身份。会话换了身份(云端删了旧的、名册给同一条会话铸了新的):旧身份的拒签 ❌ 替新身份作答。
  it('换了身份的会话不吃旧身份的退避:同一个身份照旧重放,新身份照常去签', async () => {
    listAgents.mockResolvedValue([{ gugu_user_id: 'agent-x', cache: { emdash_session_id: SESSION } }])
    loadEngine.mockResolvedValue({ id: 'codex', modelConfigInjection: 'codex-config-flags' })
    resolveAgentModelLaunch.mockRejectedValueOnce(new ModelAccessHttpError('agent is not owned by caller', 403, 'agent_not_owned'))
    const start = () => platformModelForSession({ surface: 'cui', sessionId: SESSION, providerId: 'codex', authProvider })
    // 表上 agent_not_owned 不出话;真落到界面就是「咕咕这边出错了」,原文 ❌ 上屏。
    await expect(start()).rejects.toThrow('gugu-models:service-unavailable')
    await expect(start()).rejects.toThrow('gugu-models:service-unavailable')
    expect(resolveAgentModelLaunch).toHaveBeenCalledTimes(1)
    listAgents.mockResolvedValue([{ gugu_user_id: 'agent-y', cache: { emdash_session_id: SESSION } }])
    platformLaunch('glm-5.2-codex', 60_000, 1_000_000)
    try {
      await expect(start()).resolves.toMatchObject({ model: 'glm-5.2-codex' })
      expect(resolveAgentModelLaunch).toHaveBeenCalledTimes(2)
      expect(resolveAgentModelLaunch).toHaveBeenLastCalledWith(expect.objectContaining({ agentUserId: 'agent-y' }))
    } finally {
      await releasePlatformModelForSession(SESSION).catch(() => undefined)
    }
  })
  // #7092 免费号首启会员模型被拒,换一个免费模型马上再起:那是另一次签发,❌ 拿会员模型那次拒签在窗口内作答。
  it('换了模型的会话不吃旧模型的退避:同一个模型照旧重放,换个模型照常去签', async () => {
    agentOnThisSession()
    loadEngine.mockResolvedValue({ id: 'codex', modelConfigInjection: 'codex-config-flags' })
    resolveAgentModelLaunch.mockRejectedValueOnce(
      new ModelAccessHttpError('model glm-5.3 requires a membership', 403, 'membership_required'),
    )
    const start = (modelId: string) => platformModelForSession({
      surface: 'cui', sessionId: SESSION, providerId: 'codex', authProvider, platformModel: { modelId },
    })
    await expect(start('glm-5.3')).rejects.toThrow('gugu-models:membership-required')
    await expect(start('glm-5.3')).rejects.toThrow('gugu-models:membership-required')
    expect(resolveAgentModelLaunch).toHaveBeenCalledTimes(1)
    platformLaunch('glm-5.3-flash', 60_000, 1_000_000)
    try {
      await expect(start('glm-5.3-flash')).resolves.toMatchObject({ model: 'glm-5.3-flash' })
      expect(resolveAgentModelLaunch).toHaveBeenCalledTimes(2)
    } finally {
      await releasePlatformModelForSession(SESSION).catch(() => undefined)
    }
  })
  it('reads the persisted conversation effort at the shared injection boundary', async () => {
    agentOnThisSession()
    platformLaunch('glm-5.2', 60_000, 1_000_000)
    loadEngine.mockResolvedValue({ id: 'opencode', modelConfigInjection: 'opencode-config-content' })
    getSessions.mockResolvedValue([{ id: SESSION, effort: 'high' }])
    const platform = await platformModelForSession({
      surface: 'cui',
      sessionId: SESSION,
      providerId: 'opencode',
      authProvider,
      platformModel: { modelId: 'glm-5.2' },
    })
    try {
      expect(platform.modelCapability?.reasoningEffort).toBe('high')
      expect(getSessions).toHaveBeenCalledTimes(1)
    } finally {
      await releasePlatformModelForSession(SESSION)
    }
  })
  // #6447 —— 起始档 = 记录 ∩ 该模型在目录里认的档 ∩ 这家引擎的词表。OpenCode 家族对词表外的档是响亮抛错,
  // 所以记录里留着旧档(#6199 之前的存档、从自有模型热切过来的 max)时,不武装才是「会话开得起来」。
  it.each([
    ['the model does not accept it (medium on glm-5.3)', 'medium', ['low', 'high', 'max']],
    ['the model accepts it but OpenCode has no such variant (max on glm-5.3)', 'max', ['low', 'high', 'max']],
    ['the directory has no levels for this model yet', 'high', null],
  ] as const)('does not arm a recorded level when %s — the session still opens', async (_why, recorded, modelEfforts) => {
    agentOnThisSession()
    platformLaunch('glm-5.3', 60_000, 1_000_000, [], 'sess-1', 'https://relay.example', 'sk-session', modelEfforts)
    loadEngine.mockResolvedValue({ id: 'opencode', modelConfigInjection: 'opencode-config-content' })
    getSessions.mockResolvedValue([{ id: SESSION, effort: recorded }])
    const platform = await platformModelForSession({
      surface: 'cui', sessionId: SESSION, providerId: 'opencode', authProvider,
      platformModel: { modelId: 'glm-5.3' },
    })
    try {
      expect(platform.modelCapability?.reasoningEffort).toBeUndefined()
      const config = JSON.parse(platform.spawnEnv.OPENCODE_CONFIG_CONTENT!) as {
        provider: Record<string, { models: Record<string, { options?: unknown; variants?: unknown }> }>
      }
      const entry = Object.values(config.provider)[0]!.models['glm-5.3']!
      expect(entry.variants).toBeDefined()
      expect(entry.options).toBeUndefined()
    } finally {
      await releasePlatformModelForSession(SESSION)
    }
  })

  it('[positive control] arms a recorded level the model and OpenCode both accept', async () => {
    agentOnThisSession()
    platformLaunch('glm-5.3', 60_000, 1_000_000, [], 'sess-1', 'https://relay.example', 'sk-session', ['low', 'high', 'max'])
    loadEngine.mockResolvedValue({ id: 'opencode', modelConfigInjection: 'opencode-config-content' })
    getSessions.mockResolvedValue([{ id: SESSION, effort: 'high' }])
    const platform = await platformModelForSession({
      surface: 'cui', sessionId: SESSION, providerId: 'opencode', authProvider,
      platformModel: { modelId: 'glm-5.3' },
    })
    try {
      expect(platform.modelCapability?.reasoningEffort).toBe('high')
      const config = JSON.parse(platform.spawnEnv.OPENCODE_CONFIG_CONTENT!) as {
        provider: Record<string, { models: Record<string, { options?: unknown }> }>
      }
      expect(Object.values(config.provider)[0]!.models['glm-5.3']!.options).toEqual({ reasoningEffort: 'high' })
    } finally {
      await releasePlatformModelForSession(SESSION)
    }
  })
  it.each([
    ['opencode', 'OPENCODE_CONFIG_CONTENT'],
    ['mimocode', 'MIMOCODE_CONFIG_CONTENT'],
  ] as const)('materializes the signed relay and token into the %s config document', async (providerId, envKey) => {
    agentOnThisSession()
    platformLaunch('glm-5.2-codex', 60_000, 1_000_000)
    loadEngine.mockResolvedValue({ id: providerId, modelConfigInjection: `${providerId}-config-content` })
    const platform = await platformModelForSession({
      surface: 'tui',
      sessionId: SESSION,
      providerId,
      authProvider,
      platformModel: { modelId: 'glm-5.2' },
    })
    const raw = platform.spawnEnv[envKey]
    if (!raw) throw new Error(`expected ${envKey} to be injected`)
    const config = JSON.parse(raw) as {
      model: string
      provider: Record<string, { options: { baseURL: string; apiKey: string } }>
    }
    expect(config.model).toBe('gugu-platform/glm-5.2-codex')
    expect(config.provider['gugu-platform'].options).toEqual({
      baseURL: platform.platformProvider?.baseUrl,
      apiKey: platform.platformProvider?.apiKey,
    })
    expect(config.provider['gugu-platform'].options.apiKey).not.toBe('sk-session')
  })
  it('keys a runtime-only fork token by view id while resolving identity from its source', async () => {
    const runtimeViewId = 'side-chat:view-2503'
    agentOnThisSession()
    platformLaunch('glm-5.2-codex')
    loadEngine.mockResolvedValue({ id: 'codex', modelConfigInjection: 'codex-config-flags' })
    await releasePlatformModelForSession(SESSION)
    const platform = await platformModelForSession({
      surface: 'cui',
      sessionId: runtimeViewId,
      identitySessionId: SESSION,
      providerId: 'codex',
      authProvider,
    })
    try {
      expect(platform.model).toBe('glm-5.2-codex')
      expect(heldPlatformModelForSession(runtimeViewId)?.model).toBe('glm-5.2-codex')
      expect(heldPlatformModelForSession(SESSION)).toBeNull()
    } finally {
      await releasePlatformModelForSession(runtimeViewId)
    }
  })
  it('hands claude the settings override on its own argv', async () => {
    agentOnThisSession()
    platformLaunch('glm-5.2-claude')
    loadEngine.mockResolvedValue({ id: 'claude', modelConfigInjection: 'provider-env' })
    const platform = await platformModelForSession({ surface: 'tui',
      sessionId: SESSION, providerId: 'claude', authProvider, env: CLAUDE_TEST_ENV,
    })
    const at = platform.clientArgs.indexOf('--settings')
    expect(at).toBeGreaterThanOrEqual(0)
    const settingsPath = platform.clientArgs[at + 1]
    expect(settingsPath.endsWith('.json')).toBe(true)
    expect(settingsPath).not.toContain('sk-session')
    const settings = JSON.parse(await readFile(settingsPath, 'utf8')) as { env: Record<string, string> }
    expect(settings.env.ANTHROPIC_BASE_URL).toBe(platform.platformProvider?.baseUrl.replace(/\/v1$/, ''))
    // Override both user credential sources: only the stable loopback secret reaches Claude.
    expect(settings.env.ANTHROPIC_AUTH_TOKEN).toBe(platform.platformProvider?.apiKey)
    expect(settings.env.ANTHROPIC_AUTH_TOKEN).not.toBe('sk-session')
    expect(settings.env.ANTHROPIC_API_KEY).toBe('')
    expect((JSON.parse(await readFile(settingsPath, 'utf8')) as { apiKeyHelper?: unknown }).apiKeyHelper).toBeUndefined()
    expect(settings.env.ANTHROPIC_CUSTOM_MODEL_OPTION).toBe('glm-5.2-claude')
    expect(settings.env.ANTHROPIC_CUSTOM_MODEL_OPTION_NAME).toBe('glm-5.2-claude')
    expect((await stat(settingsPath)).mode & 0o777).toBe(0o600)
  })
  it('writes claude Chat UI the same settings document, but keeps it off the adapter argv', async () => {
    agentOnThisSession()
    platformLaunch('glm-5.2-claude')
    loadEngine.mockResolvedValue({ id: 'claude', modelConfigInjection: 'provider-env' })
    const platform = await platformModelForSession({ surface: 'cui',
      sessionId: SESSION, providerId: 'claude', authProvider, env: CLAUDE_TEST_ENV,
    })
    const settingsPath = platform.settingsDocumentPath
    expect(settingsPath).not.toBeNull()
    if (!settingsPath) return
    const settings = JSON.parse(await readFile(settingsPath, 'utf8')) as { env: Record<string, string> }
    expect(settings.env.ANTHROPIC_BASE_URL).toBe(platform.platformProvider?.baseUrl.replace(/\/v1$/, ''))
    // Override both user credential sources: only the stable loopback secret reaches Claude.
    expect(settings.env.ANTHROPIC_AUTH_TOKEN).toBe(platform.platformProvider?.apiKey)
    expect(settings.env.ANTHROPIC_AUTH_TOKEN).not.toBe('sk-session')
    expect(settings.env.ANTHROPIC_API_KEY).toBe('')
    expect((JSON.parse(await readFile(settingsPath, 'utf8')) as { apiKeyHelper?: unknown }).apiKeyHelper).toBeUndefined()
    expect(settings.env.ANTHROPIC_CUSTOM_MODEL_OPTION).toBe('glm-5.2-claude')
    expect(settings.env.ANTHROPIC_CUSTOM_MODEL_OPTION_NAME).toBe('glm-5.2-claude')
    expect((await stat(settingsPath)).mode & 0o777).toBe(0o600)
    expect(platform.clientArgs).toEqual([])
    expect(platform.spawnEnv.ANTHROPIC_MODEL).toBe('glm-5.2-claude')
    expect(platform.spawnEnv.ANTHROPIC_DEFAULT_HAIKU_MODEL).toBe('glm-5.2-claude')
  })
  it('keeps the Claude platform picker in the session settings without a config root', async () => {
    agentOnThisSession()
    platformLaunch('gpt-5.6-sol', 60_000, 272_000, [
      { alias: 'gpt-5.6-sol', displayName: 'GPT-5.6 Sol', contextWindow: 272_000 },
      { alias: 'gpt-5.6-luna', displayName: 'GPT-5.6 Luna', contextWindow: 272_000 },
    ])
    loadEngine.mockResolvedValue({ id: 'claude', modelConfigInjection: 'provider-env' })
    const platform = await platformModelForSession({ surface: 'cui',
      sessionId: SESSION, providerId: 'claude', authProvider, env: CLAUDE_TEST_ENV,
    })
    expect(platform.spawnEnv).not.toHaveProperty('CLAUDE_CONFIG_DIR')
    const settingsPath = platform.settingsDocumentPath
    expect(settingsPath).not.toBeNull()
    if (!settingsPath) return
    try {
      const settings = JSON.parse(await readFile(settingsPath, 'utf8')) as {
        env: Record<string, string>
        availableModels?: string[]
        modelPicker?: {
          options?: Array<{ model?: string; label?: string }>
          replaceBuiltInOptions?: boolean
        }
        skipWebFetchPreflight?: boolean
      }
      expect(settings.availableModels).toEqual(['gpt-5.6-sol', 'gpt-5.6-luna'])
      // WebFetch's preflight cannot reach api.anthropic.com from where platform sessions run (403, 10-07).
      expect(settings.skipWebFetchPreflight).toBe(true)
      expect(settings.modelPicker).toEqual({
        options: [
          { model: 'gpt-5.6-sol', label: 'GPT-5.6 Sol' },
          { model: 'gpt-5.6-luna', label: 'GPT-5.6 Luna' },
        ],
        replaceBuiltInOptions: true,
      })
      expect(settings.env.ANTHROPIC_CUSTOM_MODEL_OPTION).toBe('gpt-5.6-sol')
      expect(settings.env.ANTHROPIC_CUSTOM_MODEL_OPTION_NAME).toBe('GPT-5.6 Sol')
      expect((await stat(settingsPath)).mode & 0o777).toBe(0o600)
      await releasePlatformModelForSession(SESSION)
      await expect(stat(settingsPath)).rejects.toMatchObject({ code: 'ENOENT' })
    } finally {
      await releasePlatformModelForSession(SESSION)
    }
  })
  it.each(['tui', 'cui'] as const)(
    'tells claude the real window on the %s surface, in the document it actually reads',
    async (surface) => {
      agentOnThisSession()
      platformLaunch('gpt-5.6-sol', 60_000, 272_000)
      loadEngine.mockResolvedValue({ id: 'claude', modelConfigInjection: 'provider-env' })
      const platform = await platformModelForSession({ surface,
        sessionId: SESSION, providerId: 'claude', authProvider, env: CLAUDE_TEST_ENV,
      })
      const settingsPath = platform.settingsDocumentPath
      expect(settingsPath).not.toBeNull()
      if (!settingsPath) return
      const settings = JSON.parse(await readFile(settingsPath, 'utf8')) as { env: Record<string, string> }
      expect(settings.env.CLAUDE_CODE_MAX_CONTEXT_TOKENS).toBe('272000')
      expect(settings.env).not.toHaveProperty('CLAUDE_CODE_AUTO_COMPACT_WINDOW')
      expect(platform.contextWindow).toBe(272_000)
      expect(platform.model).toBe('gpt-5.6-sol')
    },
  )
  it('says nothing about the window when the catalog does not know it', async () => {
    agentOnThisSession()
    platformLaunch('gpt-5.6-sol', 60_000, undefined)
    loadEngine.mockResolvedValue({ id: 'claude', modelConfigInjection: 'provider-env' })
    const platform = await platformModelForSession({ surface: 'tui',
      sessionId: SESSION, providerId: 'claude', authProvider, env: CLAUDE_TEST_ENV,
    })
    const settingsPath = platform.settingsDocumentPath
    expect(settingsPath).not.toBeNull()
    if (!settingsPath) return
    const settings = JSON.parse(await readFile(settingsPath, 'utf8')) as { env: Record<string, string> }
    expect(settings.env).not.toHaveProperty('CLAUDE_CODE_MAX_CONTEXT_TOKENS')
    expect(settings.env.ANTHROPIC_BASE_URL).toBe(platform.platformProvider?.baseUrl.replace(/\/v1$/, ''))
    expect(platform.contextWindow).toBeNull()
  })
  it('gives the codex remote TUI only the secret-free provider declaration needed by its auth gate', async () => {
    agentOnThisSession()
    platformLaunch('glm-5.2-codex')
    loadEngine.mockResolvedValue({ id: 'codex', modelConfigInjection: 'codex-config-flags' })
    const platform = await platformModelForSession({ surface: 'tui',
      sessionId: SESSION, providerId: 'codex', authProvider,
    })
    expect(platform.clientArgs).toContain('model_provider=gugu_platform')
    expect(platform.clientArgs).toContain('model_providers.gugu_platform.env_key=OPENAI_API_KEY')
    expect(platform.clientArgs.some((arg) => arg.startsWith('model='))).toBe(false)
    expect(platform.clientArgs.join(' ')).not.toContain('sk-session')
  })
  it('holds the issued launch for reuse and drops it on release', async () => {
    agentOnThisSession()
    platformLaunch('glm-5.2-codex')
    loadEngine.mockResolvedValue({ id: 'codex', modelConfigInjection: 'codex-config-flags' })
    const platform = await platformModelForSession({ surface: 'tui',
      sessionId: SESSION, providerId: 'codex', authProvider,
    })
    expect(heldPlatformModelForSession(SESSION)).toBe(platform)
    expect(resolveAgentModelLaunch).toHaveBeenCalledTimes(1)
    await releasePlatformModelForSession(SESSION)
    expect(heldPlatformModelForSession(SESSION)).toBeNull()
  })
  it('does not let a late adapter-exit release revoke the replacement access generation', async () => {
    agentOnThisSession()
    loadEngine.mockResolvedValue({ id: 'claude', modelConfigInjection: 'provider-env' })
    platformLaunch('glm-5.2-claude', 60_000, undefined, [], 'access-old')
    await platformModelForSession({
      surface: 'cui', sessionId: SESSION, providerId: 'claude', authProvider,
      env: CLAUDE_TEST_ENV,
    })
    platformLaunch('glm-5.2-claude', 60_000, undefined, [], 'access-new')
    const replacement = await platformModelForSession({
      surface: 'cui', sessionId: SESSION, providerId: 'claude', authProvider,
      env: CLAUDE_TEST_ENV,
    })
    const replacementSettings = replacement.settingsDocumentPath
    if (!replacementSettings) throw new Error('expected replacement Claude settings document')
    await releasePlatformModelForSession(SESSION, 'access-old')
    expect(heldPlatformModelForSession(SESSION)).toBe(replacement)
    await expect(stat(replacementSettings)).resolves.toBeDefined()
    expect(revokePlatformModelAccess).toHaveBeenCalledTimes(1)
    expect(revokePlatformModelAccess).toHaveBeenCalledWith(authProvider, 'access-old')
  })
  it('pins opencode by config document', async () => {
    agentOnThisSession()
    platformLaunch('glm-5.2-codex', 60_000, 1_000_000)
    loadEngine.mockResolvedValue({ id: 'opencode', modelConfigInjection: 'opencode-config-content' })
    const platform = await platformModelForSession({ surface: 'tui',
      sessionId: SESSION, providerId: 'opencode', authProvider,
    })
    const config = JSON.parse(platform.spawnEnv.OPENCODE_CONFIG_CONTENT)
    expect(config.model).toBe('gugu-platform/glm-5.2-codex')
    expect(config.provider['gugu-platform'].options).toEqual({
      baseURL: platform.platformProvider?.baseUrl,
      apiKey: platform.platformProvider?.apiKey,
    })
    expect(config.provider['gugu-platform'].options.apiKey).not.toBe('sk-session')
  })
  // #7103 内部不变量坏了:界面只说「咕咕这边出错了」,写给开发者的那句只进日志。
  it('rejects an OpenCode platform launch without a context window before spawning', async () => {
    agentOnThisSession()
    platformLaunch('glm-5.2-codex')
    loadEngine.mockResolvedValue({ id: 'opencode', modelConfigInjection: 'opencode-config-content' })
    await expect(platformModelForSession({
      surface: 'tui', sessionId: SESSION, providerId: 'opencode', authProvider,
    })).rejects.toThrow('gugu-models:service-unavailable')
  })
  it('refuses to start an engine it cannot pin, instead of spending the turn', async () => {
    agentOnThisSession()
    platformLaunch('glm-5.2-codex')
    loadEngine.mockResolvedValue({ id: 'grok', modelConfigInjection: null })
    await expect(platformModelForSession({ surface: 'tui',
      sessionId: SESSION, providerId: 'grok', authProvider,
    })).rejects.toThrow('gugu-models:not-routable')
  })
  it('leaves a session that never had platform quota completely alone', async () => {
    agentOnThisSession()
    resolveAgentModelLaunch.mockResolvedValue({
      selection: { source: 'default' }, model: null, env: {}, access: null,
    })
    const platform = await platformModelForSession({ surface: 'tui',
      sessionId: SESSION, providerId: 'codex', authProvider,
    })
    expect(platform).toEqual({
      accessSessionId: null,
      expiresAt: null,
      env: {}, model: null, spawnEnv: {}, clientArgs: [], adapterArgs: [], settingsDocumentPath: null, platformProvider: null,
      contextWindow: null, reasoningEfforts: null, modelCapability: null, switchableModels: [],
    })
    expect(revokePlatformModelAccess).not.toHaveBeenCalled()
  })
  it('does not reach the control plane when nobody is signed in', async () => {
    const platform = await platformModelForSession({ surface: 'tui',
      sessionId: SESSION, providerId: 'codex', authProvider: null,
    })
    expect(platform.model).toBeNull()
    expect(resolveAgentModelLaunch).not.toHaveBeenCalled()
  })
})
describe('#2503 composer 的选择就是这个会话的决定', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    revokePlatformModelAccess.mockResolvedValue(undefined)
  })
  it('runs the platform model the composer picked, with the protocol its engine speaks', async () => {
    agentOnThisSession()
    platformLaunch('glm-5.2-codex')
    loadEngine.mockResolvedValue({ id: 'codex', modelConfigInjection: 'codex-config-flags' })
    const platform = await platformModelForSession({ surface: 'tui',
      sessionId: SESSION,
      providerId: 'codex',
      authProvider,
      platformModel: { modelId: 'glm-5.2' },
    })
    expect(platform.model).toBe('glm-5.2-codex')
    expect(resolveAgentModelLaunch).toHaveBeenCalledWith(expect.objectContaining({
      selection: { source: 'platform', modelId: 'glm-5.2', protocol: 'openai-responses' },
    }))
  })
  it('publishes the designated model 的上下文窗口 —— 下游要靠它重建 argv', async () => {
    agentOnThisSession()
    platformLaunch('glm-5.2-codex', 60_000, 1_000_000)
    loadEngine.mockResolvedValue({ id: 'codex', modelConfigInjection: 'codex-config-flags' })
    const platform = await platformModelForSession({ surface: 'tui',
      sessionId: SESSION,
      providerId: 'codex',
      authProvider,
      platformModel: { modelId: 'glm-5.2' },
    })
    expect(platform.contextWindow).toBe(1_000_000)
  })
  it('窗口未知时发布 null,而不是替 harness 猜一个', async () => {
    agentOnThisSession()
    platformLaunch('glm-5.2-codex')
    loadEngine.mockResolvedValue({ id: 'codex', modelConfigInjection: 'codex-config-flags' })
    const platform = await platformModelForSession({ surface: 'tui',
      sessionId: SESSION,
      providerId: 'codex',
      authProvider,
      platformModel: { modelId: 'glm-5.2' },
    })
    expect(platform.contextWindow).toBeNull()
  })
  it('injects NOTHING when the composer picked a harness model, even with a platform agent', async () => {
    agentOnThisSession()
    platformLaunch('glm-5.2-codex')
    loadEngine.mockResolvedValue({ id: 'codex', modelConfigInjection: 'codex-config-flags' })
    const platform = await platformModelForSession({ surface: 'tui',
      sessionId: SESSION, providerId: 'codex', authProvider, platformModel: null,
    })
    expect(platform).toEqual({
      accessSessionId: null,
      expiresAt: null,
      env: {}, model: null, spawnEnv: {}, clientArgs: [], adapterArgs: [], settingsDocumentPath: null, platformProvider: null,
      contextWindow: null, reasoningEfforts: null, modelCapability: null, switchableModels: [],
    })
    expect(resolveAgentModelLaunch).not.toHaveBeenCalled()
  })
  it('falls back to the agent-level选择 for sessions created before this decision existed', async () => {
    agentOnThisSession()
    platformLaunch('glm-5.2-codex')
    loadEngine.mockResolvedValue({ id: 'codex', modelConfigInjection: 'codex-config-flags' })
    const platform = await platformModelForSession({ surface: 'tui',
      sessionId: SESSION, providerId: 'codex', authProvider,
    })
    expect(platform.model).toBe('glm-5.2-codex')
    expect(resolveAgentModelLaunch).toHaveBeenCalledWith(expect.objectContaining({
      selection: undefined,
    }))
  })
  it('provisions the identity a brand-new session does not have yet', async () => {
    listAgents.mockResolvedValue([])
    platformLaunch('glm-5.2-codex')
    loadEngine.mockResolvedValue({ id: 'codex', modelConfigInjection: 'codex-config-flags' })
    const ensureAgentUserId = vi.fn<() => Promise<string | null>>().mockResolvedValue('agent-fresh')
    const platform = await platformModelForSession({ surface: 'tui',
      sessionId: SESSION,
      providerId: 'codex',
      authProvider,
      platformModel: { modelId: 'glm-5.2' },
      ensureAgentUserId,
    })
    expect(ensureAgentUserId).toHaveBeenCalledTimes(1)
    expect(platform.model).toBe('glm-5.2-codex')
    expect(resolveAgentModelLaunch).toHaveBeenCalledWith(expect.objectContaining({
      agentUserId: 'agent-fresh',
    }))
  })
  it('refuses to start rather than silently spend the user\'s own key', async () => {
    listAgents.mockResolvedValue([])
    await expect(platformModelForSession({ surface: 'tui',
      sessionId: SESSION,
      providerId: 'codex',
      authProvider,
      platformModel: { modelId: 'glm-5.2' },
      ensureAgentUserId: async () => null,
    })).rejects.toThrow('gugu-models:no-identity-terminal')
    await expect(platformModelForSession({ surface: 'tui',
      sessionId: SESSION,
      providerId: 'codex',
      authProvider: null,
      platformModel: { modelId: 'glm-5.2' },
    })).rejects.toThrow('gugu-models:runtime-not-connected')
  })
  it('does not provision an identity just to fall back', async () => {
    listAgents.mockResolvedValue([])
    const ensureAgentUserId = vi.fn<() => Promise<string | null>>().mockResolvedValue('agent-fresh')
    const platform = await platformModelForSession({ surface: 'tui',
      sessionId: SESSION, providerId: 'codex', authProvider, ensureAgentUserId,
    })
    expect(ensureAgentUserId).not.toHaveBeenCalled()
    expect(platform.model).toBeNull()
    expect(resolveAgentModelLaunch).not.toHaveBeenCalled()
  })
  it('refuses a platform pick on an engine that cannot be pointed at the relay', async () => {
    agentOnThisSession()
    await expect(platformModelForSession({ surface: 'tui',
      sessionId: SESSION,
      providerId: 'grok',
      authProvider,
      platformModel: { modelId: 'glm-5.2' },
    })).rejects.toThrow('gugu-models:not-routable')
    expect(resolveAgentModelLaunch).not.toHaveBeenCalled()
  })
})
describe('#4467 宿主退出只留 tmux 里仍在跑、凭据不经宿主供给的票', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    revokePlatformModelAccess.mockResolvedValue(undefined)
    markPlatformAccessDetached.mockResolvedValue(undefined)
    getSessions.mockResolvedValue([])
    listAgents.mockResolvedValue([
      { gugu_user_id: 'agent-env', cache: { emdash_session_id: 'conv-env' } },
      { gugu_user_id: 'agent-proxy', cache: { emdash_session_id: 'conv-proxy' } },
    ])
  })
  afterEach(async () => {
    await releasePlatformModelForSession('conv-env').catch(() => undefined)
    await releasePlatformModelForSession('conv-proxy').catch(() => undefined)
  })
  async function startBoth(): Promise<void> {
    // pi:凭据写进子进程环境(宿主退出后进程仍能用);codex:经宿主的回环代理取票(宿主一退就断)。
    platformLaunch('glm-5.2', 600_000, 1_000_000, [], 'sess-env')
    await platformModelForSession({ surface: 'tui', sessionId: 'conv-env', providerId: 'pi', authProvider })
    loadEngine.mockResolvedValue({ id: 'codex', modelConfigInjection: 'codex-config-flags' })
    platformLaunch('glm-5.2-codex', 600_000, 1_000_000, [], 'sess-proxy')
    await platformModelForSession({ surface: 'tui', sessionId: 'conv-proxy', providerId: 'codex', authProvider })
  }

  it('keeps the env-delivered ticket of a live tmux session and releases the host-served one', async () => {
    await startBoth()
    await releasePlatformModelsAtExit(new Set(['conv-env', 'conv-proxy']))
    expect(markPlatformAccessDetached).toHaveBeenCalledWith('sess-env')
    expect(revokePlatformModelAccess).toHaveBeenCalledWith(authProvider, 'sess-proxy')
    expect(revokePlatformModelAccess).not.toHaveBeenCalledWith(authProvider, 'sess-env')
    expect(heldPlatformModelForSession('conv-env')).toBeNull()
  })

  it('keeps the env-delivered candidate when tmux cannot be read, for the next start to decide', async () => {
    await startBoth()
    await releasePlatformModelsAtExit(null)
    expect(markPlatformAccessDetached).toHaveBeenCalledWith('sess-env')
    expect(revokePlatformModelAccess).toHaveBeenCalledWith(authProvider, 'sess-proxy')
    expect(revokePlatformModelAccess).not.toHaveBeenCalledWith(authProvider, 'sess-env')
  })

  it('releases the env-delivered ticket too once its tmux session is gone', async () => {
    await startBoth()
    await releasePlatformModelsAtExit(new Set())
    expect(markPlatformAccessDetached).not.toHaveBeenCalled()
    expect(revokePlatformModelAccess).toHaveBeenCalledWith(authProvider, 'sess-env')
    expect(revokePlatformModelAccess).toHaveBeenCalledWith(authProvider, 'sess-proxy')
  })
})

describe('#2503 平台凭据随会话续期（含存量 helper 兼容）', () => {
  beforeEach(() => {
    legacyHelper.enabled = true
    vi.clearAllMocks()
    vi.useFakeTimers()
    revokePlatformModelAccess.mockResolvedValue(undefined)
    checkpointPlatformModelAccess.mockResolvedValue(undefined)
    // 这一组自己的 beforeEach 先 clearAllMocks,不能靠第一组留下的 getSessions 实现:
    // 被测函数读会话记录取 effort,拿到 undefined 就在 `.find` 上抛(单跑这一组或换执行顺序必红)。
    getSessions.mockResolvedValue([])
    agentOnThisSession()
    loadEngine.mockResolvedValue({ id: 'codex', modelConfigInjection: 'codex-config-flags' })
  })
  afterEach(async () => {
    vi.useRealTimers()
    await releasePlatformModelForSession(SESSION).catch(() => undefined)
  })
  /** 起一条平台会话,凭据 600s 后到期(生产 TTL 默认 900s,同一量级)。 */
  const TTL_MS = 600_000
  async function startSession(onCredentialObservation?: Parameters<typeof platformModelForSession>[0]['onCredentialObservation']): Promise<void> {
    platformLaunch('glm-5.2-codex', TTL_MS)
    await platformModelForSession({ surface: 'tui',
      sessionId: SESSION, providerId: 'codex', authProvider,
      onCredentialObservation,
    })
  }
  it('renews at half the remaining lifetime, and again from the new expiry', async () => {
    const observations = vi.fn()
    await startSession(observations)
    expect(observations).toHaveBeenCalledWith(expect.objectContaining({ generation: 'sess-1', operation: 'issue', outcome: 'success' }))
    renewPlatformModelAccess.mockImplementation(async () => ({
      expiresAt: new Date(Date.now() + TTL_MS).toISOString(),
      membershipLocked: [],
    }))
    await vi.advanceTimersByTimeAsync(TTL_MS / 2 - 1_000)
    expect(renewPlatformModelAccess).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(2_000)
    expect(renewPlatformModelAccess).toHaveBeenCalledTimes(1)
    expect(renewPlatformModelAccess).toHaveBeenCalledWith(authProvider, 'sess-1')
    expect(observations).toHaveBeenCalledWith(expect.objectContaining({ generation: 'sess-1', operation: 'renew', outcome: 'success' }))
    await vi.advanceTimersByTimeAsync(TTL_MS / 2 + 1_000)
    expect(renewPlatformModelAccess).toHaveBeenCalledTimes(2)
  })
  // #7056 会员中途到期:续期回了被收掉的别名 ⇒ 告诉宿主一次(界面刷新目录、下一轮之前停下);续上了再告诉一次。
  it('tells the host once when renewal reports models locked behind a membership, and again when it clears', async () => {
    const changes = vi.fn()
    configurePlatformMembershipListener(changes)
    try {
      await startSession()
      renewPlatformModelAccess.mockImplementation(async () => ({
        expiresAt: new Date(Date.now() + TTL_MS).toISOString(),
        membershipLocked: ['glm-5.2-codex'],
      }))
      await vi.advanceTimersByTimeAsync(TTL_MS / 2 + 1_000)
      expect(changes).toHaveBeenCalledTimes(1)
      expect(changes).toHaveBeenLastCalledWith({ sessionId: SESSION, locked: ['glm-5.2-codex'] })
      // 同样的结果再续一次:不重复广播。
      await vi.advanceTimersByTimeAsync(TTL_MS / 2 + 1_000)
      expect(changes).toHaveBeenCalledTimes(1)
      renewPlatformModelAccess.mockImplementation(async () => ({
        expiresAt: new Date(Date.now() + TTL_MS).toISOString(),
        membershipLocked: [],
      }))
      await vi.advanceTimersByTimeAsync(TTL_MS / 2 + 1_000)
      expect(changes).toHaveBeenCalledTimes(2)
      expect(changes).toHaveBeenLastCalledWith({ sessionId: SESSION, locked: [] })
    } finally {
      configurePlatformMembershipListener(null)
    }
  })
  it('stops renewing the moment the session is released', async () => {
    await startSession()
    await releasePlatformModelForSession(SESSION)
    await vi.advanceTimersByTimeAsync(10 * 60_000)
    expect(renewPlatformModelAccess).not.toHaveBeenCalled()
    expect(revokePlatformModelAccess).toHaveBeenCalledTimes(1)
  })
  it('checkpoints each completed turn without revoking the live session', async () => {
    await startSession()
    await checkpointPlatformModelForSession(SESSION)
    await checkpointPlatformModelForSession(SESSION)
    expect(checkpointPlatformModelAccess).toHaveBeenCalledTimes(2)
    expect(checkpointPlatformModelAccess).toHaveBeenCalledWith(authProvider, 'sess-1')
    expect(revokePlatformModelAccess).not.toHaveBeenCalled()
  })
  it('runs one trailing checkpoint when another turn boundary arrives in flight', async () => {
    await startSession()
    const first = deferred<void>()
    checkpointPlatformModelAccess
      .mockImplementationOnce(() => first.promise)
      .mockResolvedValue(undefined)
    const firstBoundary = checkpointPlatformModelForSession(SESSION)
    await Promise.resolve()
    const secondBoundary = checkpointPlatformModelForSession(SESSION)
    expect(checkpointPlatformModelAccess).toHaveBeenCalledTimes(1)
    first.resolve()
    await Promise.all([firstBoundary, secondBoundary])
    expect(checkpointPlatformModelAccess).toHaveBeenCalledTimes(2)
    expect(revokePlatformModelAccess).not.toHaveBeenCalled()
  })
  it('defers a renewal failure to the next real relay request, and says so out loud', async () => {
    await startSession()
    const logged = vi.spyOn(createLogger('sessionpage/platform-model'), 'error').mockImplementation(() => undefined)
    renewPlatformModelAccess.mockRejectedValueOnce(new Error('control plane unreachable'))
    await vi.advanceTimersByTimeAsync(TTL_MS / 2 + 1_000)
    expect(renewPlatformModelAccess).toHaveBeenCalledTimes(1)
    expect(logged.mock.calls.some(([, message]) => String(message).includes('下一次 credential helper/relay')))
      .toBe(true)
    await vi.advanceTimersByTimeAsync(TTL_MS / 4 + 2_000)
    expect(renewPlatformModelAccess).toHaveBeenCalledTimes(1)
    logged.mockRestore()
  })
  it('keeps a failed renewal bounded until a real relay request arrives', async () => {
    await startSession()
    const logged = vi.spyOn(createLogger('sessionpage/platform-model'), 'error').mockImplementation(() => undefined)
    renewPlatformModelAccess.mockRejectedValue(new Error('control plane unreachable'))
    await vi.advanceTimersByTimeAsync(TTL_MS)
    const attempts = renewPlatformModelAccess.mock.calls.length
    expect(attempts).toBe(1)
    expect(logged.mock.calls.some(([, message]) => String(message).includes('下一次 credential helper/relay')))
      .toBe(true)
    logged.mockRestore()
  })
  it('never calls renew after the absolute eight-hour lifetime cap', async () => {
    const startedAt = Date.now()
    await startSession()
    const calledAt: number[] = []
    renewPlatformModelAccess.mockImplementation(async () => {
      calledAt.push(Date.now())
      return { expiresAt: new Date(Date.now() + TTL_MS).toISOString(), membershipLocked: [] }
    })
    const logged = vi.spyOn(createLogger('sessionpage/platform-model'), 'error').mockImplementation(() => undefined)
    await vi.advanceTimersByTimeAsync(8 * 60 * 60_000 + TTL_MS)
    expect(calledAt.length).toBeGreaterThan(0)
    expect(calledAt.every((time) => time < startedAt + 8 * 60 * 60_000)).toBe(true)
    expect(logged.mock.calls.some(([, message]) => String(message).includes('达到续期寿命上限'))).toBe(true)
    logged.mockRestore()
  })
  it('rotates an expired Claude lease behind the same live process', async () => {
    const observations = vi.fn()
    loadEngine.mockResolvedValue({ id: 'claude', modelConfigInjection: 'provider-env' })
    platformLaunch('glm-5.2-claude', TTL_MS)
    const platform = await platformModelForSession({ surface: 'tui',
      sessionId: SESSION, providerId: 'claude', authProvider, env: CLAUDE_TEST_ENV,
      onCredentialObservation: observations,
    })
    const settingsPath = platform.settingsDocumentPath
    if (!settingsPath) throw new Error('expected Claude settings document')
    const settings = JSON.parse(await readFile(settingsPath, 'utf8')) as { apiKeyHelper: string }
    // 网关令牌不落盘:helper 旁边没有令牌文件,令牌只在宿主内存里,经回环端点按需交出。
    const tokenFileOfOldBuilds = helperPathOf(settings.apiKeyHelper).replace(/\.sh$/, '.token')
    await expect(stat(tokenFileOfOldBuilds)).rejects.toMatchObject({ code: 'ENOENT' })

    issuePlatformModelAccess.mockResolvedValue({
      accessSessionId: 'sess-2', relayUrl: 'https://relay.example', token: 'sk-replacement',
      model: 'glm-5.2-claude', modelId: 'glm-5.2', protocol: 'anthropic-messages',
      expiresAt: new Date(Date.now() + TTL_MS).toISOString(), contextWindow: null, switchableModels: [], membershipLocked: [],
    })
    vi.setSystemTime(Date.now() + TTL_MS + 1)
    await expect(reissueExpiredPlatformModelForSession(SESSION)).resolves.toBe(true)
    expect(observations).toHaveBeenCalledWith(expect.objectContaining({ generation: 'sess-2', classification: 'lease-reissued', outcome: 'success' }))
    await expect(stat(tokenFileOfOldBuilds)).rejects.toMatchObject({ code: 'ENOENT' })
    expect(issuePlatformModelAccess).toHaveBeenCalledWith(expect.objectContaining({
      authProvider, agentUserId: 'agent-1', engineId: 'claude', modelId: 'glm-5.2',
      protocol: 'openai-responses',
      // #6081:新票继承被替换那张票记下的可切清单 —— harness 进程没换,它手里的清单也没换。
      keepFromAccessSessionId: 'sess-1',
    }))
    expect(revokePlatformModelAccess).toHaveBeenCalledWith(authProvider, 'sess-1')
  })
  it('writes the helper as data run by /bin/sh, never as a new executable (#5233 / #6207)', async () => {
    loadEngine.mockResolvedValue({ id: 'claude', modelConfigInjection: 'provider-env' })
    platformLaunch('glm-5.2-claude', TTL_MS)
    const platform = await platformModelForSession({ surface: 'tui',
      sessionId: SESSION, providerId: 'claude', authProvider, env: CLAUDE_TEST_ENV,
    })
    const settingsPath = platform.settingsDocumentPath
    if (!settingsPath) throw new Error('expected Claude settings document')
    const settings = JSON.parse(await readFile(settingsPath, 'utf8')) as { apiKeyHelper: string }
    const helperPath = helperPathOf(settings.apiKeyHelper)
    // 一个执行位都不许有:macOS 对新可执行文件的首次执行要排执行准入,每条会话都付一次。
    expect((await stat(helperPath)).mode & 0o111).toBe(0)
    await expect(runApiKeyHelper(settings.apiKeyHelper)).resolves.toMatchObject({ stdout: 'sk-session\n' })
    // 端点 secret 只在 0600 的 curl 配置里:helper 的内容与 apiKeyHelper 命令行(= 进程 argv)都不带它。
    const helper = await readFile(helperPath, 'utf8')
    const configPath = configPathOf(helper)
    expect(helper).not.toContain('Bearer')
    expect(settings.apiKeyHelper).not.toContain('Bearer')
    expect(await readFile(configPath, 'utf8')).toMatch(/^header = "Authorization: Bearer [0-9a-f-]+"\n$/)
    expect((await stat(configPath)).mode & 0o777).toBe(0o600)
    expect(configPath.startsWith(join(tmpdir(), 'gugu-platform-credential-'))).toBe(true)
  })
  it('does not let the user\'s ~/.curlrc leak into what claude reads as the key (curl -q must come first)', async () => {
    loadEngine.mockResolvedValue({ id: 'claude', modelConfigInjection: 'provider-env' })
    platformLaunch('glm-5.2-claude', TTL_MS)
    const platform = await platformModelForSession({ surface: 'tui',
      sessionId: SESSION, providerId: 'claude', authProvider, env: CLAUDE_TEST_ENV,
    })
    const settingsPath = platform.settingsDocumentPath
    if (!settingsPath) throw new Error('expected Claude settings document')
    const settings = JSON.parse(await readFile(settingsPath, 'utf8')) as { apiKeyHelper: string }
    // `-i` 让 curl 把响应头一起打到 stdout —— claude 读到的就不是票。
    const home = await mkdtemp(join(tmpdir(), 'gugu-curlrc-'))
    await writeFile(join(home, '.curlrc'), '-i\n')
    const env: NodeJS.ProcessEnv = { ...process.env, HOME: home, CURL_HOME: home }
    delete env.XDG_CONFIG_HOME
    try {
      const helper = await readFile(helperPathOf(settings.apiKeyHelper), 'utf8')
      // 阴控:去掉 -q,或者把它挪离第一个参数,同一份 .curlrc 就会把响应头混进输出。
      const withoutQ = helper.replace('$(curl -q ', '$(curl ')
      const qNotFirst = helper.replace('$(curl -q --config ', '$(curl --config ').replace(" --noproxy '*'", " -q --noproxy '*'")
      expect(withoutQ).not.toBe(helper)
      expect(qNotFirst).not.toBe(helper)
      for (const broken of [withoutQ, qNotFirst]) {
        await expect(execFileAsync('sh', ['-c', broken], { env })).resolves.toMatchObject({ stdout: expect.stringMatching(/^HTTP\//) })
      }
      await expect(runApiKeyHelper(settings.apiKeyHelper, { env })).resolves.toMatchObject({ stdout: 'sk-session\n' })
    } finally {
      await rm(home, { recursive: true, force: true })
    }
  })
  it('asks the main process for a fresh token when Claude invokes apiKeyHelper after expiry', async () => {
    loadEngine.mockResolvedValue({ id: 'claude', modelConfigInjection: 'provider-env' })
    platformLaunch('glm-5.2-claude', TTL_MS)
    const platform = await platformModelForSession({ surface: 'tui',
      sessionId: SESSION, providerId: 'claude', authProvider, env: CLAUDE_TEST_ENV,
    })
    const settingsPath = platform.settingsDocumentPath
    if (!settingsPath) throw new Error('expected Claude settings document')
    const settings = JSON.parse(await readFile(settingsPath, 'utf8')) as { apiKeyHelper: string }
    await expect(runApiKeyHelper(settings.apiKeyHelper)).resolves.toMatchObject({ stdout: 'sk-session\n' })
    issuePlatformModelAccess.mockResolvedValue({
      accessSessionId: 'sess-2', relayUrl: 'https://relay.example', token: 'sk-replacement',
      model: 'glm-5.2-claude', modelId: 'glm-5.2', protocol: 'anthropic-messages',
      expiresAt: new Date(Date.now() + TTL_MS).toISOString(), contextWindow: null, switchableModels: [], membershipLocked: [],
    })
    vi.setSystemTime(Date.now() + TTL_MS + 1)
    await expect(runApiKeyHelper(settings.apiKeyHelper)).resolves.toMatchObject({ stdout: 'sk-replacement\n' })
    expect(issuePlatformModelAccess).toHaveBeenCalledTimes(1)
    expect(revokePlatformModelAccess).toHaveBeenCalledWith(authProvider, 'sess-1')
  })
  it('turns a Claude renewal failure into a request-time replacement instead of blind timer retries', async () => {
    loadEngine.mockResolvedValue({ id: 'claude', modelConfigInjection: 'provider-env' })
    platformLaunch('glm-5.2-claude', TTL_MS)
    const platform = await platformModelForSession({ surface: 'tui',
      sessionId: SESSION, providerId: 'claude', authProvider, env: CLAUDE_TEST_ENV,
    })
    const settingsPath = platform.settingsDocumentPath
    if (!settingsPath) throw new Error('expected Claude settings document')
    const settings = JSON.parse(await readFile(settingsPath, 'utf8')) as { apiKeyHelper: string }
    renewPlatformModelAccess.mockRejectedValueOnce(new Error('gateway unavailable'))
    issuePlatformModelAccess.mockResolvedValue({
      accessSessionId: 'sess-2', relayUrl: 'https://relay.example', token: 'sk-replacement',
      model: 'glm-5.2-claude', modelId: 'glm-5.2', protocol: 'anthropic-messages',
      expiresAt: new Date(Date.now() + TTL_MS).toISOString(), contextWindow: null, switchableModels: [], membershipLocked: [],
    })
    await vi.advanceTimersByTimeAsync(TTL_MS / 2)
    expect(renewPlatformModelAccess).toHaveBeenCalledTimes(1)
    await expect(runApiKeyHelper(settings.apiKeyHelper)).resolves.toMatchObject({ stdout: 'sk-replacement\n' })
    expect(issuePlatformModelAccess).toHaveBeenCalledTimes(1)
  })
  it('keeps the loopback credential helper direct even when the harness inherits a proxy', async () => {
    loadEngine.mockResolvedValue({ id: 'claude', modelConfigInjection: 'provider-env' })
    platformLaunch('glm-5.2-claude', TTL_MS)
    const platform = await platformModelForSession({ surface: 'tui',
      sessionId: SESSION, providerId: 'claude', authProvider, env: CLAUDE_TEST_ENV,
    })
    const settingsPath = platform.settingsDocumentPath
    if (!settingsPath) throw new Error('expected Claude settings document')
    const settings = JSON.parse(await readFile(settingsPath, 'utf8')) as { apiKeyHelper: string }
    const proxy = 'http://127.0.0.1:1'
    const env = {
      ...process.env,
      HTTP_PROXY: proxy, HTTPS_PROXY: proxy, ALL_PROXY: proxy,
      http_proxy: proxy, https_proxy: proxy, all_proxy: proxy,
      NO_PROXY: '', no_proxy: '',
    }
    // Without the bypass, this same environment must break the request; otherwise the
    // regression would pass on a host whose curl already ignores the poisoned proxy.
    const helper = await readFile(helperPathOf(settings.apiKeyHelper), 'utf8')
    // The broken bypass only needs one refused connection; retry waits do not test routing.
    const withoutBypass = helper.replace(" --noproxy '*'", '').replace('--retry 15 ', '--retry 0 ')
    await expect(execFileAsync('sh', ['-c', withoutBypass], { env }))
      .rejects.toMatchObject({ code: 7 })
    await expect(runApiKeyHelper(settings.apiKeyHelper, { env }))
      .resolves.toMatchObject({ stdout: 'sk-session\n' })
  })
  it.each(['success', 'failure'] as const)('ignores a late renewal %s from a replaced Claude lease', async (result) => {
    loadEngine.mockResolvedValue({ id: 'claude', modelConfigInjection: 'provider-env' })
    platformLaunch('glm-5.2-claude', TTL_MS)
    const platform = await platformModelForSession({ surface: 'tui',
      sessionId: SESSION, providerId: 'claude', authProvider, env: CLAUDE_TEST_ENV,
    })
    const settingsPath = platform.settingsDocumentPath
    if (!settingsPath) throw new Error('expected Claude settings document')
    const settings = JSON.parse(await readFile(settingsPath, 'utf8')) as { apiKeyHelper: string }
    const renewal = deferred<{ expiresAt: string; membershipLocked: readonly string[] }>()
    renewPlatformModelAccess.mockImplementationOnce(() => renewal.promise)
    await vi.advanceTimersByTimeAsync(TTL_MS / 2)
    vi.setSystemTime(Date.now() + TTL_MS)
    const expiresAt = new Date(Date.now() + TTL_MS).toISOString()
    issuePlatformModelAccess.mockResolvedValue({
      accessSessionId: 'sess-2', relayUrl: 'https://relay.example', token: 'sk-replacement',
      model: 'glm-5.2-claude', modelId: 'glm-5.2', protocol: 'anthropic-messages',
      expiresAt, contextWindow: null, switchableModels: [], membershipLocked: [],
    })
    await expect(reissueExpiredPlatformModelForSession(SESSION)).resolves.toBe(true)
    if (result === 'success') renewal.resolve({ expiresAt: new Date(Date.now() + 1_000).toISOString(), membershipLocked: [] })
    else renewal.reject(new Error('old lease renewal failed'))
    await vi.advanceTimersByTimeAsync(0)
    expect(heldPlatformModelForSession(SESSION)?.expiresAt).toBe(expiresAt)
    await expect(runApiKeyHelper(settings.apiKeyHelper)).resolves.toMatchObject({ stdout: 'sk-replacement\n' })
    expect(issuePlatformModelAccess).toHaveBeenCalledTimes(1)
    expect(renewPlatformModelAccess).toHaveBeenCalledTimes(1)
  })
  it('revokes a replacement that finishes after the Claude session was released', async () => {
    loadEngine.mockResolvedValue({ id: 'claude', modelConfigInjection: 'provider-env' })
    platformLaunch('glm-5.2-claude', TTL_MS)
    await platformModelForSession({ surface: 'tui',
      sessionId: SESSION, providerId: 'claude', authProvider, env: CLAUDE_TEST_ENV,
    })
    const replacement = deferred<{
      accessSessionId: string
      relayUrl: string
      token: string
      model: string
      modelId: string
      protocol: 'anthropic-messages'
      expiresAt: string
      contextWindow: null
      switchableModels: never[]
      membershipLocked: never[]
    }>()
    issuePlatformModelAccess.mockImplementationOnce(async () => replacement.promise)
    vi.setSystemTime(Date.now() + TTL_MS + 1)
    const pending = reissueExpiredPlatformModelForSession(SESSION)
    await Promise.resolve()
    await releasePlatformModelForSession(SESSION)
    replacement.resolve({
      accessSessionId: 'sess-2', relayUrl: 'https://relay.example', token: 'sk-replacement',
      model: 'glm-5.2-claude', modelId: 'glm-5.2', protocol: 'anthropic-messages',
      expiresAt: new Date(Date.now() + TTL_MS).toISOString(), contextWindow: null, switchableModels: [], membershipLocked: [],
    })
    await expect(pending).resolves.toBe(false)
    expect(revokePlatformModelAccess).toHaveBeenCalledWith(authProvider, 'sess-2')
    expect(heldPlatformModelForSession(SESSION)).toBeNull()
  })
  /** 起一条 claude 平台会话,返回它的 apiKeyHelper 命令行。 */
  async function startClaudeHelperSession(observations?: Parameters<typeof platformModelForSession>[0]['onCredentialObservation']): Promise<string> {
    loadEngine.mockResolvedValue({ id: 'claude', modelConfigInjection: 'provider-env' })
    platformLaunch('glm-5.2-claude', TTL_MS)
    const platform = await platformModelForSession({ surface: 'tui',
      sessionId: SESSION, providerId: 'claude', authProvider, env: CLAUDE_TEST_ENV,
      ...(observations ? { onCredentialObservation: observations } : {}),
    })
    if (!platform.settingsDocumentPath) throw new Error('expected Claude settings document')
    return (JSON.parse(await readFile(platform.settingsDocumentPath, 'utf8')) as { apiKeyHelper: string }).apiKeyHelper
  }
  const replacementLease = (accessSessionId: string, token: string) => ({
    accessSessionId, relayUrl: 'https://relay.example', token,
    model: 'glm-5.2-claude', modelId: 'glm-5.2', protocol: 'anthropic-messages',
    expiresAt: new Date(Date.now() + TTL_MS).toISOString(), contextWindow: null, switchableModels: [], membershipLocked: [],
  })
  const EIGHT_HOURS_MS = 8 * 60 * 60_000
  /** 取票脚本失败时 claude 显示的就是它的 stderr(`apiKeyHelper failed: exited 1: <stderr>`)。 */
  async function helperFailure(command: string): Promise<{ code: number; stderr: string; stdout: string }> {
    try {
      await runApiKeyHelper(command)
    } catch (error) {
      const failed = error as { code: number; stderr: string; stdout: string }
      return { code: failed.code, stderr: failed.stderr, stdout: failed.stdout }
    }
    throw new Error('expected the credential helper to fail')
  }

  // 2026-09-25 d22:12 小时的 claude 编程会话在宿主重启后永远拿不到票(rotate 过了上限拒签,curl 每秒重打)。
  it('past the blind-renewal cap, the next real request re-issues through the normal issue path and the session goes on', async () => {
    const helper = await startClaudeHelperSession()
    vi.setSystemTime(Date.now() + EIGHT_HOURS_MS + TTL_MS)
    issuePlatformModelAccess.mockResolvedValue(replacementLease('sess-2', 'sk-after-cap'))
    await expect(runApiKeyHelper(helper)).resolves.toMatchObject({ stdout: 'sk-after-cap\n' })
    expect(issuePlatformModelAccess).toHaveBeenCalledTimes(1)
    expect(issuePlatformModelAccess).toHaveBeenCalledWith(expect.objectContaining({ keepFromAccessSessionId: 'sess-1' }))
    expect(revokePlatformModelAccess).toHaveBeenCalledWith(authProvider, 'sess-1')
    // 新签的票开一条新链:盲续从这一刻重新起算,而不是一签完就撞上老上限。
    renewPlatformModelAccess.mockImplementation(async () => ({ expiresAt: new Date(Date.now() + TTL_MS).toISOString(), membershipLocked: [] }))
    await vi.advanceTimersByTimeAsync(TTL_MS / 2 + 1)
    expect(renewPlatformModelAccess).toHaveBeenCalledWith(authProvider, 'sess-2')
  })
  it('the host recovery gate may also re-issue past the cap (it only runs on real use)', async () => {
    await startClaudeHelperSession()
    vi.setSystemTime(Date.now() + EIGHT_HOURS_MS + 1)
    issuePlatformModelAccess.mockResolvedValue(replacementLease('sess-2', 'sk-after-cap'))
    await expect(reissueExpiredPlatformModelForSession(SESSION)).resolves.toBe(true)
    expect(heldPlatformModelForSession(SESSION)?.accessSessionId).toBe('sess-2')
  })
  it('the blind timer alone never crosses the cap: an unused session just lets its ticket expire', async () => {
    await startClaudeHelperSession()
    renewPlatformModelAccess.mockImplementation(async () => ({ expiresAt: new Date(Date.now() + TTL_MS).toISOString(), membershipLocked: [] }))
    const logged = vi.spyOn(createLogger('sessionpage/platform-model'), 'error').mockImplementation(() => undefined)
    await vi.advanceTimersByTimeAsync(EIGHT_HOURS_MS + 4 * TTL_MS)
    expect(issuePlatformModelAccess).not.toHaveBeenCalled()
    expect(heldPlatformModelForSession(SESSION)?.accessSessionId).toBe('sess-1')
    logged.mockRestore()
  })
  it.each([
    ['membership', new ModelAccessHttpError('model glm-5.2 requires a membership', 403, 'membership_required'), '咕咕:你用的咕咕模型要开会员才能用'],
    ['signed out', new ModelAccessHttpError('unauthorized', 401), '咕咕:登录已失效'],
    ['model gone', new ModelAccessHttpError('no channel sells it', 409, 'model_unavailable'), '咕咕:这个模型现在用不了'],
    ['service down', new ModelAccessHttpError('boom', 503, 'internal'), '咕咕:咕咕这边出错了'],
    // #7103 不带 reason 的(老服务端的 429)❌ 猜成「额度用完」。
    ['no reason', new ModelAccessHttpError('会员额度与不过期积分都已用完', 429), '咕咕:咕咕这边出错了'],
  ] as const)('when issuing fails (%s) the helper fails fast with a plain reason and backs off', async (_label, failure, copy) => {
    const observations = vi.fn()
    const helper = await startClaudeHelperSession(observations)
    const logged = vi.spyOn(createLogger('sessionpage/platform-model'), 'error').mockImplementation(() => undefined)
    vi.setSystemTime(Date.now() + TTL_MS + 1)
    issuePlatformModelAccess.mockRejectedValue(failure)
    const first = await helperFailure(helper)
    expect(first.code).toBe(1)
    expect(first.stdout).toBe('')
    expect(first.stderr.trim()).toMatch(new RegExp(`^${copy}`))
    // 控制面原话不外泄到 agent 界面。
    expect(first.stderr).not.toContain(failure.message)
    expect(issuePlatformModelAccess).toHaveBeenCalledTimes(1)
    expect(observations).toHaveBeenCalledWith(expect.objectContaining({ operation: 'issue', outcome: 'failure' }))
    // 退避窗口内(第一次 10 s):再来要票当场给同一个原因,不打控制面。
    await expect(helperFailure(helper)).resolves.toMatchObject({ code: 1, stderr: first.stderr })
    expect(issuePlatformModelAccess).toHaveBeenCalledTimes(1)
    // 窗口过了再试一次;这次恢复了,会话照常继续,退避清零。
    vi.setSystemTime(Date.now() + 10_001)
    issuePlatformModelAccess.mockResolvedValue(replacementLease('sess-2', 'sk-recovered'))
    await expect(runApiKeyHelper(helper)).resolves.toMatchObject({ stdout: 'sk-recovered\n' })
    expect(issuePlatformModelAccess).toHaveBeenCalledTimes(2)
    logged.mockRestore()
  })
  // #7103 通用形态的转录由咕咕按原因说:取票被拒的原因先递进会话,**送到了才回 403**(harness 知道拿不到票之前,
  // 原因已经在那一轮手上)。判据看顺序,不看墙钟:递送挂着的时候 403 还没写出去,放行之后才写。
  // (阴控:把那两处 await 去掉,挂着时 statuses 就已经是 [403],这一条红。)
  const recordStatuses = () => {
    const statuses: number[] = []
    const realWriteHead = ServerResponse.prototype.writeHead
    ServerResponse.prototype.writeHead = function (this: ServerResponse, ...args: Parameters<ServerResponse['writeHead']>) {
      statuses.push(args[0])
      return realWriteHead.apply(this, args)
    } as typeof realWriteHead
    return { statuses, restore: () => { ServerResponse.prototype.writeHead = realWriteHead } }
  }
  it('取票被咕咕拒:原因先递进会话,送到了才回 403;同一轮后来签出来了先撤掉再交票', async () => {
    const { statuses, restore } = recordStatuses()
    const told: Array<string | null> = []
    let called = deferred<void>()
    let held = deferred<{ delivered: boolean }>()
    configurePlatformCredentialRefusalSink(async (_sessionId, code) => {
      told.push(code)
      called.resolve()
      return held.promise
    })
    const helper = await startClaudeHelperSession()
    const logged = vi.spyOn(createLogger('sessionpage/platform-model'), 'error').mockImplementation(() => undefined)
    try {
      vi.setSystemTime(Date.now() + TTL_MS + 1)
      issuePlatformModelAccess.mockRejectedValue(new ModelAccessHttpError('model glm-5.2 requires a membership', 403, 'membership_required'))
      const failure = helperFailure(helper)
      await called.promise
      expect(told).toEqual(['gugu-models:membership-required'])
      expect(statuses, '递送还挂着,403 不能先出去').toEqual([])
      held.resolve({ delivered: true })
      const failed = await failure
      expect(failed.stderr.trim()).toMatch(/^咕咕:你用的咕咕模型要开会员才能用/)
      expect(statuses).toEqual([403])
      // 同一轮里后来签出来了(窗口过了、原因没了):先撤掉,再交票。
      called = deferred<void>()
      held = deferred<{ delivered: boolean }>()
      vi.setSystemTime(Date.now() + 10_001)
      issuePlatformModelAccess.mockResolvedValue(replacementLease('sess-2', 'sk-recovered'))
      const recovered = runApiKeyHelper(helper)
      await called.promise
      expect(told).toEqual(['gugu-models:membership-required', null])
      expect(statuses, '撤掉还挂着,票不能先交出去').toEqual([403])
      held.resolve({ delivered: true })
      await expect(recovered).resolves.toMatchObject({ stdout: 'sk-recovered\n' })
      expect(statuses).toEqual([403, 200])
    } finally {
      restore()
      configurePlatformCredentialRefusalSink(null)
      logged.mockRestore()
    }
  })
  it('递送卡住:最多等 2 秒,照旧回 403,stderr 那一句照旧', async () => {
    const { statuses, restore } = recordStatuses()
    const called = deferred<void>()
    configurePlatformCredentialRefusalSink(async () => {
      called.resolve()
      return new Promise<never>(() => undefined)
    })
    const helper = await startClaudeHelperSession()
    const logged = vi.spyOn(createLogger('sessionpage/platform-model'), 'error').mockImplementation(() => undefined)
    try {
      vi.setSystemTime(Date.now() + TTL_MS + 1)
      issuePlatformModelAccess.mockRejectedValue(new ModelAccessHttpError('unauthorized', 401))
      const failure = helperFailure(helper)
      await called.promise
      await vi.advanceTimersByTimeAsync(1_999)
      expect(statuses).toEqual([])
      await vi.advanceTimersByTimeAsync(1)
      await expect(failure).resolves.toMatchObject({ code: 1, stderr: expect.stringMatching(/^咕咕:登录已失效/) })
      expect(statuses).toEqual([403])
      expect(logged.mock.calls.some(([, message]) => String(message).includes('没递进会话'))).toBe(true)
    } finally {
      restore()
      configurePlatformCredentialRefusalSink(null)
      logged.mockRestore()
    }
  })
  it('终端会话递不进去(delivered:false)、甚至递的时候出错:照旧回 403,stderr 那一句照旧', async () => {
    const helper = await startClaudeHelperSession()
    const logged = vi.spyOn(createLogger('sessionpage/platform-model'), 'error').mockImplementation(() => undefined)
    try {
      vi.setSystemTime(Date.now() + TTL_MS + 1)
      issuePlatformModelAccess.mockRejectedValue(new ModelAccessHttpError('unauthorized', 401))
      configurePlatformCredentialRefusalSink(async () => ({ delivered: false }))
      await expect(helperFailure(helper)).resolves.toMatchObject({ code: 1, stderr: expect.stringMatching(/^咕咕:登录已失效/) })
      configurePlatformCredentialRefusalSink(async () => { throw new Error('acp runtime is gone') })
      await expect(helperFailure(helper)).resolves.toMatchObject({ code: 1, stderr: expect.stringMatching(/^咕咕:登录已失效/) })
    } finally {
      configurePlatformCredentialRefusalSink(null)
      logged.mockRestore()
    }
  })
  it('the helper answers a failure with a non-retryable status, so curl does not hammer the host', async () => {
    const helper = await startClaudeHelperSession()
    const logged = vi.spyOn(createLogger('sessionpage/platform-model'), 'error').mockImplementation(() => undefined)
    vi.setSystemTime(Date.now() + TTL_MS + 1)
    issuePlatformModelAccess.mockRejectedValue(new ModelAccessHttpError('unauthorized', 401))
    // curl 的 --retry 会重打 5xx;失败时若回 5xx,同一次取票要被重打十几次(d22 上就是每秒一次)。判据是宿主收到几次。
    await helperFailure(helper)
    expect(logged.mock.calls.filter(([, message]) => message === '平台 credential helper 取票失败')).toHaveLength(1)
    logged.mockRestore()
  })
  it('never schedules a renewal for a session that is not on platform quota', async () => {
    resolveAgentModelLaunch.mockResolvedValue({
      selection: { source: 'default' }, model: null, env: {}, access: null,
    })
    await platformModelForSession({ surface: 'tui',
      sessionId: SESSION, providerId: 'codex', authProvider,
    })
    await vi.advanceTimersByTimeAsync(10 * 60_000)
    expect(renewPlatformModelAccess).not.toHaveBeenCalled()
  })
})


describe('claude 的 apiKeyHelper 按平台分叉(#windows-credential-helper)', () => {
  const input = {
    basePath: '/tmp/gugu-platform-credential-1234-abcdef12',
    secret: '11111111-2222-3333-4444-555555555555aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
    url: 'http://127.0.0.1:53124/gugu-platform-credentials/99999999-8888-7777-6666-555555555555',
  }

  /**
   * chole(Windows 11 / Claude Code 2.1.278)实测:`.sh` 会被文件关联**跑起来**,
   * 但 claude 取不到 stdout,报 `apiKeyHelper failed: did not return a value` ——
   * 于是平台模型一个凭据来源都不剩,每轮 401。所以 Windows 必须是 `.cmd`。
   */
  it('win32 出 .cmd,并且用绝对路径的 curl(不依赖 PATH)', () => {
    const helper = claudeCredentialHelperFile('win32', input)
    expect(helper.path).toBe(`${input.basePath}.cmd`)
    expect(helper.command).toBe(helper.path)
    expect(helper.path.endsWith('.sh')).toBe(false)
    expect(helper.contents).toContain('@echo off')
    // -q 紧跟 curl.exe;secret 不在命令行上,只在 --config 那份文件里。
    expect(helper.contents).toContain(`"%SystemRoot%\\System32\\curl.exe" -q --config "${input.basePath}.curlrc" `)
    expect(helper.contents).not.toContain('Bearer')
    expect(helper.config).toEqual({
      path: `${input.basePath}.curlrc`,
      contents: `header = "Authorization: Bearer ${input.secret}"\n`,
    })
    expect(helper.contents).toContain(`"${input.url}"`)
    // cmd 的行尾必须是 CRLF,否则 `@echo off` 那行会带着 \r 被当成命令的一部分
    expect(helper.contents.includes('\r\n')).toBe(true)
    expect(helper.contents).not.toContain('#!/bin/sh')
  })

  it('非 win32 仍出 .sh(不回归)', () => {
    for (const platform of ['darwin', 'linux'] as const) {
      const helper = claudeCredentialHelperFile(platform, input)
      expect(helper.path).toBe(`${input.basePath}.sh`)
      expect(helper.command).toBe(`/bin/sh '${input.basePath}.sh'`)
      expect(helper.contents.startsWith('#!/bin/sh')).toBe(true)
      expect(helper.contents).toContain(`body=$(curl -q --config '${input.basePath}.curlrc' `)
      expect(helper.contents).not.toContain('Bearer')
      expect(helper.contents).toContain(input.url)
      expect(helper.contents).not.toContain('SystemRoot')
    }
  })

  /** 值是我们自己生成的(两个 uuid / 回环 URL);真混进 cmd 元字符说明上游变了,宁可炸。 */
  it('cmd 元字符一律拒绝,不写可注入的 helper', () => {
    for (const bad of ['a"b', 'a%PATH%b', 'a&calc b', 'a|b', 'a<b', 'a>b', 'a^b', 'a\nb']) {
      // secret 进了 curl 配置文件,那里只收 hex/uuid;url 与配置路径仍在 cmd 命令行上,守卫保留。
      expect(() => claudeCredentialHelperFile('win32', { ...input, secret: bad })).toThrow(/hex\/uuid/)
      expect(() => claudeCredentialHelperFile('win32', { ...input, url: bad })).toThrow(/metacharacters/)
      expect(() => claudeCredentialHelperFile('win32', { ...input, basePath: `C:/tmp/${bad}` })).toThrow(/metacharacters/)
    }
    // 阴性对照:正常取值不许炸
    expect(() => claudeCredentialHelperFile('win32', input)).not.toThrow()
  })
})

describe('平台会话的 settings:静态 key 要置空,不能只删(#static-key-outranks-helper)', () => {
  /**
   * chole 实测:只 `delete` 时,claude 会把用户自己 `~/.claude/settings.json` 里的静态
   * `ANTHROPIC_API_KEY` 合并进来并**压过 apiKeyHelper**,于是平台会话拿用户的 key 打咕咕网关 → 401。
   */
  it('两个键都在,且值是空串(不是 undefined、不是缺席)', () => {
    const out = dynamicClaudeSettings({ env: { FOO: 'bar' } }, 'C:/tmp/h.cmd') as Record<string, unknown>
    const env = out.env as Record<string, unknown>
    expect(Object.prototype.hasOwnProperty.call(env, 'ANTHROPIC_API_KEY')).toBe(true)
    expect(Object.prototype.hasOwnProperty.call(env, 'ANTHROPIC_AUTH_TOKEN')).toBe(true)
    expect(env.ANTHROPIC_API_KEY).toBe('')
    expect(env.ANTHROPIC_AUTH_TOKEN).toBe('')
    expect(env.FOO).toBe('bar')            // 其它 env 不动
    expect(out.apiKeyHelper).toBe('C:/tmp/h.cmd')
  })

  it('文档里原本带着静态 key 时也要被盖成空串', () => {
    const out = dynamicClaudeSettings(
      { env: { ANTHROPIC_API_KEY: 'sk-user-static', ANTHROPIC_AUTH_TOKEN: 'sk-user-static' } },
      '/tmp/h.sh',
    ) as Record<string, unknown>
    const env = out.env as Record<string, unknown>
    expect(env.ANTHROPIC_API_KEY).toBe('')
    expect(env.ANTHROPIC_AUTH_TOKEN).toBe('')
  })

  it('document 没有 env 时也要造出这两个键', () => {
    const env = (dynamicClaudeSettings({}, '/tmp/h.sh') as Record<string, unknown>).env as Record<string, unknown>
    expect(env.ANTHROPIC_API_KEY).toBe('')
    expect(env.ANTHROPIC_AUTH_TOKEN).toBe('')
  })
})

// #6447 推理档是**逐模型**的目录事实,与窗口走同一条管道到 codex 的 model catalog。这条管道上每一次转手
// (签发 → 平台声明 → ACP 信封 / pty 嫁接 → zod 边界 → catalog 事实)都漏过字段(见 main.ts 那段三次事故),
// 所以整条链一次钉住:任何一格丢了它,codex 对 glm-5.3 就会报不出 max、对 claude-opus-5 报不出 xhigh。
describe('#6447 平台模型的推理档逐模型到达 codex catalog', () => {
  const GLM = { id: 'glm-5.3', displayName: 'GLM-5.3', contextWindow: 1_000_000, reasoningEfforts: ['low', 'high', 'max'] }
  const OPUS = {
    id: 'claude-opus-5', displayName: 'Claude Opus 5', contextWindow: 1_000_000,
    reasoningEfforts: ['low', 'medium', 'high', 'xhigh', 'max'],
  }
  const MINIMAX = { id: 'minimax-m3', displayName: 'MiniMax M3', contextWindow: 512_000, reasoningEfforts: [] as string[] }
  const expected = [
    { id: 'glm-5.3', displayName: 'GLM-5.3', contextWindow: 1_000_000, efforts: ['low', 'high', 'max'] },
    { id: 'claude-opus-5', displayName: 'Claude Opus 5', contextWindow: 1_000_000, efforts: ['low', 'medium', 'high', 'xhigh', 'max'] },
    { id: 'minimax-m3', displayName: 'MiniMax M3', contextWindow: 512_000, efforts: [] },
  ]

  it('ACP 信封:codexPlatformInjection → acpPlatformInjectionSchema(zod 不丢键)→ catalog 事实', () => {
    const envelope = acpPlatformInjectionSchema.parse(codexPlatformInjection({
      model: 'glm-5.3', providerId: 'gugu_platform', providerLabel: 'Gugu', baseUrl: 'https://relay/v1', apiKey: 'sk',
      authRequest: { command: 'x', args: [] } as never, spawnEnv: {},
      contextWindow: 1_000_000, reasoningEfforts: GLM.reasoningEfforts,
      switchableModels: [GLM, OPUS, MINIMAX],
      callableRoutes: undefined,
    }))
    expect(envelope.reasoningEfforts).toEqual(['low', 'high', 'max'])
    expect(JSON.parse(codexPlatformModelFacts({
      model: envelope.model,
      contextWindow: envelope.contextWindow,
      reasoningEfforts: envelope.reasoningEfforts,
      models: envelope.switchableModels,
    }))).toEqual(expected)
  })

  it('pty / app-server:withPlatformDeclaration 把推理档与窗口一起嫁接,catalog 事实同形', () => {
    const model = withPlatformDeclaration({ dialect: 'codex-config-flags' as const, model: 'glm-5.3' }, {
      platformProvider: { baseUrl: 'https://relay/v1', apiKey: 'sk' },
      contextWindow: 1_000_000,
      reasoningEfforts: GLM.reasoningEfforts,
      switchableModels: [GLM, OPUS, MINIMAX],
    })
    expect(model.reasoningEfforts).toEqual(['low', 'high', 'max'])
    expect(JSON.parse(codexPlatformModelFacts({
      model: model.model!,
      contextWindow: model.contextWindow,
      reasoningEfforts: model.reasoningEfforts,
      models: model.platformModels,
    }))).toEqual(expected)
  })

  it('签发:platformModelForSession 把签发响应里的推理档原样带到平台声明与可切清单', async () => {
    agentOnThisSession()
    loadEngine.mockResolvedValue({ id: 'codex', modelConfigInjection: 'codex-config-flags' })
    resolveAgentModelLaunch.mockResolvedValue({
      selection: { source: 'platform', modelId: 'glm-5.3', protocol: 'openai-responses' },
      model: 'glm-5.3',
      env: { OPENAI_BASE_URL: 'https://relay.example/v1', OPENAI_API_KEY: 'sk-session' },
      access: {
        accessSessionId: 'sess-6447', relayUrl: 'https://relay.example', token: 'sk-session',
        model: 'glm-5.3', modelId: 'glm-5.3', protocol: 'openai-responses',
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
        contextWindow: 1_000_000, reasoningEfforts: ['low', 'high', 'max'],
        switchableModels: [
          { id: 'glm-5.3', alias: 'glm-5.3', displayName: 'GLM-5.3', contextWindow: 1_000_000, reasoningEfforts: ['low', 'high', 'max'] },
          { id: 'claude-opus-5', alias: 'claude-opus-5', displayName: 'Claude Opus 5', contextWindow: 1_000_000, reasoningEfforts: OPUS.reasoningEfforts },
        ],
        membershipLocked: [],
      },
    })
    const platform = await platformModelForSession({
      surface: 'tui', sessionId: SESSION, providerId: 'codex', authProvider,
    })
    try {
      expect(platform.reasoningEfforts).toEqual(['low', 'high', 'max'])
      expect(platform.switchableModels.map((m) => [m.id, m.reasoningEfforts])).toEqual([
        ['glm-5.3', ['low', 'high', 'max']],
        ['claude-opus-5', OPUS.reasoningEfforts],
      ])
    } finally {
      await releasePlatformModelForSession(SESSION)
    }
  })
})

describe('按需签发失败:分类、退避与盲续上限的测试口', () => {
  it('maps control-plane failures to what the user can do about them', () => {
    expect(classifyCredentialIssueFailure(new ModelAccessHttpError('x', 401))).toBe('signedOut')
    expect(classifyCredentialIssueFailure(new ModelAccessHttpError('x', 409, 'model_unavailable'))).toBe('modelUnavailable')
    // #7056 这一档用不了这个模型:单独一类,说清要会员、给去路 —— ❌ 混进「这个模型现在用不了」。
    expect(classifyCredentialIssueFailure(new ModelAccessHttpError('x', 403, 'membership_required'))).toBe('membership')
    // #7103 只认 reason:不带 reason 的 4xx ❌ 再按状态码猜成「额度用完」「这个模型用不了」。
    expect(classifyCredentialIssueFailure(new ModelAccessHttpError('x', 429))).toBe('serviceUnavailable')
    expect(classifyCredentialIssueFailure(new ModelAccessHttpError('x', 400))).toBe('serviceUnavailable')
    expect(classifyCredentialIssueFailure(new ModelAccessHttpError('x', 403))).toBe('serviceUnavailable')
  })
  it('anything else is the service being unavailable', () => {
    expect(classifyCredentialIssueFailure(new ModelAccessHttpError('x', 502))).toBe('serviceUnavailable')
    expect(classifyCredentialIssueFailure(new Error('anything else'))).toBe('serviceUnavailable')
  })
  it('backs off 10s, 20s, 40s … and never waits more than five minutes', () => {
    expect([1, 2, 3, 4, 5, 6, 7, 50].map(credentialIssueBackoffMs))
      .toEqual([10_000, 20_000, 40_000, 80_000, 160_000, 300_000, 300_000, 300_000])
  })
  it('only the test seam shortens the blind-renewal cap', () => {
    expect(renewedLifetimeMs({})).toBe(8 * 60 * 60_000)
    expect(renewedLifetimeMs({ GUGU_TEST_PLATFORM_RENEW_LIFETIME_MS: '120000' })).toBe(120_000)
    for (const bad of ['0', '-5', 'abc', '1.5']) {
      expect(renewedLifetimeMs({ GUGU_TEST_PLATFORM_RENEW_LIFETIME_MS: bad })).toBe(8 * 60 * 60_000)
    }
  })
})
