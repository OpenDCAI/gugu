import { beforeEach, describe, expect, it, vi } from 'vitest'

const AGENT = '11111111-1111-4111-8111-111111111111'
const state = vi.hoisted(() => ({
  roster: [] as Array<{ name: string; agent_type: 'claude-code'; gugu_user_id: string; cache: Record<string, string> }>,
  rows: [] as Array<{ id: string; display_name: string; name_serial: number | null; gugu_number: null; type: string; owner_user_id: string }>,
  error: null as string | null,
  signedOut: false,
  getAuth: vi.fn(),
  lock: vi.fn(),
  reconnected: undefined as (() => void) | undefined,
  notify: undefined as (() => Promise<void>) | undefined,
  notified: undefined as Promise<void> | undefined,
  provision: vi.fn(),
}))
vi.mock('@gugu/core', () => ({
  listAgents: async () => state.roster,
  provisionSessionpageAgentOneTrip: (...args: unknown[]) => state.provision(...args),
}))
vi.mock('@gugu/core/local/state/agents', () => ({
  updateAgent: async (_selector: unknown, patch: { name: string }) => { state.roster[0] = { ...state.roster[0], ...patch } },
}))
vi.mock('../../../../apps/desktop/src/lib/realtimeChannel', () => ({
  subscribePrivateUserEventBus: (_account: string, _event: string, _listener: unknown, options: { onSubscribed: () => void }) => {
    state.reconnected = options.onSubscribed
    return { id: 'bus' }
  },
  unsubscribePrivateUserEventBus: vi.fn(),
}))
vi.mock('../../../../apps/desktop/src/lib/accountRevisionReconcile', () => ({ watchRevisionReconcile: () => () => {} }))
vi.mock('../../../../apps/desktop/src/lib/supabase', () => ({ dataClient: {} }))
vi.mock('../../../../apps/desktop/src/platform', () => ({ platform: {
  notifyOwnedAgentsChanged: () => { state.notified = state.notify?.() },
} }))
vi.mock('../../../../apps/desktop/electron/sessionpage/emdash-agent-provisioning', () => ({
  SESSION_CACHE_KEY: 'emdash_session_id',
  awaitSessionpageCloudIdentity: async () => {},
  withSessionpageProvisionLock: (label: string, run: () => Promise<unknown>) => { state.lock(label); return run() },
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

import { createSessionpageIdentityHost, reconcileSessionpageOwnerNames } from '../../../../apps/desktop/electron/sessionpage/sessionpage-identity-host'
import { createSupabaseAccountRevisionSource } from '../../../../apps/desktop/src/lib/supabaseAccountRevisionSource'

function setup(options: { title?: string; managed?: boolean; source?: 'manual' | 'generated' } = {}) {
  let title = options.title ?? 'Claude 1'
  let source = options.source
  let managed = options.managed ?? true
  let identityName: string | undefined = managed ? 'Claude 1' : undefined
  let renameTask!: (id: string, name: string, source: 'manual' | 'generated') => Promise<boolean | null>
  const notices = vi.fn()
  const mirror = vi.fn((_id: string, name: string, nextSource?: 'manual' | 'generated') => {
    title = name
    identityName = name
    managed = true
    if (nextSource) source = nextSource
  })
  const host = createSessionpageIdentityHost({
    getAuth: async () => { state.getAuth(); return state.signedOut ? null : { userId: 'owner', accessToken: 'token', refreshToken: '' } },
    resolveDeviceId: async () => 'device',
    resolveProjectName: async () => 'Project',
    sessionFacts: async () => null,
    listSessionFacts: async () => [{ sessionId: 'task', title, projectName: 'Project', status: null, isPinned: false, lastInteractedAt: null }],
    taskNames: { installRename: (rename) => { renameTask = rename }, mirror,
      writeManual: (_id, name) => { title = name; source = 'manual' },
      state: () => ({ fallback: source === undefined, title, source, managed, identityName }) },
    onRenamed: notices,
  })
  return { host, renameTask: (...args: Parameters<typeof renameTask>) => renameTask(...args), title: () => title, mirror, notices }
}

beforeEach(() => {
  state.roster = [{ name: 'Claude 1', agent_type: 'claude-code', gugu_user_id: AGENT, cache: { emdash_session_id: 'task', sessionpage_owner_user_id: 'owner' } }]
  state.rows = [{ id: AGENT, display_name: 'Claude 1', name_serial: 1, gugu_number: null, type: 'agent', owner_user_id: 'owner' }]
  state.error = null
  state.signedOut = false
  state.getAuth.mockClear()
  state.lock.mockClear()
  state.reconnected = undefined
  state.notify = undefined
  state.notified = undefined
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

  it('keeps the local manual name on cloud failure and retries through the existing identity-change event', async () => {
    const app = setup()
    state.error = 'offline'
    await expect(app.host.renameAgent({ sessionId: 'task', name: 'Not saved' })).rejects.toThrow('offline')
    expect(app.title()).toBe('Not saved')
    expect(app.mirror).not.toHaveBeenCalled()
    expect(app.notices).not.toHaveBeenCalled()
    expect(state.rows[0].display_name).toBe('Claude 1')
    state.error = null
    // Connect the actual identity source's existing onSubscribed -> existing host IPC operation.
    state.notify = () => app.host.synchronizeNames()
    const stop = createSupabaseAccountRevisionSource().subscribeWake('owner', vi.fn(), vi.fn())
    state.reconnected!()
    await state.notified
    stop()
    expect([state.rows[0].display_name, state.roster[0].name, app.title()]).toEqual(['Not saved', 'Not saved', 'Not saved'])
    expect(app.notices).toHaveBeenCalledTimes(1)
  })

  it('attests a legacy bound serial once through the deployed RPC without changing the identity', async () => {
    const app = setup({ managed: false })
    state.rows[0].name_serial = null
    await app.host.synchronizeNames()
    await app.host.synchronizeNames()
    expect(state.provision).toHaveBeenCalledTimes(1)
    expect(state.provision.mock.calls[0][0]).toMatchObject({ agentId: AGENT, nameMode: 'serial', nameSerialBase: 'Claude', displayName: 'Claude 1' })
    expect(state.roster[0].gugu_user_id).toBe(AGENT)
    expect(app.title()).toBe('Claude 1')
  })

  it('does not authenticate or take a mutation path for an unbound task', async () => {
    state.roster = []
    state.signedOut = true
    const app = setup()
    expect(await app.renameTask('unbound', 'Local choice', 'manual')).toBeNull()
    expect(state.getAuth).not.toHaveBeenCalled()
    expect(state.lock).not.toHaveBeenCalled()
  })

  it('retains a bound signed-out manual edit without touching the cloud', async () => {
    state.signedOut = true
    const app = setup()
    expect(await app.renameTask('task', 'Offline choice', 'manual')).toBe(false)
    expect(app.title()).toBe('Offline choice')
    expect(state.rows[0].display_name).toBe('Claude 1')
  })

  it('migrates a legacy manual title toward the identity once and leaves reads pure', async () => {
    const app = setup({ title: 'Fix login bug', source: 'manual', managed: false })
    await app.host.agentNames()
    await app.host.sessionPeers()
    expect(state.lock).not.toHaveBeenCalled()
    expect(state.provision).not.toHaveBeenCalled()
    expect(app.mirror).not.toHaveBeenCalled()
    expect(state.rows[0].display_name).toBe('Claude 1')
    await app.host.synchronizeNames()
    await app.host.synchronizeNames()
    expect([state.rows[0].display_name, app.title()]).toEqual(['Fix login bug', 'Fix login bug'])
    expect(app.notices).toHaveBeenCalledTimes(1)
  })

  it('runs the existing reap before a rejected name sync settles and reports that rejection independently', async () => {
    const failure = new Error('offline')
    const report = vi.fn()
    const reap = vi.fn()
    reconcileSessionpageOwnerNames({ synchronizeNames: async () => { throw failure } }, report, reap)
    expect(reap).toHaveBeenCalledTimes(1)
    await Promise.resolve()
    expect(report).toHaveBeenCalledWith(failure)
  })
})
