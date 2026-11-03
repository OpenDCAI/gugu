import { beforeEach, describe, expect, it, vi } from 'vitest'

const io = vi.hoisted(() => ({ rows: new Map<string, Record<string, unknown>>(), failWrite: false }))
vi.mock('@/lib/supabase', async () => {
  const { versionedSettingsClient } = await import('../../../../support/versionedSettingsTestDouble')
  return { identityDb: versionedSettingsClient(io) }
})
vi.mock('@/lib/realtimeChannel', () => ({ subscribePrivateUserEventBus: vi.fn(), unsubscribePrivateUserEventBus: vi.fn() }))
vi.mock('@/platform', () => ({ platform: { subscribeAppForeground: () => () => {} } }))

const { readChatTopicPins, setChatTopicPin } = await import('@/lib/chatTopicPins')
beforeEach(() => { io.rows.clear(); io.failWrite = false })

describe('topic pins after removing personal App pins', () => {
  it.each(['invalid legacy value', null, [null], { id: 'old-app' }].map((legacy) => ({ legacy })))('ignores obsolete App preferences without migration: $legacy', async ({ legacy }) => {
    const config = { pinnedAppIds: legacy, pinnedTopicIds: ['saved'], workspace: { layout: 'list' } }
    io.rows.set('u/chat:g', { scope: 'chat:g', config, updated_at: '2026-10-29T00:00:00.000Z' })
    expect(await readChatTopicPins('u', 'g')).toEqual(['saved'])
    expect(io.rows.get('u/chat:g')?.config).toEqual(config)
    await setChatTopicPin('u', 'g', 'next', true, ['next'])
    expect(io.rows.get('u/chat:g')?.config).toEqual({ ...config, pinnedTopicIds: ['saved', 'next'] })
  })

  it('still rejects corrupt topic preferences and preserves account isolation', async () => {
    io.rows.set('u/chat:g', { scope: 'chat:g', config: { pinnedTopicIds: 'invalid' }, updated_at: '2026-10-29T00:00:00.000Z' })
    await expect(readChatTopicPins('u', 'g')).rejects.toThrow('Invalid pinned topic')
    expect(await readChatTopicPins('other-user', 'g')).toEqual([])
  })
})
