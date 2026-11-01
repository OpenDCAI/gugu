import { afterEach, describe, expect, it, vi } from 'vitest'

const warn = vi.hoisted(() => vi.fn())
vi.mock('../../../../lib/logger', () => ({
  createLogger: () => ({ warn }),
}))

import {
  emdashAgentRegistry,
  registerEmdashAgent,
  resolveLocalSessionPeers,
  unregisterEmdashAgent,
} from '../../../../sessionpage/emdash-agent-registry'
import { SessionpageLocalDeliveryRouter } from '../../../../sessionpage/session-injection'

describe('session peer sidebar titles', () => {
  const binding = { guguAgentUserId: '11111111-1111-4111-8111-111111111111', sessionId: 'conversation-1' }
  const identity = {
    id: binding.guguAgentUserId,
    gugu_number: null,
    display_name: 'Contact name',
  }

  const facts = (sessionId: string, title: string, extra: Record<string, unknown> = {}) => ({
    sessionId,
    title,
    projectName: 'gugu',
    status: null,
    isPinned: false,
    lastInteractedAt: null,
    ...extra,
  })

  it('returns the session-page title separately from the contact identity name, with the sidebar facts', () => {
    expect(resolveLocalSessionPeers(
      [binding],
      [identity],
      [facts(binding.sessionId, 'Review delivery routing', {
        status: { status: 'needs_user', detail: 'approval' },
        isPinned: true,
        lastInteractedAt: '2026-09-26T10:00:00.000Z',
      })],
    )).toEqual([{
      identity: { users: identity },
      sessionId: binding.sessionId,
      title: 'Review delivery routing',
      project: 'gugu',
      status: 'needs_user',
      detail: 'approval',
      pinned: true,
      last_active_at: '2026-09-26T10:00:00.000Z',
    }])
  })

  it('does not advertise the implicit task workspace as a project to the assistant', () => {
    const peers = resolveLocalSessionPeers([binding], [identity], [facts(binding.sessionId, 'Question task', {
      projectId: '00000000-0000-4000-8000-000000000001', projectName: '任务工作区',
    })]);
    expect(peers[0]).toMatchObject({ title: 'Question task', project: '' });
    expect(resolveLocalSessionPeers([binding], [identity], [facts(binding.sessionId, 'Real project task', {
      projectId: 'business-project', projectName: '任务工作区',
    })])[0]?.project).toBe('任务工作区');
  });

  it('orders rows most recently active first; never-active rows go last', () => {
    const second = { guguAgentUserId: '22222222-2222-4222-8222-222222222222', sessionId: 'conversation-2' }
    const third = { guguAgentUserId: '33333333-3333-4333-8333-333333333333', sessionId: 'conversation-3' }
    const peers = resolveLocalSessionPeers(
      [binding, second, third],
      [identity, { ...identity, id: second.guguAgentUserId }, { ...identity, id: third.guguAgentUserId }],
      [
        facts(binding.sessionId, 'Never touched'),
        facts(second.sessionId, 'Older', { lastInteractedAt: '2026-09-25T10:00:00.000Z' }),
        facts(third.sessionId, 'Newer', { lastInteractedAt: '2026-09-26T10:00:00.000Z' }),
      ],
    )
    expect(peers.map((peer) => peer.title)).toEqual(['Newer', 'Older', 'Never touched'])
  })

  it('fails when the session-page title is missing or ambiguous', () => {
    expect(() => resolveLocalSessionPeers(
      [binding],
      [identity],
      [],
    )).toThrow(/no sidebar title/)
    expect(() => resolveLocalSessionPeers(
      [binding],
      [identity],
      [
        facts(binding.sessionId, 'First'),
        facts(binding.sessionId, 'Second'),
      ],
    )).toThrow(/ambiguous sessionId/)
  })
})


describe('ACP inbox delivery goes into session-life', () => {
  afterEach(() => { emdashAgentRegistry.setBridge(null); unregisterEmdashAgent('agent-1') })

  const rig = () => {
    const enqueue = vi.fn()
    emdashAgentRegistry.setBridge({ sessionLife: () => ({ enqueue }), emdashSessionSummaries: async () => [] })
    registerEmdashAgent({ guguAgentUserId: 'agent-1', sessionId: 'conv-1' })
    return { enqueue }
  }
  const row = (id: string) => ({ row: { id, chatId: 'chat-1', seq: 1 } }) as never

  it('the reader\'s unit is enqueued with the rows it settles, whatever the session is doing', async () => {
    const { enqueue } = rig()
    const router = new SessionpageLocalDeliveryRouter([emdashAgentRegistry])
    await expect(router.injectForAgent('agent-1', { id: 'm1', text: 'envelope', sources: [row('m1'), row('m2')] })).resolves.toBe('enqueued')
    expect(enqueue).toHaveBeenCalledExactlyOnceWith({ sessionId: 'conv-1', messageId: 'm1', text: 'envelope', kind: 'inbox-batch',
      sources: [{ agentUserId: 'agent-1', ...(row('m1') as object) }, { agentUserId: 'agent-1', ...(row('m2') as object) }] })
  })

  it('nothing injects into an ACP session directly', async () => {
    rig()
    await expect(emdashAgentRegistry.tryInjectSessionMessage('conv-1')).rejects.toThrow(/only through session-life/)
  })
})
