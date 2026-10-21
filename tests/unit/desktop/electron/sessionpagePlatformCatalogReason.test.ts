import { beforeEach, describe, expect, it, vi } from 'vitest'

// composer 的「咕咕提供的模型」分组缺席时,主进程只给一个**原因码**(各端按码查文案表,
// agent 工具面 session_list_models 拿到的也是码)。mac1 实测原话可以是网络层的
// `net::ERR_PROXY_CONNECTION_FAILED`,从前它被原样放进了 composer 工具栏(#6473 后续);原话只进日志。

const listPlatformModels = vi.fn<(...args: unknown[]) => Promise<unknown[]>>()
const canProvisionSessionpageAgent = vi.fn<(...args: unknown[]) => boolean>(() => true)

vi.mock('../../../../apps/desktop/electron/model-access', () => ({
  listPlatformModels: (...args: unknown[]) => listPlatformModels(...args),
  modelAccessFailureReason: () => 'service-unavailable',
}))
vi.mock('../../../../apps/desktop/electron/sessionpage/emdash-agent-provisioning', () => ({
  canProvisionSessionpageAgent: (...args: unknown[]) => canProvisionSessionpageAgent(...args),
}))
vi.mock('../../../../apps/desktop/electron/sessionpage/sessionpage-session-agent', () => ({
  localAgentForSession: async () => null,
}))

const { sessionpagePlatformCatalog } = await import('../../../../apps/desktop/electron/sessionpage/sessionpage-platform-catalog')

const authProvider = {
  getAuth: async () => ({ accessToken: 't', refreshToken: null, userId: 'owner-1' }),
} as never

describe('平台模型目录缺席的原因码', () => {
  beforeEach(() => {
    listPlatformModels.mockReset()
    canProvisionSessionpageAgent.mockReset()
    canProvisionSessionpageAgent.mockReturnValue(true)
  })

  it('a failure carries only a code; the raw message never leaves the host', async () => {
    listPlatformModels.mockRejectedValue(new Error('net::ERR_PROXY_CONNECTION_FAILED'))

    const catalog = await sessionpagePlatformCatalog({ authProvider, providerId: 'codex', surface: 'tui' })

    expect(catalog.models).toEqual([])
    expect(catalog.catalogError).toBe('gugu-models:service-unavailable')
    expect(JSON.stringify(catalog)).not.toContain('net::')
  })

  it('[positive control] a reachable catalog carries no reason at all', async () => {
    listPlatformModels.mockResolvedValue([])

    const catalog = await sessionpagePlatformCatalog({ authProvider, providerId: 'codex', surface: 'tui' })

    expect(catalog.catalogError).toBeNull()
  })

  it('each gate the catalog closes itself has its own code', async () => {
    const notRoutable = await sessionpagePlatformCatalog({ authProvider, providerId: 'no-such-engine', surface: 'tui' })
    expect(notRoutable.catalogError).toBe('gugu-models:not-routable')

    canProvisionSessionpageAgent.mockReturnValue(false)
    const notProvisioned = await sessionpagePlatformCatalog({ authProvider, providerId: 'codex', surface: 'acp' })
    expect(notProvisioned.catalogError).toBe('gugu-models:no-identity-chat')

    canProvisionSessionpageAgent.mockReturnValue(true)
    const noRuntime = await sessionpagePlatformCatalog({ authProvider: null, providerId: 'codex', surface: 'tui' })
    expect(noRuntime.catalogError).toBe('gugu-models:runtime-not-connected')

    // 这三道门都在取目录之前就关了。
    expect(listPlatformModels).not.toHaveBeenCalled()
  })
})
