import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { appInboxUnreadRow } from '@gugu/core/local/agent/appInbox'
import { readDeliveryEnvelope } from '@gugu/core/local/agent/deliveryEnvelope'
import { AppUnavailableForDeliveryError, handleAgentDeliverDeviceCommand } from '@gugu/core/local/agent/deviceCommandRuntime'
import { createAgent } from '@gugu/core/local/state/agents'

const KEY = '63000000-0000-4000-8000-000000000001'
const ACTOR = '11111111-1111-4111-8111-111111111111'
const row = (seq: number) => ({
  key: KEY, seq, actor_user_id: ACTOR, actor_name: 'Ada', actor_is_agent: false, created_at: '2026-08-29T00:00:00Z',
  ref: `note:${KEY}`, context: 'A note, 2 replies so far', arrival: 'Answer with notes__reply.', content: 'Look at this',
})

describe('an App as an inbox source', () => {
  it('its row is an envelope with its id, ref, context and its own way to answer, the words of the body kept apart', () => {
    const unread = appInboxUnreadRow('notes', row(4))
    expect(unread.app).toMatchObject({ source: 'notes', key: KEY, seq: 4 })
    const text = unread.app!.envelope
    expect(text).toContain('<arrival>Answer with notes__reply.</arrival>')
    const [segment] = readDeliveryEnvelope(text)!.segments
    expect(segment!.body).toBe('Look at this')
    expect(segment!.facts).toMatchObject({ route: 'app', viaApp: 'notes', ref: `note:${KEY}`, from: 'Ada', fromId: `user:${ACTOR}`, messageContext: 'A note, 2 replies so far' })
  })

  it('delivered again it has the same id; another sequence has another', () => {
    expect(appInboxUnreadRow('notes', row(4)).id).toBe(appInboxUnreadRow('notes', row(4)).id)
    expect(appInboxUnreadRow('notes', row(5)).id).not.toBe(appInboxUnreadRow('notes', row(4)).id)
  })

  it('a command naming an App that cannot take it here fails with its own reason, and nothing is read', async () => {
    const home = mkdtempSync(join(tmpdir(), 'app-inbox-'))
    try {
      const env = { ...process.env, GUGU_HOME: home, HOME: home }
      await createAgent({ name: 'A', agent_type: 'claude-code', path: '/p', gugu_user_id: 'agent' }, env)
      const pull = vi.fn(async () => [])
      const failure = await handleAgentDeliverDeviceCommand({ agent_user_id: 'agent', source: 'notes' }, {
        accessToken: 'token',
        runtimeBridge: { injectAgentInbox: vi.fn(), appInbox: { refusal: async () => 'Extension notes is turned off', pull, ack: vi.fn(), recordFailure: vi.fn() } } as never,
      }, env).catch((error: unknown) => error)
      expect(failure).toBeInstanceOf(AppUnavailableForDeliveryError)
      expect(failure).toMatchObject({ reason: 'appUnavailable' })
      expect(pull).not.toHaveBeenCalled()
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  })
})
