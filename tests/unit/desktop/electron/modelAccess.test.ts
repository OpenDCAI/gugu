import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const coreMocks = vi.hoisted(() => ({
  cachedAgentModelSelection: vi.fn(),
  findLocalAgentByUserId: vi.fn(),
  requireRuntimeAuth: vi.fn(),
}))

// Only the IO-bound helpers are stubbed. The protocol table is pure data and the
// production code derives from it, so mocking it here would just be a second copy
// that can silently drift from the real one.
vi.mock('@gugu/core', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  ...coreMocks,
}))
vi.mock('@gugu/core/cloud/config', () => ({
  getSupabaseAnonKey: () => 'public-anon-key',
  getSupabaseUrl: () => 'https://db.example.test',
}))

import { listPlatformModels, resolveAgentModelLaunch } from '../../../../apps/desktop/electron/model-access'
import { createLogger } from '../../../../apps/desktop/electron/lib/logger'
import { parsePlatformReasoningEfforts } from '../../../../apps/desktop/src/session/shared/core/agents/platform-model'

afterEach(() => {
  vi.unstubAllEnvs()
  vi.restoreAllMocks()
})

describe('optional official model provider', () => {
  it('does not request credentials or contact an undeployed model service', async () => {
    vi.stubEnv('GUGU_PLATFORM_MODELS_ENABLED', 'false')
    coreMocks.requireRuntimeAuth.mockClear()
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('must not contact the model service'))
    await expect(listPlatformModels({} as never)).resolves.toEqual([])
    expect(coreMocks.requireRuntimeAuth).not.toHaveBeenCalled()
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('continues to surface a configured provider network failure', async () => {
    vi.stubEnv('GUGU_PLATFORM_MODELS_ENABLED', 'true')
    coreMocks.requireRuntimeAuth.mockResolvedValue({ accessToken: 'test-jwt', userId: 'owner-1' })
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('test network outage'))
    await expect(listPlatformModels({} as never)).rejects.toThrow('test network outage')
    expect(fetchMock).toHaveBeenCalledOnce()
  })
})

