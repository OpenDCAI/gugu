import { describe, expect, it } from 'vitest'
import { updateUserSettingsConfig } from '@gugu/core/cloud/userSettings'
import { versionedSettingsClient } from '../../../support/versionedSettingsTestDouble'

describe('conditional preference updates across devices', () => {
  it.each([false, true])('preserves simultaneous App/topic edits and unrelated keys (existing row=%s)', async (existing) => {
    const state = { rows: new Map<string, Record<string, unknown>>(), failWrite: false, conflicts: 0 }
    if (existing) state.rows.set('u/chat:g', { scope: 'chat:g', config: { workspace: { show_app_data: true } }, updated_at: '2026-10-29T00:00:00.000Z' })
    const client = versionedSettingsClient(state)
    await Promise.all([
      updateUserSettingsConfig(client, 'u', 'chat:g', (config) => ({ ...config, pinnedAppIds: ['board'] })),
      updateUserSettingsConfig(client, 'u', 'chat:g', (config) => ({ ...config, pinnedTopicIds: ['topic'] })),
    ])
    expect(state.rows.get('u/chat:g')?.config).toEqual({ ...(existing ? { workspace: { show_app_data: true } } : {}), pinnedAppIds: ['board'], pinnedTopicIds: ['topic'] })
    if (existing) expect(state.conflicts).toBe(1)
  })

  it('reapplies concurrent edits to the same pin list instead of losing the first edit', async () => {
    const state = { rows: new Map<string, Record<string, unknown>>(), failWrite: false }
    state.rows.set('u/chat:g', { scope: 'chat:g', config: { pinnedTopicIds: ['not-synced-here'] }, updated_at: '2026-10-29T00:00:00.000Z' })
    const client = versionedSettingsClient(state)
    await Promise.all(['a', 'b'].map((id) => updateUserSettingsConfig(client, 'u', 'chat:g', (config) => ({ ...config, pinnedTopicIds: [...config.pinnedTopicIds as string[], id] }))))
    expect(state.rows.get('u/chat:g')?.config).toEqual({ pinnedTopicIds: ['not-synced-here', 'a', 'b'] })
  })
})
