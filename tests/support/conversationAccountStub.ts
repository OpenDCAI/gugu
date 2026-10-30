import { createElement, type ReactNode } from 'react'
import { vi } from 'vitest'
import { createChatProjectionStub, chatProjectionModuleStub } from './chatProjectionStub'
import { renderWithAppProviders, type createReactHarness } from './testHarness'
import type { AccountRevisionEvent, AccountRevisionListener } from '../../apps/desktop/src/lib/accountRevisionCoordinator'

type Subscribe = (event: AccountRevisionEvent, listener: AccountRevisionListener) => () => void
const state = vi.hoisted(() => ({ subscribe: null as Subscribe | null }))
const projection = createChatProjectionStub()
vi.mock('../../apps/desktop/src/lib/chatProjection', () => chatProjectionModuleStub(() => projection))
vi.mock('../../apps/desktop/src/lib/accountRevisionCoordinator', async (original) => ({
  ...await original<typeof import('../../apps/desktop/src/lib/accountRevisionCoordinator')>(),
  createAccountRevisionCoordinator: () => ({
    start() {}, stop() {}, whenIdle: async () => {},
    subscribe: (events: AccountRevisionEvent | readonly AccountRevisionEvent[], listener: AccountRevisionListener) => {
      const stops = (typeof events === 'string' ? [events] : events).map((event) => state.subscribe?.(event, listener))
      return () => { for (const stop of stops) stop?.() }
    },
  }),
}))
vi.mock('../../apps/desktop/src/lib/imRepository', async (original) => {
  const actual = await original<typeof import('../../apps/desktop/src/lib/imRepository')>()
  const { createMemoryLocalSyncDb } = await import('../../apps/desktop/src/lib/localSyncDb')
  return { ...actual, openImRepository: (id: string) => actual.openImRepository(id, { adapter: createMemoryLocalSyncDb() }) }
})
vi.mock('../../apps/desktop/src/lib/identityReadAdapter', () => ({ readDisplayIdentities: async () => [] }))
vi.mock('../../apps/desktop/src/lib/supabaseAccountRevisionSource', () => ({ createSupabaseAccountRevisionSource: () => ({}) }))

/** Scoped UI tests run the real account conversation pipeline with in-memory durable IO. */
export async function renderWithConversations(harness: ReturnType<typeof createReactHarness>, children: ReactNode,
  subscribe: Subscribe = () => () => undefined, options: Parameters<typeof renderWithAppProviders>[2] = {}) {
  state.subscribe = subscribe
  projection.reset()
  projection.rows = options.chat?.chats ?? []
  projection.identityRows = Object.values(options.chat?.identitiesById ?? {})
  const { ChatProvider } = await import('../../apps/desktop/src/store/chat')
  return renderWithAppProviders(harness, createElement(ChatProvider, null, children), options)
}
