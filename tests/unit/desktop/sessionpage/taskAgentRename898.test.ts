import { beforeEach, describe, expect, it, vi } from 'vitest'

const AGENT = '11111111-1111-4111-8111-111111111111'
const state = vi.hoisted(() => ({
  roster: [] as Array<{ name: string; agent_type: 'claude-code'; gugu_user_id: string; cache: Record<string, string> }>,
  rows: [] as Array<{ id: string; display_name: string; name_serial: number | null; gugu_number: null; type: string; owner_user_id: string }>,
  error: null as string | null,
  provision: vi.fn(),
}))
vi.mock('@gugu/core', () => ({
  listAgents: async () => state.roster,
  provisionSessionpageAgentOneTrip: (...args: unknown[]) => state.provision(...args),
}))
vi.mock('@gugu/core/local/state/agents', () => ({
  updateAgent: async (_selector: unknown, patch: { name: string }) => { state.roster[0] = { ...state.roster[0], ...patch } },
}))
vi.mock('../../../../apps/desktop/electron/sessionpage/emdash-agent-provisioning', () => ({
  SESSION_CACHE_KEY: 'emdash_session_id',
  awaitSessionpageCloudIdentity: async () => {},
  withSessionpageProvisionLock: (_label: string, run: () => Promise<unknown>) => run(),
  isSessionpageAddressable: () => true,
}))
vi.mock('../../../../apps/desktop/electron/supabase', () => ({
  electronFetch: vi.fn(),
  makeIdentityClient: () => ({ from: () => {
    const filters: Array<[string, unknown]> = []
    let patch: { display_name: string } | null = null
    let ids: string[] | undefined
    const result = () => {
      if (state.error) return { data: null, error: { message: state.error } }
      const rows = state.rows.filter((row) => (!ids || ids.includes(row.id)) && filters.every(([key, value]) => row[key as keyof typeof row] === value))
      if (patch) for (const row of rows) Object.assign(row, patch)
      return { data: rows, error: null }
    }
    const query = {
      select: (_columns: string) => query,
      update: (value: { display_name: string }) => { patch = value; return query },
      eq: (key: string, value: unknown) => { filters.push([key, value]); return query },
      in: (_key: string, value: string[]) => { ids = value; return query },
      maybeSingle: async () => { const out = result(); return { ...out, data: out.data?.[0] ?? null } },
      then: (resolve: (value: ReturnType<typeof result>) => unknown) => resolve(result()),
    }
    return query
  } }),
}))

import { createSessionpageIdentityHost } from '../../../../apps/desktop/electron/sessionpage/sessionpage-identity-host'

function setup() {
  let title = 'Claude 1'
  let source: 'manual' | 'generated' | undefined
  let renameTask!: (id: string, name: string, source: 'manual' | 'generated') => Promise<boolean | null>
  const notices = vi.fn()
  const mirror = vi.fn((_id: string, name: string, nextSource?: 'manual' | 'generated') => {
    if (!nextSource && title !== name) source = 'manual'
    title = name
    if (nextSource) source = nextSource
  })
  const host = createSessionpageIdentityHost({
    getAuth: async () => ({ userId: 'owner', accessToken: 'token', refreshToken: '' }),
    resolveDeviceId: async () => 'device',
    resolveProjectName: async () => 'Project',
    sessionFacts: async () => null,
    listSessionFacts: async () => [{ sessionId: 'task', title, projectName: 'Project', status: null, isPinned: false, lastInteractedAt: null }],
    taskNames: { installRename: (rename) => { renameTask = rename }, mirror, state: () => ({ fallback: source === undefined }) },
    onRenamed: notices,
  })
  return { host, renameTask: (...args: Parameters<typeof renameTask>) => renameTask(...args), title: () => title, mirror, notices }
}

beforeEach(() => {
  state.roster = [{ name: 'Claude 1', agent_type: 'claude-code', gugu_user_id: AGENT, cache: { emdash_session_id: 'task', sessionpage_owner_user_id: 'owner' } }]
  state.rows = [{ id: AGENT, display_name: 'Claude 1', name_serial: 1, gugu_number: null, type: 'agent', owner_user_id: 'owner' }]
  state.error = null
  state.provision.mockReset().mockImplementation(async () => { state.rows[0].name_serial = 1; return { displayName: state.rows[0].display_name } })
})

describe('task and identity shared rename operation', () => {
  it('uses the same cloud identity, task mirror, roster and notice from both rename entry points', async () => {
    const app = setup()
    await app.renameTask('task', 'Task menu', 'manual')
    expect([state.rows[0].display_name, state.roster[0].name, app.title()]).toEqual(['Task menu', 'Task menu', 'Task menu'])
    await app.host.renameAgent({ sessionId: 'task', name: 'Agent profile' })
    expect([state.rows[0].display_name, state.roster[0].name, app.title()]).toEqual(['Agent profile', 'Agent profile', 'Agent profile'])
    expect(app.notices.mock.calls.map(([notice]) => notice.agentUserId)).toEqual([AGENT, AGENT])
    expect(state.roster[0].cache.emdash_session_id).toBe('task')
  })

  it('freezes the first accepted automatic name and preserves later manual choices', async () => {
    const app = setup()
    expect(await app.renameTask('task', 'First name', 'generated')).toBe(true)
    expect(await app.renameTask('task', 'Second name', 'generated')).toBe(false)
    await app.host.renameAgent({ sessionId: 'task', name: 'Owner name' })
    expect(await app.renameTask('task', 'Third name', 'generated')).toBe(false)
    expect(app.title()).toBe('Owner name')
    expect(state.rows[0].name_serial).toBe(1)
  })

  it('rejects a stale automatic write and adopts a remote rename when synchronization resumes', async () => {
    const app = setup()
    state.rows[0].display_name = 'Remote choice'
    expect(await app.renameTask('task', 'Automatic name', 'generated')).toBe(false)
    await app.host.synchronizeNames()
    expect([state.roster[0].name, app.title()]).toEqual(['Remote choice', 'Remote choice'])
    expect(await app.renameTask('task', 'Later automatic', 'generated')).toBe(false)
  })

  it('publishes no local success when the canonical cloud write fails', async () => {
    const app = setup()
    state.error = 'offline'
    await expect(app.host.renameAgent({ sessionId: 'task', name: 'Not saved' })).rejects.toThrow('offline')
    expect(app.title()).toBe('Claude 1')
    expect(app.mirror).not.toHaveBeenCalled()
    expect(app.notices).not.toHaveBeenCalled()
  })

  it('attests a legacy bound serial once through the deployed RPC without changing the identity', async () => {
    const app = setup()
    state.rows[0].name_serial = null
    await app.host.synchronizeNames()
    await app.host.synchronizeNames()
    expect(state.provision).toHaveBeenCalledTimes(1)
    expect(state.provision.mock.calls[0][0]).toMatchObject({ agentId: AGENT, nameMode: 'serial', nameSerialBase: 'Claude', displayName: 'Claude 1' })
    expect(state.roster[0].gugu_user_id).toBe(AGENT)
    expect(app.title()).toBe('Claude 1')
  })
})