describe('resolveAgentModelLaunch', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
    // 签发会往 GUGU_HOME 记一行结清账本(platform-access-ledger);别写进跑测试那个人的真家目录。
    vi.stubEnv('GUGU_HOME', mkdtempSync(join(tmpdir(), 'gugu-model-access-')))
    coreMocks.findLocalAgentByUserId.mockResolvedValue({ user_id: 'agent-1' })
    coreMocks.requireRuntimeAuth.mockResolvedValue({ accessToken: 'owner-jwt', userId: 'owner-1' })
  })

  it.each([
    {
      protocol: 'anthropic-messages' as const,
      engineId: 'claude',
      model: 'glm-5.2-claude',
      contextWindow: 1000000,
      expectedEnv: {
        ANTHROPIC_BASE_URL: 'https://models.example.test',
        ANTHROPIC_AUTH_TOKEN: 'short-token',
        ANTHROPIC_API_KEY: '',
        CLAUDE_CODE_MAX_CONTEXT_TOKENS: '1000000',
      },
    },
    {
      protocol: 'openai-responses' as const,
      engineId: 'codex',
      model: 'glm-5.2-codex',
      contextWindow: 1000000,
      expectedEnv: {
        OPENAI_BASE_URL: 'https://models.example.test/v1',
        OPENAI_API_KEY: 'short-token',
      },
    },
  ])('injects a short platform token for $protocol without mutating user config', async ({
    protocol, engineId, model, contextWindow, expectedEnv,
  }) => {
    coreMocks.cachedAgentModelSelection.mockReturnValue({ source: 'platform', modelId: 'glm-5.2', protocol })
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(Response.json({
      session_id: 'access-session',
      relay_url: 'https://models.example.test/',
      token: 'short-token',
      model,
      protocol,
      context_window: contextWindow,
      expires_at: '2026-07-30T12:00:00.000Z',
    }, { status: 201 }))

    const result = await resolveAgentModelLaunch({
      authProvider: {} as never,
      env: { GUGU_HOME: '/tmp/gugu-model-access-test' },
      agentUserId: 'agent-1',
      engineId,
      providerSessionId: 'provider-session',
    })

    expect(result).toMatchObject({
      model,
      env: expectedEnv,
      access: { accessSessionId: 'access-session', contextWindow },
    })
    expect(fetchMock).toHaveBeenCalledWith('https://db.example.test/functions/v1/model-access', expect.objectContaining({
      method: 'POST',
      headers: expect.objectContaining({ Authorization: 'Bearer owner-jwt', apikey: 'public-anon-key' }),
    }))
    expect(JSON.parse(String(fetchMock.mock.calls[0][1]?.body))).toMatchObject({
      action: 'issue', agent_user_id: 'agent-1', engine_id: engineId,
      model_id: 'glm-5.2', protocol, provider_session_id: 'provider-session',
    })
  })

  // @@@2503 会话页 composer 是会话的唯一决策点:决定由调用方给定,不再回头问 agent 的默认值。
  it('uses the caller-supplied selection instead of the agent-level default', async () => {
    coreMocks.cachedAgentModelSelection.mockReturnValue({
      source: 'platform', modelId: 'agent-level-model', protocol: 'openai-responses',
    })
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(Response.json({
      session_id: 'access-session',
      relay_url: 'https://models.example.test/',
      token: 'short-token',
      model: 'glm-5.2-codex',
      protocol: 'openai-responses',
      expires_at: '2026-07-30T12:00:00.000Z',
    }, { status: 201 }))

    // restoreAllMocks 还原的是 spy 的实现,不清 vi.fn 的调用记录 —— 前面的用例调过同一个 mock。
    coreMocks.findLocalAgentByUserId.mockClear()
    coreMocks.cachedAgentModelSelection.mockClear()

    await resolveAgentModelLaunch({
      authProvider: {} as never,
      env: { GUGU_HOME: '/tmp/gugu-model-access-test' },
      agentUserId: 'agent-1',
      engineId: 'codex',
      selection: { source: 'platform', modelId: 'composer-model', protocol: 'openai-responses' },
    })

    expect(JSON.parse(String(fetchMock.mock.calls[0][1]?.body))).toMatchObject({
      model_id: 'composer-model',
    })
    // agent 级配置在这条路上没有发言权,连读都不该读 —— 读了就有被它盖回去的余地。
    expect(coreMocks.findLocalAgentByUserId).not.toHaveBeenCalled()
    expect(coreMocks.cachedAgentModelSelection).not.toHaveBeenCalled()
  })

  it.each([undefined, null, true, 0, -1, 12.5, '1000000', 'not-a-number'])(
    'omits the Claude window override when the issued value is %s',
    async (contextWindow) => {
      coreMocks.cachedAgentModelSelection.mockReturnValue({
        source: 'platform', modelId: 'glm-5.2', protocol: 'anthropic-messages',
      })
      vi.spyOn(globalThis, 'fetch').mockResolvedValue(Response.json({
        session_id: 'access-session',
        relay_url: 'https://models.example.test/',
        token: 'short-token',
        model: 'glm-5.2-claude',
        protocol: 'anthropic-messages',
        ...(contextWindow === undefined ? {} : { context_window: contextWindow }),
        expires_at: '2026-07-30T12:00:00.000Z',
      }, { status: 201 }))

      const result = await resolveAgentModelLaunch({
        authProvider: {} as never,
        env: { GUGU_HOME: '/tmp/gugu-model-access-test' },
        agentUserId: 'agent-1',
        engineId: 'claude',
      })

      expect(result.access?.contextWindow).toBeNull()
      expect(result.env).not.toHaveProperty('CLAUDE_CODE_MAX_CONTEXT_TOKENS')
    },
  )
})

