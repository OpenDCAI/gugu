// #7337 咕咕给新会话起名的主进程那一半:只给刚建的会话起、拿到身份才签票、模型回来的那一刻才落名;
// 没积分 / 要会员 / 超时都安静地留着当前标题;用过的票一律结掉。
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const issuePlatformModelAccess = vi.fn()
const revokePlatformModelAccess = vi.fn(async (..._args: unknown[]) => undefined)
const fetchMock = vi.fn()

vi.mock('electron', () => ({ net: { fetch: (...args: unknown[]) => fetchMock(...args) } }))
vi.mock('../../../../apps/desktop/electron/model-access', () => ({
  issuePlatformModelAccess: (...args: unknown[]) => issuePlatformModelAccess(...args),
  revokePlatformModelAccess: (...args: unknown[]) => revokePlatformModelAccess(...args),
  modelAccessFailureReason: () => 'membership-required',
}))
vi.mock('../../../../apps/desktop/electron/lib/logger', () => ({
  createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}))

const { createSessionTitleNamer } = await import('../../../../apps/desktop/electron/session-title-namer')

const LONG = '帮我看看为什么登录之后又跳回首页了，应该是 auth.ts 里 verifyLoginOtp 那块的问题'

function ticket(overrides: Record<string, unknown> = {}) {
  return { accessSessionId: 'access-1', relayUrl: 'https://relay.test', token: 'tok', model: 'glm-5.3-flash', membershipLocked: [], ...overrides }
}

function reply(status: number, body: unknown) {
  return { ok: status >= 200 && status < 300, status, json: async () => body }
}

let clock = Date.parse('2026-10-16T19:00:00Z')
const applyTitle = vi.fn((..._args: unknown[]) => true)
const awaitAgentIdentity = vi.fn(async (_agentUserId: string) => undefined)
let state = { fallback: true, managed: true, firstUtterance: LONG as string | undefined }
let model: string | null = 'glm-5.3-flash'
let instructions = ''

function namer() {
  return createSessionTitleNamer({
    authProvider: () => ({}) as never,
    awaitAgentIdentity,
    titleSettings: async () => ({ model, instructions }),
    titleState: () => state,
    applyTitle,
    now: () => clock,
  })
}

beforeEach(() => {
  clock = Date.parse('2026-10-16T19:00:00Z')
  state = { fallback: true, managed: true, firstUtterance: LONG }
  model = 'glm-5.3-flash'
  instructions = ''
  applyTitle.mockReset().mockImplementation(() => { state.fallback = false; return true })
  awaitAgentIdentity.mockReset().mockResolvedValue(undefined)
  issuePlatformModelAccess.mockReset().mockResolvedValue(ticket())
  revokePlatformModelAccess.mockClear()
  fetchMock.mockReset().mockResolvedValue(reply(200, { choices: [{ message: { content: '{"title": "登录后跳回首页"}' } }] }))
})
afterEach(() => {
  vi.useRealTimers()
})

