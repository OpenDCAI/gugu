import { beforeEach, describe, expect, it, vi } from 'vitest'
import { RuntimeAuthExpiredError, type RuntimeAuthProvider } from '@gugu/core'
import type { GuguMcpContext } from '../../../../apps/desktop/electron/acp-engine-utils'

const mocks = vi.hoisted(() => ({
  invokeRendererAuth: vi.fn(async () => 'PRIMARY_RENDERER_TOKEN'),
  identityTokens: [] as string[],
  resolveNodeBin: vi.fn(() => '/usr/bin/node'),
  mcpContexts: [] as GuguMcpContext[],
}))

vi.mock('../../../../apps/desktop/electron/ipc-bridge', () => ({
  invokeRendererAuth: mocks.invokeRendererAuth,
}))

vi.mock('@gugu/core/cloud/config', () => ({
  getSupabaseUrl: () => 'https://supabase.example',
  getSupabaseAnonKey: () => 'anon-key',
}))

vi.mock('../../../../apps/desktop/electron/engine-launch', () => ({
  resolveNodeBin: mocks.resolveNodeBin,
}))

vi.mock('../../../../apps/desktop/electron/supabase', () => ({
  // #5331 供给链改走 Chromium 连接池;单测里没有 electron,留 undefined ⇒ 退回全局 fetch。
  electronFetch: undefined,
  makeIdentityClient: (accessToken: string) => {
    mocks.identityTokens.push(accessToken)
    return {
      from: () => ({
        select: () => ({
          eq: () => ({ maybeSingle: async () => ({ data: { display_name: 'Agent', special_focus: null }, error: null }) }),
        }),
      }),
    }
  },
}))

import {
  buildAgentIdentityBootstrap,
  buildSocialBridge,
  type AcpEngineRuntimeContext,
  type DesktopGuguMcpHost,
} from '../../../../apps/desktop/electron/acp-engine-utils'

function fixedContext(owner: string): AcpEngineRuntimeContext & { authProvider: RuntimeAuthProvider } {
  return {
    authProvider: {
      getAuth: vi.fn(async () => ({
        accessToken: `${owner}_TOKEN`,
        refreshToken: `${owner}_REFRESH`,
        userId: owner.toLowerCase(),
      })),
    },
    env: { GUGU_HOME: `/tmp/${owner.toLowerCase()}-home` },
  }
}

const recordingMcpHost = {
  start: async () => undefined,
  grant: (_key: string, context: GuguMcpContext) => {
    mocks.mcpContexts.push(context)
    return { url: 'http://127.0.0.1:44100/mcp', capability: 'surface-capability' }
  },
} as unknown as DesktopGuguMcpHost

async function lastMcpToken(): Promise<string | undefined> {
  const context = mocks.mcpContexts.at(-1)
  return context?.kind === 'social' ? context.getAccessToken() : undefined
}

const deepConsumers = [
  {
    name: 'agent identity bootstrap',
    run: async (context: AcpEngineRuntimeContext) => {
      await buildAgentIdentityBootstrap(context, 'agent-b')
      return mocks.identityTokens.at(-1)
    },
  },
  {
    name: 'new MCP bridge',
    run: async (context: AcpEngineRuntimeContext) => {
      await buildSocialBridge(context, 'agent-b', null, {
        host: recordingMcpHost,
        grantKey: 'native:b',
      })
      return lastMcpToken()
    },
  },
] as const

beforeEach(() => {
  vi.clearAllMocks()
  mocks.identityTokens.length = 0
  mocks.mcpContexts.length = 0
})

describe('host-scoped task runtime credentials (#1755 slice 1)', () => {
  it('A/B interleaving keeps engine, identity, and MCP on their own provider', async () => {
    const A = fixedContext('A')
    const B = fixedContext('B')

    await buildAgentIdentityBootstrap(A, 'agent-a')
    await buildAgentIdentityBootstrap(B, 'agent-b')
    await buildSocialBridge(A, 'agent-a', null, { host: recordingMcpHost, grantKey: 'native:a' })
    await buildSocialBridge(B, 'agent-b', null, { host: recordingMcpHost, grantKey: 'native:b' })

    expect(mocks.identityTokens).toEqual(['A_TOKEN', 'B_TOKEN'])
    await expect(Promise.all(mocks.mcpContexts.map((context) => {
      if (context.kind !== 'social') throw new Error('expected social MCP context')
      return context.getAccessToken()
    })))
      .resolves.toEqual(['A_TOKEN', 'B_TOKEN'])
    expect(mocks.mcpContexts.map((context) => context.kind === 'social' ? context.guguHome : null))
      .toEqual(['/tmp/a-home', '/tmp/b-home'])
    expect(mocks.invokeRendererAuth).not.toHaveBeenCalled()
  })

  it.each(deepConsumers)('$name observes B1 -> B2 on its next operation without affecting A', async ({ run }) => {
    const A = fixedContext('A')
    let token = 'B1_TOKEN'
    const B: AcpEngineRuntimeContext = {
      authProvider: {
        getAuth: vi.fn(async () => ({ accessToken: token, refreshToken: null, userId: 'b' })),
      },
      env: { GUGU_HOME: '/tmp/b-home' },
    }

    expect(await run(B)).toBe('B1_TOKEN')
    expect(await run(A)).toBe('A_TOKEN')
    token = 'B2_TOKEN'
    expect(await run(B)).toBe('B2_TOKEN')

    expect(mocks.invokeRendererAuth).not.toHaveBeenCalled()
  })

  const authFailures = [
    {
      name: 'null auth',
      makeProvider: () => ({ getAuth: vi.fn(async () => null) }),
      message: 'requires authenticated Supabase runtime auth',
    },
    {
      name: 'transient provider failure',
      makeProvider: () => ({ getAuth: vi.fn(async () => { throw new Error('B transient auth failure') }) }),
      message: 'B transient auth failure',
    },
    {
      name: 'expired auth',
      makeProvider: () => ({ getAuth: vi.fn(async () => { throw new RuntimeAuthExpiredError('B expired') }) }),
      message: 'B expired',
    },
  ]

  it.each(deepConsumers.flatMap((consumer) => authFailures.map((failure) => ({ consumer, failure }))))(
    '$consumer.name fails before downstream construction on $failure.name',
    async ({ consumer, failure }) => {
      const provider = failure.makeProvider()
      const context: AcpEngineRuntimeContext = { authProvider: provider, env: { GUGU_HOME: '/tmp/b-home' } }

      await expect(consumer.run(context)).rejects.toThrow(failure.message)
      expect(provider.getAuth).toHaveBeenCalledTimes(1)
      expect(mocks.identityTokens).toEqual([])
      expect(mocks.resolveNodeBin).not.toHaveBeenCalled()
      expect(mocks.invokeRendererAuth).not.toHaveBeenCalled()
    },
  )
})