describe('listPlatformModels', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
    coreMocks.requireRuntimeAuth.mockResolvedValue({ accessToken: 'owner-jwt' })
  })

  it('carries每条协议自己的积分倍率,并丢掉不可能是价格的值', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(Response.json({
      models: [{
        id: 'glm-5.2',
        display_name: 'GLM 5.2',
        protocols: ['anthropic-messages', 'openai-responses'],
        enabled: true,
        context_window: 1000000,
        credit_multipliers: { 'anthropic-messages': 0.3, 'openai-responses': 0 },
      }],
    }))

    await expect(listPlatformModels({} as never)).resolves.toEqual([expect.objectContaining({
      id: 'glm-5.2',
      // ratio 0 不是「免费」而是坏条目;当作没有倍率,UI 少显示一个数字。
      creditMultipliers: { 'anthropic-messages': 0.3 },
      contextWindow: 1000000,
    })])
  })

  it('lists the catalog unchanged when the server sends no multipliers at all', async () => {
    // 倍率是 display-only:老服务端 / 网关问不到 → 空表,目录照常上架。
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(Response.json({
      models: [{
        id: 'glm-5.2', display_name: 'GLM 5.2', protocols: ['openai-responses'],
        enabled: true,
      }],
    }))

    await expect(listPlatformModels({} as never)).resolves.toEqual([expect.objectContaining({
      id: 'glm-5.2', creditMultipliers: {},
      contextWindow: null,
    })])
  })

  // #7056 服务端照列、标 requires_membership 与 hidden(他在设置「模型」页关掉的);只认 true,旧服务端不带 ⇒ 都是 false。
  it('carries requires_membership and hidden, reading only true', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(Response.json({
      models: [
        { id: 'claude-opus-5-5', display_name: 'Claude Opus 5.5', protocols: ['anthropic-messages'], enabled: true, requires_membership: true, hidden: false },
        { id: 'deepseek-v4-flash', display_name: 'DeepSeek V4 Flash', protocols: ['anthropic-messages'], enabled: true, requires_membership: false, hidden: true },
        { id: 'glm-5.2', display_name: 'GLM 5.2', protocols: ['anthropic-messages'], enabled: true, requires_membership: 'yes', hidden: 'yes' },
        { id: 'glm-5.3', display_name: 'GLM 5.3', protocols: ['anthropic-messages'], enabled: true },
      ],
    }))

    const models = await listPlatformModels({} as never)
    expect(models.map((model) => [model.id, model.requiresMembership, model.hidden])).toEqual([
      ['claude-opus-5-5', true, false],
      ['deepseek-v4-flash', false, true],
      ['glm-5.2', false, false],
      ['glm-5.3', false, false],
    ])
  })
})

