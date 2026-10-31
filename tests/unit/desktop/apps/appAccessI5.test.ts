// App architecture I5: what the App page says an App is given to is what the runtime lets through. Two halves of that here:
// a chat the person can no longer pick (archived, stopped) gives nothing at runtime either, and every listing and call reads
// one answer (appAccess) — refused first (off, taken back), then given to this agent.
import { describe, expect, it, vi } from 'vitest'

const db = vi.hoisted(() => ({
  rows: [{ chat_id: 'live', user_id: 'owner-1', app_publisher: 'gugu', app_id: 'searcher' },
    { chat_id: 'old', user_id: 'owner-1', app_publisher: 'gugu', app_id: 'board' }],
  members: [{ chat_id: 'live' }, { chat_id: 'old' }],
  chats: [{ id: 'live', status: 'active' }, { id: 'old', status: 'archived' }],
}))
vi.mock('@gugu/core/cloud/supabase', () => ({
  createGuguSupabaseClient: () => ({
    from: (table: string) => {
      const filters: Array<(row: Record<string, unknown>) => boolean> = []
      const source = table === 'app_enablements' ? db.rows : table === 'chat_members' ? db.members : db.chats
      const query = {
        select: () => query,
        eq: (key: string, value: unknown) => (key === 'user_id' && table === 'chat_members' ? query : (filters.push((row) => row[key] === value), query)),
        in: (key: string, values: unknown[]) => (filters.push((row) => values.includes(row[key])), query),
        then: (resolve: (value: unknown) => void) => resolve({ data: source.filter((row) => filters.every((keep) => keep(row as Record<string, unknown>))), error: null }),
      }
      return query
    },
  }),
}))

const { appsGivenTo } = await import('../../../../apps/desktop/src/session/shared/extensions/app-enablements-core')
const { appAccess, setSessionAppScope, forgetSessionAppScope } = await import('../../../../apps/desktop/electron/extension-gateway')

describe('I5 — the runtime gives what the App page can show', () => {
  it('a chat that is archived gives nothing (the picker does not list it, so it cannot be seen or taken back)', async () => {
    expect(await appsGivenTo('t', 'owner-1', 'agent-1')).toEqual(new Set(['gugu/searcher']))
  })

  it('appAccess: refused before given — off or taken back says why; then not given to this agent; else ok', async () => {
    setSessionAppScope('s1', async (id) => id === 'given')
    const programs = (refusal: string | null) => ({ agentToolsRefusal: () => refusal })
    expect(await appAccess(programs('App x is turned off here'), 's1', 'given')).toEqual({ ok: false, state: 'refused', next: 'App x is turned off here' })
    expect(await appAccess(programs(null), 's1', 'other')).toMatchObject({ ok: false, state: 'not_given' })
    expect(await appAccess(programs(null), 's1', 'given')).toEqual({ ok: true })
    forgetSessionAppScope('s1')
  })
})
