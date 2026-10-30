import { beforeEach, describe, expect, it, vi } from 'vitest'

const state = vi.hoisted(() => ({ serial: 1 as number | null, assistant: false, linked: false, writes: [] as Record<string, unknown>[] }))
vi.mock('../../../../apps/desktop/src/lib/myAssistant', () => ({ isMyAssistant: () => state.assistant }))
vi.mock('../../../../apps/desktop/src/session/shared/remote-sessions/session-directory', () => ({
  liveDeviceSessions: () => state.linked ? { device: { sessions: [{ agent: { userId: 'agent' } }] } } : {},
}))
vi.mock('../../../../apps/desktop/src/lib/supabase', () => {
  const client = { schema: () => client, from: () => {
    let patch: Record<string, unknown> | undefined
    const query = {
      select: (_columns: string) => query,
      eq: (_key: string, _value: unknown) => query,
      update: (fields: Record<string, unknown>) => { patch = fields; return query },
      single: async () => {
        if (patch) state.writes.push(patch)
        return { data: { id: 'agent', display_name: 'Reviewer', type: 'agent', bio: null, avatar: null, name_serial: state.serial, ...patch }, error: null }
      },
    }
    return query
  } }
  return { dataClient: client, identityDb: client, chatDb: client, getCurrentAuthUserId: async () => 'owner' }
})

import { contactsService } from '../../../../apps/desktop/src/lib/contacts'

beforeEach(() => { state.serial = 1; state.assistant = false; state.linked = false; state.writes = [] })

describe('profile rename keeps the task name contract', () => {
  it('allows 40 graphemes through the shared identity writer and rejects 41 before writing', async () => {
    const name = '👨‍👩‍👧‍👦'.repeat(40)
    const updated = await contactsService.updateOwnedAgentProfile('agent', { display_name: name })
    expect(updated.display_name).toBe(name)
    expect(state.writes).toEqual([{ display_name: name }])
    await expect(contactsService.updateOwnedAgentProfile('agent', { display_name: `${name}x` })).rejects.toThrow('1–40')
    expect(state.writes).toHaveLength(1)
  })

  it('uses an exact existing directory binding for an old renamed task with an unproven serial', async () => {
    state.serial = null
    state.linked = true
    await expect(contactsService.updateOwnedAgentProfile('agent', { display_name: 'x'.repeat(41) })).rejects.toThrow('1–40')
    expect(state.writes).toEqual([])
  })

  it('does not infer an old task binding from a null serial and an absent offline directory', async () => {
    state.serial = null
    await contactsService.updateOwnedAgentProfile('agent', { display_name: 'x'.repeat(41) })
    expect(state.writes).toEqual([{ display_name: 'x'.repeat(41) }])
  })

  it('preserves the positively identified assistant profile contract', async () => {
    state.serial = null
    state.linked = true
    state.assistant = true
    await contactsService.updateOwnedAgentProfile('agent', { display_name: 'y'.repeat(60) })
    expect(state.writes).toEqual([{ display_name: 'y'.repeat(60) }])
  })
})
