import { beforeEach, describe, expect, it, vi } from 'vitest'
import { updateUserSettingsConfig } from '@gugu/core/cloud/userSettings'
import { versionedSettingsClient } from '../../../support/versionedSettingsTestDouble'

const io = vi.hoisted(() => ({ rows: new Map<string, Record<string, unknown>>(), failWrite: false }))
vi.mock('@/lib/supabase', async () => {
  const { versionedSettingsClient } = await import('../../../support/versionedSettingsTestDouble')
  return { identityDb: versionedSettingsClient(io) }
})
vi.mock('@/lib/realtimeChannel', () => ({ subscribePrivateUserEventBus: vi.fn(), unsubscribePrivateUserEventBus: vi.fn() }))
vi.mock('@/platform', () => ({ platform: { subscribeAppForeground: () => () => {} } }))

const { readChatPinSettings, setChatPinPreference } = await import('@/lib/chatPinSettings')
const pins = async (userId: string, chatId: string) => (await readChatPinSettings(userId, chatId)).topicIds
const pin = async (userId: string, chatId: string, id: string, pinned: boolean) => (await setChatPinPreference(userId, chatId, id, pinned)).topicIds
beforeEach(() => { io.rows.clear(); io.failWrite = false })

describe('personal topic pin preferences', () => {
  it.each([false, true])('retains both devices edits when topic/workspace writes start together (workspace first=%s)', async (workspaceFirst) => {
    io.rows.set('u/chat:g', { scope: 'chat:g', config: { pinnedTopicIds: ['not-synced-here'], workspace: { layout: 'list' } }, updated_at: '2026-10-29T00:00:00.000Z' })
    const actions = [() => pin('u', 'g', 'live', true), () => updateUserSettingsConfig(versionedSettingsClient(io), 'u', 'chat:g', (config) => ({ ...config, workspace: { ...(config.workspace as Record<string, unknown>), show_app_data: true } }))]
    await Promise.all((workspaceFirst ? actions.toReversed() : actions).map((write) => write()))
    expect(await pins('u', 'g')).toEqual(['not-synced-here', 'live'])
    expect(io.rows.get('u/chat:g')?.config).toEqual({ pinnedTopicIds: ['not-synced-here', 'live'], workspace: { layout: 'list', show_app_data: true } })
  })

  it('keeps account/group isolation and unrelated chat preferences while maintaining pin order', async () => {
    io.rows.set('u/chat:g', { scope: 'chat:g', config: { pinnedAppIds: ['board'], other: true }, updated_at: '2026-10-29T00:00:00.000Z' })
    expect(await pins('u', 'g')).toEqual([])
    await pin('u', 'g', 'second', true)
    await pin('u', 'g', 'first', true)
    await pin('u', 'g', 'second', true)
    expect(await pins('u', 'g')).toEqual(['second', 'first'])
    expect(io.rows.get('u/chat:g')?.config).toEqual({ pinnedAppIds: ['board'], other: true, pinnedTopicIds: ['second', 'first'] })
    expect(await pins('other-user', 'g')).toEqual([])
    expect(await pins('u', 'other-group')).toEqual([])
  })

  it('preserves pins missing from this device while removing the explicitly selected pin', async () => {
    io.rows.set('u/chat:g', { scope: 'chat:g', config: { pinnedTopicIds: ['not-synced-here', 'live'] }, updated_at: '2026-10-29T00:00:00.000Z' })
    expect(await pin('u', 'g', 'live', false)).toEqual(['not-synced-here'])
    expect(await pins('u', 'g')).toEqual(['not-synced-here'])
  })

  it('reports corrupt preferences and rejected writes without acknowledging an unsaved pin', async () => {
    io.rows.set('u/chat:g', { scope: 'chat:g', config: { pinnedTopicIds: 'bad' }, updated_at: '2026-10-29T00:00:00.000Z' })
    await expect(pins('u', 'g')).rejects.toThrow('Invalid pinned topic')
    io.rows.clear(); io.failWrite = true
    await expect(pin('u', 'g', 'live', true)).rejects.toThrow('write refused')
    expect(await pins('u', 'g')).toEqual([])
  })
})
