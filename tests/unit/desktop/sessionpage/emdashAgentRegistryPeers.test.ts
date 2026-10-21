import { describe, expect, test } from 'vitest'
import type { LocalAgentRecord } from '@gugu/core'
import {
  resolveLocalSessionPeers,
  type EmdashAgentRegistration,
} from '../../../../apps/desktop/electron/sessionpage/emdash-agent-registry'
import {
  resolveSessionpageSenderBinding,
  resolveSessionpageSessionPeers,
} from '../../../../apps/desktop/electron/sessionpage/session-addressing'
import { pluginRegistry } from '@gugu/session-plugins/agents'

const bindings: EmdashAgentRegistration[] = [
  { guguAgentUserId: '11111111-1111-4111-8111-111111111111', sessionId: 'conversation-a' },
  { guguAgentUserId: '22222222-2222-4222-8222-222222222222', sessionId: 'conversation-b' },
]

const identities = [
  { id: bindings[0].guguAgentUserId, gugu_number: 1001, display_name: 'Codex 1' },
  { id: bindings[1].guguAgentUserId, gugu_number: 1002, display_name: 'Claude 1' },
]
const sessionFacts = (sessionId: string, title: string) => ({
  sessionId,
  title,
  projectName: 'gugu',
  status: null,
  isPinned: false,
  lastInteractedAt: null,
})
const titles = bindings.map((binding) => sessionFacts(binding.sessionId, `Title for ${binding.sessionId}`))