// #6447 推理档是逐模型的目录事实。`[]` 是答案(这个模型没有这根轴),坏值/缺席是「不知道」—— 两者分开。
describe('reasoning efforts from the directory (#6447)', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
    coreMocks.requireRuntimeAuth.mockResolvedValue({ accessToken: 'owner-jwt' })
  })

  it.each([
    [['low', 'high', 'max'], ['low', 'high', 'max']],
    [[' low ', 'low', 'max'], ['low', 'max']],
    [[], []],
    [undefined, null],
    [null, null],
    ['low', null],
    [['low', 7], null],
    [['low', ''], null],
  ])('parsePlatformReasoningEfforts(%j) → %j', (value, expected) => {
    expect(parsePlatformReasoningEfforts(value)).toEqual(expected)
  })

  it('catalog rows carry each model its own levels; an old server without the column reads as null', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(Response.json({
      models: [
        { id: 'glm-5.3', display_name: 'GLM-5.3', protocols: ['openai-responses'], enabled: true, reasoning_efforts: ['low', 'high', 'max'] },
        { id: 'minimax-m3', display_name: 'MiniMax M3', protocols: ['openai-responses'], enabled: true, reasoning_efforts: [] },
        { id: 'old', display_name: 'Old', protocols: ['openai-responses'], enabled: true },
      ],
    }))
    const models = await listPlatformModels({} as never)
    expect(models.map((m) => [m.id, m.reasoningEfforts])).toEqual([
      ['glm-5.3', ['low', 'high', 'max']],
      ['minimax-m3', []],
      ['old', null],
    ])
  })

  it('issuance carries the designated model levels and each switchable model its own', async () => {
    coreMocks.cachedAgentModelSelection.mockReturnValue({
      source: 'platform', modelId: 'glm-5.3', protocol: 'openai-responses',
    })
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(Response.json({
      session_id: 'access-session',
      relay_url: 'https://models.example.test/',
      token: 'short-token',
      model: 'glm-5.3',
      protocol: 'openai-responses',
      reasoning_efforts: ['low', 'high', 'max'],
      switchable_models: [
        { id: 'glm-5.3', alias: 'glm-5.3', display_name: 'GLM-5.3', reasoning_efforts: ['low', 'high', 'max'] },
        { id: 'gpt-5.6-sol', alias: 'gpt-5.6-sol', display_name: 'GPT-5.6 Sol', reasoning_efforts: ['none', 'low', 'medium', 'high', 'xhigh', 'max'] },
        { id: 'grok-4.5', alias: 'grok-4.5', display_name: 'Grok 4.5' },
      ],
      expires_at: '2026-07-30T12:00:00.000Z',
    }, { status: 201 }))

    const result = await resolveAgentModelLaunch({
      authProvider: {} as never,
      env: { GUGU_HOME: '/tmp/gugu-model-access-test' },
      agentUserId: 'agent-1',
      engineId: 'codex',
    })

    expect(result.access?.reasoningEfforts).toEqual(['low', 'high', 'max'])
    expect(result.access?.switchableModels.map((m) => [m.id, m.reasoningEfforts])).toEqual([
      ['glm-5.3', ['low', 'high', 'max']],
      ['gpt-5.6-sol', ['none', 'low', 'medium', 'high', 'xhigh', 'max']],
      ['grok-4.5', null],
    ])
  })

  // #6921 签发响应的 `callable_routes`(gugu-supabase#95):路由原文 → 能调的模型。
  async function issuedCallableRoutes(callableRoutes: unknown) {
    coreMocks.cachedAgentModelSelection.mockReturnValue({
      source: 'platform', modelId: 'gpt-6-astra', protocol: 'openai-responses',
    })
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(Response.json({
      session_id: 'access-session',
      relay_url: 'https://models.example.test/',
      token: 'short-token',
      model: 'gpt-6-astra',
      protocol: 'openai-responses',
      expires_at: '2026-07-30T12:00:00.000Z',
      ...(callableRoutes === undefined ? {} : { callable_routes: callableRoutes }),
    }, { status: 201 }))
    const result = await resolveAgentModelLaunch({
      authProvider: {} as never,
      env: { GUGU_HOME: '/tmp/gugu-model-access-test' },
      agentUserId: 'agent-1',
      engineId: 'codex',
    })
    return result.access?.callableRoutes
  }

  it('issuance carries callable_routes verbatim, route keys untouched', async () => {
    await expect(issuedCallableRoutes({
      '/v1/responses': ['gpt-6-astra', 'glm-5.3'],
      '/v1/images/generations': ['gpt-image-2'],
    })).resolves.toEqual({
      '/v1/responses': ['gpt-6-astra', 'glm-5.3'],
      '/v1/images/generations': ['gpt-image-2'],
    })
  })

  it('an older server without callable_routes issues normally with an empty table, silently', async () => {
    const warn = vi.spyOn(createLogger('model-access'), 'warn').mockImplementation(() => undefined)
    await expect(issuedCallableRoutes(undefined)).resolves.toEqual({})
    expect(warn).not.toHaveBeenCalled()
  })

  it('drops malformed routes one by one instead of refusing the session, and says which', async () => {
    const warn = vi.spyOn(createLogger('model-access'), 'warn').mockImplementation(() => undefined)
    await expect(issuedCallableRoutes({
      '/v1/images/generations': ['gpt-image-2', 7, ' ', null],
      '/v1/images/edits': 'gpt-image-2',
      '/v1/alpha/search': [],
    })).resolves.toEqual({ '/v1/images/generations': ['gpt-image-2'] })
    expect(warn).toHaveBeenLastCalledWith(
      { routes: ['/v1/images/generations', '/v1/images/edits', '/v1/alpha/search'] },
      expect.stringContaining('callable_routes'),
    )
    warn.mockClear()
    // 键按原文收:两个只差空白的键各算各的,❌ 修剪后互相盖掉。
    await expect(issuedCallableRoutes({
      ' /v1/images/generations': ['dall-e-3'],
      '/v1/images/generations': ['gpt-image-2'],
    })).resolves.toEqual({
      ' /v1/images/generations': ['dall-e-3'],
      '/v1/images/generations': ['gpt-image-2'],
    })
    warn.mockClear()
    await expect(issuedCallableRoutes(['gpt-image-2'])).resolves.toEqual({})
    expect(warn).toHaveBeenCalledWith({ received: 'object' }, expect.stringContaining('not an object'))
  })
})
