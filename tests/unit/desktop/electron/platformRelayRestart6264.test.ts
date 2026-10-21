// #6264 用咕咕自营模型的「编程」会话活过宿主进程重启:取票脚本、口令、端口都不变,票以同一条会话的身份接上。
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { execFile } from 'node:child_process'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
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
const claimPlatformAccessForThisProcess = vi.fn<(...args: unknown[]) => Promise<void>>(async () => undefined)
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
vi.mock('@gugu/core', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  listAgents: (...args: unknown[]) => listAgents(...args),
}))
vi.mock('../../../../apps/desktop/electron/acp-engine-utils', () => ({
  loadEngine: (...args: unknown[]) => loadEngine(...args),
}))
vi.mock('../../../../apps/desktop/electron/model-access', () => ({
  checkpointPlatformModelAccess: (...args: unknown[]) => checkpointPlatformModelAccess(...args),
  issuePlatformModelAccess: (...args: unknown[]) => issuePlatformModelAccess(...args),
  resolveAgentModelLaunch: (...args: unknown[]) => resolveAgentModelLaunch(...args),
  revokePlatformModelAccess: (...args: unknown[]) => revokePlatformModelAccess(...args),
  renewPlatformModelAccess: (...args: unknown[]) => renewPlatformModelAccess(...args),
  markPlatformAccessDetached: (...args: unknown[]) => markPlatformAccessDetached(...args),
  settleAdoptedPlatformAccessAtExit: async () => undefined,
  claimPlatformAccessForThisProcess: (...args: unknown[]) => claimPlatformAccessForThisProcess(...args),
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
  configurePlatformRelayPersistence,
  heldPlatformModelForSession,
  platformModelForSession,
  releasePlatformModelForSession,
  releasePlatformModelsAtExit,
  resetPlatformRelayPersistenceForTest,
  platformRelaySessionsRestored,
  restorePlatformRelaySessions,
  sweepStalePlatformSettingsFiles,
} = await import('../../../../apps/desktop/electron/sessionpage/sessionpage-platform-model')

const CONV = 'conv-relay'
const TTL_MS = 900_000
const authProvider = {
  getAuth: async () => ({ accessToken: 't', refreshToken: null, userId: 'owner-1' }),
} as never
const log = { info: vi.fn(), warn: vi.fn() }
let dataDir = ''
const env = { ...process.env, GUGU_HOME: join(tmpdir(), `gugu-relay-${process.pid}`) }

function claudeLaunch(accessSessionId = 'sess-1', token = 'sk-session'): void {
  resolveAgentModelLaunch.mockResolvedValue({
    selection: { source: 'platform', modelId: 'glm-5.2', protocol: 'anthropic-messages' },
    model: 'glm-5.2-claude',
    env: { ANTHROPIC_BASE_URL: 'https://relay.example', ANTHROPIC_AUTH_TOKEN: token },
    access: {
      accessSessionId, relayUrl: 'https://relay.example', token, model: 'glm-5.2-claude', modelId: 'glm-5.2',
      protocol: 'anthropic-messages', expiresAt: new Date(Date.now() + TTL_MS).toISOString(),
      contextWindow: null, switchableModels: [], membershipLocked: [],
    },
  })
}

async function startClaude(): Promise<{ helperCommand: string; files: string[] }> {
  loadEngine.mockResolvedValue({ id: 'claude', modelConfigInjection: 'provider-env' })
  claudeLaunch()
  const platform = await platformModelForSession({ surface: 'tui', sessionId: CONV, providerId: 'claude', authProvider, env })
  const settingsPath = platform.settingsDocumentPath!
  const settings = JSON.parse(await readFile(settingsPath, 'utf8')) as { apiKeyHelper: string }
  const helper = helperPathOf(settings.apiKeyHelper)
  return { helperCommand: settings.apiKeyHelper, files: [settingsPath, helper, configPathOf(await readFile(helper, 'utf8'))] }
}

/** 旧宿主退出、新宿主起来:内存全空,同一个数据目录。 */
function newHostProcess(): void {
  resetPlatformRelayPersistenceForTest()
  configurePlatformRelayPersistence({ dataDir, log })
}

async function withReconnect<T>(run: () => Promise<T>, attempts = 5): Promise<T> {
  for (let i = 1; ; i += 1) {
    try {
      return await run()
    } catch (error) {
      // 连接池里那条旧的保活连接随旧端点断了:重连即可(harness 同样重试)。
      if (i >= attempts) throw error
    }
  }
}

const exists = (file: string) => stat(file).then(() => true, () => false)

describe('#6264 平台转发口活过宿主进程重启', () => {
  beforeEach(async () => {
    vi.clearAllMocks()
    dataDir = await mkdtemp(join(tmpdir(), 'gugu-relay-data-'))
    getSessions.mockResolvedValue([])
    listAgents.mockResolvedValue([{ gugu_user_id: 'agent-1', cache: { emdash_session_id: CONV } }])
    revokePlatformModelAccess.mockResolvedValue(undefined)
    renewPlatformModelAccess.mockResolvedValue({ expiresAt: new Date(Date.now() + TTL_MS).toISOString(), membershipLocked: [] })
    lookupHarnessModelCatalog.mockResolvedValue({ state: { kind: 'ready', models: [], selected: null, efforts: [], selectedEffort: null }, refreshing: false })
    getHarnessModelCatalog.mockResolvedValue({ kind: 'ready', models: [], selected: null, efforts: [], selectedEffort: null })
    newHostProcess()
  })
  afterEach(async () => {
    await releasePlatformModelForSession(CONV).catch(() => undefined)
    resetPlatformRelayPersistenceForTest()
    await rm(dataDir, { recursive: true, force: true })
  })

  it('tmux 里还活着的 claude:旧宿主退出不撤票;新宿主认回后,同一个取票脚本拿到同一条会话重签的票', async () => {
    const { helperCommand, files } = await startClaude()
    await expect(runApiKeyHelper(helperCommand)).resolves.toMatchObject({ stdout: 'sk-session\n' })

    await releasePlatformModelsAtExit(new Set([CONV]))
    expect(markPlatformAccessDetached).toHaveBeenCalledWith('sess-1')
    expect(revokePlatformModelAccess).not.toHaveBeenCalled()
    for (const file of files) expect(await exists(file)).toBe(true)

    newHostProcess()
    // 新宿主的开机收尸不收这几份(那条会话还在用)。
    await sweepStalePlatformSettingsFiles()
    for (const file of files) expect(await exists(file)).toBe(true)
    await expect(restorePlatformRelaySessions({ authProvider, liveSessions: async () => new Set([CONV]) }))
      .resolves.toEqual({ restored: [CONV], dropped: [] })
    // 账本行改记本进程:启动结清不会撤它。
    expect(claimPlatformAccessForThisProcess).toHaveBeenCalledWith('sess-1')

    issuePlatformModelAccess.mockResolvedValue({
      accessSessionId: 'sess-2', relayUrl: 'https://relay.example', token: 'sk-after-restart',
      model: 'glm-5.2-claude', modelId: 'glm-5.2', protocol: 'anthropic-messages',
      expiresAt: new Date(Date.now() + TTL_MS).toISOString(), contextWindow: null, switchableModels: [], membershipLocked: [],
    })
    // agent 手里还是重启前那一行命令、那个端口、那份口令。
    await expect(runApiKeyHelper(helperCommand)).resolves.toMatchObject({ stdout: 'sk-after-restart\n' })
    // 以同一条会话的身份重签(继承旧票的可切清单),旧票随即撤销结清 —— 计费不重不漏。
    expect(issuePlatformModelAccess).toHaveBeenCalledTimes(1)
    expect(issuePlatformModelAccess).toHaveBeenCalledWith(expect.objectContaining({
      sessionId: CONV, agentUserId: 'agent-1', engineId: 'claude', keepFromAccessSessionId: 'sess-1',
    }))
    expect(revokePlatformModelAccess).toHaveBeenCalledWith(authProvider, 'sess-1')
    // 之后照常:再要一次不再重签。
    await expect(runApiKeyHelper(helperCommand)).resolves.toMatchObject({ stdout: 'sk-after-restart\n' })
    expect(issuePlatformModelAccess).toHaveBeenCalledTimes(1)
  })

  // 2026-09-25 d22 实例:会话跑了 12 小时(过了 8 小时盲续上限)后宿主重启 —— 以前取票永远被拒、curl 每秒重打。
  it('认回一条已经过了盲续上限的会话:第一次要票照常重签,会话继续', async () => {
    const { helperCommand } = await startClaude()
    await releasePlatformModelsAtExit(new Set([CONV]))
    const ledger = join(dataDir, 'platform-relay-sessions.json')
    const before = await readFile(ledger, 'utf8')
    const aged = before.replace(/"renewUntil":\d+/, `"renewUntil":${Date.now() - 4 * 60 * 60_000}`)
    expect(aged).not.toBe(before)
    await writeFile(ledger, aged)

    newHostProcess()
    await restorePlatformRelaySessions({ authProvider, liveSessions: async () => new Set([CONV]) })
    issuePlatformModelAccess.mockResolvedValue({
      accessSessionId: 'sess-2', relayUrl: 'https://relay.example', token: 'sk-past-cap',
      model: 'glm-5.2-claude', modelId: 'glm-5.2', protocol: 'anthropic-messages',
      expiresAt: new Date(Date.now() + TTL_MS).toISOString(), contextWindow: null, switchableModels: [], membershipLocked: [],
    })
    await expect(runApiKeyHelper(helperCommand)).resolves.toMatchObject({ stdout: 'sk-past-cap\n' })
    expect(issuePlatformModelAccess).toHaveBeenCalledTimes(1)
    // 新链从此刻起算,写回盘上:下一次重启认回的是新上限。
    const renewUntil = Number(/"renewUntil":(\d+)/.exec(await readFile(ledger, 'utf8'))?.[1])
    expect(renewUntil).toBeGreaterThan(Date.now() + 7 * 60 * 60_000)
  })

  it('重新接上那条 tmux 会话时,手上认回的那份原样交回(❌ 重签、❌ 删掉 agent 正在用的文件)', async () => {
    const { files } = await startClaude()
    await releasePlatformModelsAtExit(new Set([CONV]))
    newHostProcess()
    await restorePlatformRelaySessions({ authProvider, liveSessions: async () => new Set([CONV]) })
    expect(heldPlatformModelForSession(CONV)).toMatchObject({ accessSessionId: 'sess-1', settingsDocumentPath: files[0] })
  })

  // PR-7 开机读数(2026-10-09):tmux 里的 agent 敲早绑的 MCP 端口,唤醒比认回早,
  // 手里那份还没认回 ⇒ 另签一张;三张同秒签,网关池拒掉一张,那条会话落 error。
  it('开机认回只读本机(盘、tmux、账本文件):owner 一直没确立(没登录)也落定,手里那份照样在、不签票;等它的人(哪怕比认回开跑还早)等到认回之后', async () => {
    await startClaude()
    await releasePlatformModelsAtExit(new Set([CONV]))
    newHostProcess()
    const signedOut = { getAuth: async () => { throw new Error('not signed in') } } as never
    // 唤醒比认回开跑还早:配置落盘那一刻起就得等,❌ 当场放行。
    let restored = false
    const waiter = platformRelaySessionsRestored().then(() => { restored = true })
    await new Promise((resolve) => setImmediate(resolve))
    expect(restored).toBe(false)
    let tmuxAnswered = (_: Set<string>) => {}
    const restore = restorePlatformRelaySessions({
      authProvider: signedOut,
      liveSessions: () => new Promise((resolve) => { tmuxAnswered = resolve }),
    })
    await new Promise((resolve) => setImmediate(resolve))
    expect(restored).toBe(false)
    expect(heldPlatformModelForSession(CONV)).toBeNull()
    tmuxAnswered(new Set([CONV]))
    await waiter
    await expect(restore).resolves.toEqual({ restored: [CONV], dropped: [] })
    expect(heldPlatformModelForSession(CONV)).toMatchObject({ accessSessionId: 'sess-1' })
    expect(issuePlatformModelAccess).not.toHaveBeenCalled()
    expect(claimPlatformAccessForThisProcess).toHaveBeenCalledWith('sess-1')
  })

  it('重启期间 tmux 会话已经没了:认回时收掉它的文件与记录,票交给账本结清', async () => {
    const { files } = await startClaude()
    await releasePlatformModelsAtExit(new Set([CONV]))
    newHostProcess()
    await expect(restorePlatformRelaySessions({ authProvider, liveSessions: async () => new Set() }))
      .resolves.toEqual({ restored: [], dropped: [CONV] })
    for (const file of files) expect(await exists(file)).toBe(false)
    expect(claimPlatformAccessForThisProcess).not.toHaveBeenCalled()
    expect(heldPlatformModelForSession(CONV)).toBeNull()
  })

  it('读不出 tmux:这一轮谁都不动', async () => {
    const { files } = await startClaude()
    await releasePlatformModelsAtExit(new Set([CONV]))
    newHostProcess()
    await expect(restorePlatformRelaySessions({ authProvider, liveSessions: async () => { throw new Error('tmux') } }))
      .resolves.toEqual({ restored: [], dropped: [] })
    for (const file of files) expect(await exists(file)).toBe(true)
  })

  it('会话真结束(release):盘上那一行一起删,下次启动不再认', async () => {
    await startClaude()
    await releasePlatformModelForSession(CONV)
    expect(revokePlatformModelAccess).toHaveBeenCalledWith(authProvider, 'sess-1')
    newHostProcess()
    await expect(restorePlatformRelaySessions({ authProvider, liveSessions: async () => new Set([CONV]) }))
      .resolves.toEqual({ restored: [], dropped: [] })
  })

  it('没配落盘(旧行为):宿主供给的票在退出时照撤', async () => {
    resetPlatformRelayPersistenceForTest()
    await startClaude()
    await releasePlatformModelsAtExit(new Set([CONV]))
    expect(revokePlatformModelAccess).toHaveBeenCalledWith(authProvider, 'sess-1')
    expect(markPlatformAccessDetached).not.toHaveBeenCalled()
  })

  it('回环代理那一类(codex / opencode / mimocode):重启后同一个本机地址、同一个口令,请求带着同一条会话重签的票到上游', async () => {
    const seen: string[] = []
    const upstream = createServer((request, response) => {
      seen.push(`${request.url} ${request.headers.authorization}`)
      response.writeHead(200, { 'content-type': 'application/json' }).end('{"ok":true}')
    })
    await new Promise<void>((resolve) => upstream.listen(0, '127.0.0.1', resolve))
    const relayUrl = `http://127.0.0.1:${(upstream.address() as { port: number }).port}`
    try {
      loadEngine.mockResolvedValue({ id: 'codex', modelConfigInjection: 'codex-config-flags' })
      resolveAgentModelLaunch.mockResolvedValue({
        selection: { source: 'platform', modelId: 'glm-5.2', protocol: 'openai-responses' },
        model: 'glm-5.2-codex',
        env: { OPENAI_BASE_URL: `${relayUrl}/v1`, OPENAI_API_KEY: 'sk-session' },
        access: {
          accessSessionId: 'sess-1', relayUrl, token: 'sk-session', model: 'glm-5.2-codex', modelId: 'glm-5.2',
          protocol: 'openai-responses', expiresAt: new Date(Date.now() + TTL_MS).toISOString(),
          contextWindow: 1_000_000, switchableModels: [], membershipLocked: [],
        },
      })
      const platform = await platformModelForSession({ surface: 'tui', sessionId: CONV, providerId: 'codex', authProvider, env })
      const provider = platform.platformProvider!
      expect(provider.baseUrl.startsWith('http://127.0.0.1:')).toBe(true)
      const call = () => fetch(`${provider.baseUrl}/responses`, { method: 'POST', headers: { authorization: `Bearer ${provider.apiKey}` }, body: '{}' })
      expect((await call()).status).toBe(200)

      await releasePlatformModelsAtExit(new Set([CONV]))
      newHostProcess()
      await restorePlatformRelaySessions({ authProvider, liveSessions: async () => new Set([CONV]) })
      issuePlatformModelAccess.mockResolvedValue({
        accessSessionId: 'sess-2', relayUrl, token: 'sk-after-restart', model: 'glm-5.2-codex', modelId: 'glm-5.2',
        protocol: 'openai-responses', expiresAt: new Date(Date.now() + TTL_MS).toISOString(), contextWindow: 1_000_000, switchableModels: [], membershipLocked: [],
      })
      // 同一个 baseUrl(端口)、同一个 apiKey(口令):重启前发给 harness 的那一份原样能用。
      const response = await withReconnect(call)
      expect(response.status).toBe(200)
      expect(seen).toEqual(['/v1/responses Bearer sk-session', '/v1/responses Bearer sk-after-restart'])
      expect(revokePlatformModelAccess).toHaveBeenCalledWith(authProvider, 'sess-1')
    } finally {
      await new Promise((resolve) => upstream.close(resolve))
    }
  })

  it('取票脚本在宿主重启那几秒里自己重试(连接被拒也重试)', async () => {
    const { helperCommand } = await startClaude()
    const helper = await readFile(helperPathOf(helperCommand), 'utf8')
    expect(helper).toContain('--retry-connrefused')
    expect(helper).toMatch(/--retry-max-time 30/)
  })
})

// #7120 认回读的 tmux 名与平台票账本,都是 boot 里段 2 迁移改的(task-to-session / session-naming)。
// main.ts 拿不到 Electron 跑不起来,所以这一格钉结构:认回挂在 emdashBoot 之后,❌ 回到 boot 之前的早段。
describe('开机认回排在 boot 的迁移之后 (#7120)', () => {
  it('restorePlatformRelaySessions 只在 emdashBoot 落定之后起跑', async () => {
    const { readFileSync } = await import('node:fs')
    const main = readFileSync(join(process.cwd(), 'apps/desktop/electron/main.ts'), 'utf8')
    const calls = [...main.matchAll(/restorePlatformRelaySessions\(\{/g)].map((match) => match.index!)
    expect(calls).toHaveLength(1)
    const boot = main.indexOf('const emdashBoot = emdash.bootEmdashModule(ipcMain)')
    expect(boot).toBeGreaterThan(-1)
    expect(calls[0]).toBeGreaterThan(boot)
    expect(main.slice(boot, calls[0])).toContain('void emdashBoot.catch(() => undefined)')
  })
})