describe('local session peer identity resolution', () => {
  test('preserves every binding in registry order and addresses by identity UUID, never conversationId', () => {
    const peers = resolveLocalSessionPeers(bindings, identities, titles)
    expect(peers.map((peer) => peer.identity.users.id)).toEqual(bindings.map((binding) => binding.guguAgentUserId))
    expect(peers.map((peer) => peer.sessionId)).toEqual(['conversation-a', 'conversation-b'])
    // #6546 进程在不在不是 peer 的事实:名录里没有 live/offline 这一格。`status` 是状态写入者的读数(core 词表),
    // 这里的会话都还没有读数 ⇒ null,❌ 由「进程没跑」推出任何词。
    for (const peer of peers) {
      expect(peer.status).toBeNull()
      expect(peer).not.toHaveProperty('live')
      expect(peer).not.toHaveProperty('online')
    }
  })

  test('fails loud when one mapped sender resolves to multiple canonical identities', () => {
    expect(() => resolveLocalSessionPeers(bindings, [...identities, identities[0]], titles)).toThrow(
      /ambiguous identity\.users\.id 11111111-1111-4111-8111-111111111111/,
    )
  })

  test('fails loud when one mapped sender has no canonical identity', () => {
    expect(() => resolveLocalSessionPeers(bindings, [identities[0]], titles)).toThrow(
      /no identity for mapped session.*22222222-2222-4222-8222-222222222222/,
    )
  })

  test('fails loud when a host conversation maps to two canonical identities', () => {
    expect(() => resolveLocalSessionPeers(
      [bindings[0], { ...bindings[1], sessionId: bindings[0].sessionId }],
      identities,
      titles,
    )).toThrow(/ambiguous sessionId conversation-a maps to/)
  })

  test('enumerates every addressable provider/surface cell by its roster identity', () => {
    const cells = pluginRegistry.getAll().flatMap((provider) =>
      (['acp', 'tui'] as const)
        .filter((surface) => provider.capabilities.sessionBundle.sessionpage[surface]?.identity === 'addressable')
        .map((surface) => ({ providerId: provider.metadata.id, surface })),
    )
    expect(cells.length, 'plugin registry must provide at least one addressable taskpage cell').toBeGreaterThan(0)

    for (const [index, cell] of cells.entries()) {
      const agentUserId = `00000000-0000-4000-8000-${String(index + 1).padStart(12, '0')}`
      const sessionId = `${cell.providerId}-${cell.surface}-conversation`
      const binding: EmdashAgentRegistration = { guguAgentUserId: agentUserId, sessionId }
      const identity = { id: agentUserId, gugu_number: null, display_name: `${cell.providerId} ${cell.surface}` }

      const peers = resolveLocalSessionPeers(
        [binding],
        [identity],
        [sessionFacts(sessionId, `${cell.providerId} ${cell.surface} title`)],
      )
      expect(peers, `${cell.providerId}×${cell.surface} must be listed`).toHaveLength(1)
      expect(peers[0]).toMatchObject({ sessionId, identity: { users: { id: agentUserId } } })
    }
  })

  test('takes every provider/surface binding from the roster, whether or not its process is running', async () => {
    const cells = pluginRegistry.getAll().flatMap((provider) =>
      (['acp', 'tui'] as const)
        .filter((surface) => provider.capabilities.sessionBundle.sessionpage[surface]?.identity === 'addressable')
        .map((surface) => ({ providerId: provider.metadata.id, surface })),
    )
    expect(cells.length, 'provider registry addressable cell population').toBeGreaterThan(0)

    for (const [index, cell] of cells.entries()) {
      const agentUserId = `10000000-0000-4000-8000-${String(index + 101).padStart(12, '0')}`
      const sessionId = `binding-${cell.providerId}-${cell.surface}`
      const rosterRecord = {
        name: `${cell.providerId} ${cell.surface}`,
        agent_type: cell.providerId as LocalAgentRecord['agent_type'],
        path: `/tmp/${cell.providerId}-${cell.surface}`,
        gugu_user_id: agentUserId,
        prompt: '',
        created_at: 0,
        cache: {
          emdash_session_id: sessionId,
          sessionpage_owner_user_id: 'owner-5179',
          sessionpage_direct_chat_id: `chat-${index}`,
        },
      } satisfies LocalAgentRecord
      const peers = await resolveSessionpageSessionPeers({
        listRoster: async () => [rosterRecord],
        ownerUserId: 'owner-5179',
        lookupIdentities: async (ids) => ids.map((id) => ({
          id,
          gugu_number: null,
          display_name: rosterRecord.name,
        })),
        listSessionFacts: async () => [sessionFacts(sessionId, `${cell.providerId} ${cell.surface} title`)],
      })
      expect(peers, `${cell.providerId}×${cell.surface} roster binding`).toHaveLength(1)
      expect(peers[0]).toMatchObject({
        sessionId,
        engine: cell.providerId,
        identity: { users: { id: agentUserId } },
      })
      // 进程没跑不是一种状态(#6546):没有读数就是 null。
      expect(peers[0].status).toBeNull()

      const sender = await resolveSessionpageSenderBinding(sessionId, {
        listRoster: async () => [rosterRecord],
        ownerUserId: 'owner-5179',
      })
      expect(sender).toEqual({
        guguAgentUserId: agentUserId,
        sessionId,
        chatId: `chat-${index}`,
      })

    }
  })

  test('sender binding ignores a parked roster row owned by another account', async () => {
    const sessionId = 'codex-tui-foreign-owner'
    const currentOwnerId = 'owner-5179'
    const currentAgentId = '20000000-0000-4000-8000-000000000101'
    const foreignAgentId = '20000000-0000-4000-8000-000000000102'
    const roster = [
      {
        name: 'current owner session',
        agent_type: 'codex' as LocalAgentRecord['agent_type'],
        path: '/tmp/current-owner-session',
        gugu_user_id: currentAgentId,
        prompt: '',
        created_at: 0,
        cache: {
          emdash_session_id: sessionId,
          sessionpage_owner_user_id: currentOwnerId,
          sessionpage_direct_chat_id: 'chat-current-owner',
        },
      },
      {
        name: 'foreign parked session',
        agent_type: 'codex' as LocalAgentRecord['agent_type'],
        path: '/tmp/foreign-parked-session',
        gugu_user_id: foreignAgentId,
        prompt: '',
        created_at: 0,
        cache: {
          emdash_session_id: sessionId,
          sessionpage_owner_user_id: 'owner-elsewhere',
          sessionpage_direct_chat_id: 'chat-foreign-owner',
        },
      },
    ] satisfies LocalAgentRecord[]

    await expect(resolveSessionpageSenderBinding(sessionId, {
      listRoster: async () => roster,
      ownerUserId: currentOwnerId,
    })).resolves.toEqual({
      guguAgentUserId: currentAgentId,
      sessionId,
      chatId: 'chat-current-owner',
    })
  })
})