describe('起名', () => {
  it('uses persisted naming eligibility after a restart during a long unfinished first turn', async () => {
    namer()
    expect(applyTitle).not.toHaveBeenCalled()
    expect(issuePlatformModelAccess).not.toHaveBeenCalled()
    clock += 30 * 60_000
    const n = namer()
    await expect(n.firstTurnCompleted('long-turn', 'agent-1')).resolves.toBe('named')
    await expect(n.firstTurnCompleted('long-turn', 'agent-1')).resolves.toBe('not-fallback')
    expect(issuePlatformModelAccess).toHaveBeenCalledTimes(1)
  })
  it('新建的会话拿到身份后以它的名义签票,把首轮交给设置里的模型,落下起出来的名,结掉票', async () => {
    const n = namer()

    await expect(n.firstTurnCompleted('s1', 'agent-1')).resolves.toBe('named')

    expect(issuePlatformModelAccess).toHaveBeenCalledWith(expect.objectContaining({
      agentUserId: 'agent-1', modelId: 'glm-5.3-flash', protocol: 'openai-chat-completions', sessionId: 's1',
    }))
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(url).toBe('https://relay.test/v1/chat/completions')
    expect(JSON.parse(String(init.body)).thinking).toEqual({ type: 'disabled' })
    expect(applyTitle).toHaveBeenCalledWith('s1', '登录后跳回首页')
    expect(revokePlatformModelAccess).toHaveBeenCalledWith(expect.anything(), 'access-1')
  })

  it('签票之前先等这个 agent 的云端身份落地;身份供给失败就不签票', async () => {
    let landed: () => void = () => undefined
    awaitAgentIdentity.mockReturnValueOnce(new Promise<undefined>((resolve) => { landed = () => resolve(undefined) }))
    let n = namer()

    const outcome = n.firstTurnCompleted('s1', 'agent-1')
    await Promise.resolve()
    expect(awaitAgentIdentity).toHaveBeenCalledWith('agent-1')
    expect(issuePlatformModelAccess).not.toHaveBeenCalled()
    landed()
    await expect(outcome).resolves.toBe('named')

    state.fallback = true
    awaitAgentIdentity.mockRejectedValueOnce(new Error('cloud identity provisioning failed'))
    n = namer()

    await expect(n.firstTurnCompleted('s2', 'agent-2')).resolves.toBe('failed')
    expect(issuePlatformModelAccess).toHaveBeenCalledTimes(1)
  })

  it('设置里的「起名要求」随请求带上,排在硬规则之前', async () => {
    instructions = '用英文'
    const n = namer()

    await n.firstTurnCompleted('s1', 'agent-1')
    const system = JSON.parse(String((fetchMock.mock.calls[0] as [string, RequestInit])[1].body)).messages[0].content as string
    expect(system).toContain('用英文')
    expect(system.indexOf('用英文')).toBeLessThan(system.indexOf('Return JSON'))
  })

  it('同一条会话只起一次:身份事件再来一遍不再签票', async () => {
    const n = namer()

    await n.firstTurnCompleted('s1', 'agent-1')
    await expect(n.firstTurnCompleted('s1', 'agent-1')).resolves.toBe('not-fallback')
    expect(issuePlatformModelAccess).toHaveBeenCalledTimes(1)
  })

  it('a legacy task without the managed-name fact is not automatically named', async () => {
    state.managed = false
    const n = namer()

    await expect(n.firstTurnCompleted('old', 'agent-1')).resolves.toBe('not-pending')
    expect(issuePlatformModelAccess).not.toHaveBeenCalled()
  })

  it('a named restored task is not automatically named', async () => {
    state.fallback = false
    await expect(namer().firstTurnCompleted('resumed', 'agent-1')).resolves.toBe('not-fallback')
    expect(issuePlatformModelAccess).not.toHaveBeenCalled()
  })

  it('设置里关掉了、标题已不是兜底、首轮太短:都不签票', async () => {
    for (const [setup, outcome] of [
      [() => { model = null }, 'disabled'],
      [() => { state = { fallback: false, managed: true, firstUtterance: LONG } }, 'not-fallback'],
      [() => { state = { fallback: true, managed: true, firstUtterance: '你好' } }, 'too-short'],
    ] as const) {
      model = 'glm-5.3-flash'
      state = { fallback: true, managed: true, firstUtterance: LONG }
      setup()
      const n = namer()

      await expect(n.firstTurnCompleted('s1', 'agent-1')).resolves.toBe(outcome)
    }
    expect(issuePlatformModelAccess).not.toHaveBeenCalled()
  })

  it('模型回来时人已经改了名 / harness 已经起了名:不收,票照样结掉', async () => {
    applyTitle.mockReturnValue(false)
    const n = namer()

    await expect(n.firstTurnCompleted('s1', 'agent-1')).resolves.toBe('superseded')
    expect(revokePlatformModelAccess).toHaveBeenCalledTimes(1)
  })

  it('签不出票(没积分 / 没登录)、模型要会员、网关 402/403:安静地留着当前标题', async () => {
    issuePlatformModelAccess.mockRejectedValueOnce(new Error('insufficient credits'))
    let n = namer()

    await expect(n.firstTurnCompleted('a', 'agent-1')).resolves.toBe('refused')

    issuePlatformModelAccess.mockResolvedValueOnce(ticket({ membershipLocked: ['glm-5.3-flash'] }))
    n = namer()

    await expect(n.firstTurnCompleted('b', 'agent-1')).resolves.toBe('refused')

    fetchMock.mockResolvedValueOnce(reply(402, { error: { message: '积分用完' } }))
    n = namer()

    await expect(n.firstTurnCompleted('c', 'agent-1')).resolves.toBe('refused')

    // 积分为 0 时票照常签,网关实测回 400 + credits_exhausted(2026-10-16 预发)。
    fetchMock.mockResolvedValueOnce(reply(400, { error: { message: '咕咕积分不足。', code: 'credits_exhausted' } }))
    n = namer()

    await expect(n.firstTurnCompleted('d', 'agent-1')).resolves.toBe('refused')

    expect(applyTitle).not.toHaveBeenCalled()
    // 签出来的三张票都结掉了(第一次没签出票)。
    expect(revokePlatformModelAccess).toHaveBeenCalledTimes(3)
  })

  it('别的 4xx / 5xx 是真故障,不当成「不给」', async () => {
    fetchMock.mockResolvedValueOnce(reply(400, { error: { message: 'bad request', code: 'invalid_value' } }))
    const n = namer()

    await expect(n.firstTurnCompleted('s1', 'agent-1')).resolves.toBe('failed')
  })

  it('模型回的不是一个能用的名:不落', async () => {
    fetchMock.mockResolvedValueOnce(reply(200, { choices: [{ message: { content: '' } }] }))
    const n = namer()

    await expect(n.firstTurnCompleted('s1', 'agent-1')).resolves.toBe('unusable')
    expect(applyTitle).not.toHaveBeenCalled()
  })

  it('5 秒预算到了还没回:放弃,票结掉,标题不动', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    fetchMock.mockImplementationOnce((_url: string, init: RequestInit) => new Promise((_, reject) => {
      init.signal?.addEventListener('abort', () => reject(new Error('aborted')))
    }))
    const n = namer()

    const outcome = n.firstTurnCompleted('s1', 'agent-1')
    await vi.advanceTimersByTimeAsync(5_000)
    await expect(outcome).resolves.toBe('timeout')
    expect(applyTitle).not.toHaveBeenCalled()
    expect(revokePlatformModelAccess).toHaveBeenCalledWith(expect.anything(), 'access-1')
  })

  it('票在预算之后才签回来:那张票签回来就结掉', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    let resolveIssue: (value: unknown) => void = () => undefined
    issuePlatformModelAccess.mockReturnValueOnce(new Promise((resolve) => { resolveIssue = resolve }))
    const n = namer()

    const outcome = n.firstTurnCompleted('s1', 'agent-1')
    await vi.advanceTimersByTimeAsync(5_000)
    await expect(outcome).resolves.toBe('timeout')
    resolveIssue(ticket({ accessSessionId: 'late' }))
    await vi.advanceTimersByTimeAsync(0)
    expect(fetchMock).not.toHaveBeenCalled()
    expect(revokePlatformModelAccess).toHaveBeenCalledWith(expect.anything(), 'late')
  })
})
