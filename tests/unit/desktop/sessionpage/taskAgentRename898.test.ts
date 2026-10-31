import { beforeEach, describe, expect, it, vi } from 'vitest'

const AGENT = '11111111-1111-4111-8111-111111111111'
const state = vi.hoisted(() => ({
  roster: [] as Array<{ name: string; agent_type: 'claude-code'; gugu_user_id: string; cache: Record<string, string> }>,
  rows: [] as Array<{ id: string; display_name: string; name_serial: number | null; gugu_number: null; type: string; owner_user_id: string }>,
  error: null as string | null,
  signedOut: false,
  getAuth: vi.fn(),
  lock: vi.fn(),
  lockTail: Promise.resolve() as Promise<unknown>,
  reconnected: undefined as (() => void) | undefined,
  notify: undefined as (() => Promise<void>) | undefined,
  notified: undefined as Promise<void> | undefined,
  provision: vi.fn(),
  warn: vi.fn(),
  beforeWrite: undefined as (() => Promise<void>) | undefined,
  actualQueue: false,
  syncError: null as { message: string } | null,
}))
vi.mock('@gugu/core', () => ({
  listAgents: async () => state.roster,
  provisionSessionpageAgentOneTrip: (...args: unknown[]) => state.provision(...args),
}))
vi.mock('@gugu/core/local/state/agents', () => ({
  updateAgent: async (selector: { guguUserId: string }, patch: { name: string }) => {
    const index = state.roster.findIndex((agent) => agent.gugu_user_id === selector.guguUserId)
    state.roster[index] = { ...state.roster[index], ...patch }
  },
}))
vi.mock('../../../../apps/desktop/electron/lib/logger', () => ({ createLogger: () => ({ warn: state.warn }) }))
vi.mock('../../../../apps/desktop/src/lib/realtimeChannel', () => ({
  subscribePrivateUserEventBus: (_account: string, _event: string, _listener: unknown, options: { onSubscribed: () => void }) => {
    state.reconnected = options.onSubscribed
    return { id: 'bus' }
  },
  unsubscribePrivateUserEventBus: vi.fn(),
}))
vi.mock('../../../../apps/desktop/src/lib/accountRevisionReconcile', () => ({ watchRevisionReconcile: () => () => {} }))
vi.mock('../../../../apps/desktop/src/lib/supabase', () => ({ dataClient: { schema: () => ({ rpc: () => ({
  abortSignal: async () => state.syncError ? { data: null, error: state.syncError } : { data: { operations: [], has_more: false }, error: null },
}) }) } }))
vi.mock('../../../../apps/desktop/src/platform', () => ({ platform: {
  notifyOwnedAgentsChanged: () => { state.notified = state.notify?.() },
} }))
vi.mock('../../../../apps/desktop/electron/sessionpage/emdash-agent-provisioning', () => ({
  SESSION_CACHE_KEY: 'emdash_session_id',
  awaitSessionpageCloudIdentity: async () => {},
  withSessionpageProvisionLock: (label: string, run: () => Promise<unknown>) => {
    state.lock(label)
    if (state.actualQueue) return actualProvisionLock(label, run)
    const queued = state.lockTail.then(run)
    state.lockTail = queued.catch(() => undefined)
    return queued
  },
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
      maybeSingle: async () => { if (patch) await state.beforeWrite?.(); const out = result(); return { ...out, data: out.data?.[0] ?? null } },
      then: (resolve: (value: ReturnType<typeof result>) => unknown) => resolve(result()),
    }
    return query
  } }),
}))

import { createSessionpageIdentityHost, reconcileSessionpageOwnerNames } from '../../../../apps/desktop/electron/sessionpage/sessionpage-identity-host'
import { createWebSessionShellAnswers } from '../../../../apps/desktop/src/lib/session-shell-web-answers'
import { createSessionShellPort, SESSION_SHELL_CHANNELS } from '../../../../apps/desktop/src/session/shared/lib/ipc/shell-port'
import { desktopIdentityEntries } from '../../../support/desktopIdentityEntries'
import { actualProvisionLock, provisionQueueSourceHash } from '../../../support/actualProvisionQueue'
import { resolveSessionpageSessionPeers } from '../../../../apps/desktop/electron/sessionpage/session-addressing'
import { loadSessionpageCanonicalAgentIdentities } from '../../../../apps/desktop/electron/sessionpage/sessionpage-agent-identity'
import { resolveSessionpageAgentCard } from '../../../../apps/desktop/electron/sessionpage/sessionpage-agent-card'
import { agentNamesFromPeers } from '../../../../apps/desktop/src/session/shared/lib/ipc/shell-port'
import { UI_EVENTS } from '../../../../apps/desktop/src/lib/uiEvents'
import { createSupabaseAccountRevisionSource } from '../../../../apps/desktop/src/lib/supabaseAccountRevisionSource'

function setup(options: { title?: string; managed?: boolean; source?: 'manual' | 'generated' } = {}) {
  let title = options.title ?? 'Claude 1'
  let source = options.source
  let managed = options.managed ?? true
  let identityName: string | undefined = managed ? 'Claude 1' : undefined
  const taskStates = new Map<string, { title: string; source: 'manual' | 'generated'; managed: boolean; identityName?: string; pendingManual: boolean; fallback: boolean }>()
  let renameTask!: (id: string, name: string, source: 'manual' | 'generated') => Promise<boolean | null>
  const notices = vi.fn()
  const mirror = vi.fn((_id: string, name: string, nextSource?: 'manual' | 'generated') => {
    title = name
    identityName = name
    managed = true
    if (nextSource) source = nextSource
  })
  const host = createSessionpageIdentityHost({
    getAuth: async () => { await state.getAuth(); return state.signedOut ? null : { userId: 'owner', accessToken: 'token', refreshToken: '' } },
    resolveDeviceId: async () => 'device',
    resolveProjectName: async () => 'Project',
    sessionFacts: async () => null,
    listSessionFacts: async () => [{ sessionId: 'task', title, projectName: 'Project', status: null, isPinned: false, lastInteractedAt: null }],
    taskNames: { installRename: (rename) => { renameTask = rename }, mirror,
      writeManual: (_id, name) => { title = name; identityName = name; managed = false; source = 'manual' },
      state: (id) => taskStates.get(id) ?? ({ fallback: source === undefined, title, source, managed, identityName, pendingManual: source === 'manual' && !managed }) },
    onRenamed: notices,
  })
  return { host, renameTask: (...args: Parameters<typeof renameTask>) => renameTask(...args), title: () => title, mirror, notices, taskStates }
}

function desktop(app: ReturnType<typeof setup>) {
  const auth = { userId: 'owner', accessToken: 'token', refreshToken: '' }
  const emdash = { emdashSessionpageSessionFacts: async () => [{ sessionId: 'task', title: app.title(), projectName: 'Project', status: null, isPinned: false, lastInteractedAt: null }] }
  const sendUiEvent = vi.fn()
  const entries = desktopIdentityEntries({
    sessionpageIdentityHost: app.host,
    identityHost: app.host,
    authProvider: { getAuth: async () => state.signedOut ? null : auth },
    loadEmdashBridge: () => emdash,
    emdash, auth, record: { action: 'peers' },
    // Keep real legacy resolvers available for the source-route mutation control too.
    resolveSessionpageSessionPeers, loadSessionpageCanonicalAgentIdentities, resolveSessionpageAgentCard, agentNamesFromPeers,
    listAgents: async () => state.roster,
    sendUiEvent, MAIN_UI_EVENTS: { sessionpageShareAgent: 'share', sessionpageShareAgentUnavailable: 'unavailable' },
  })
  return { ...entries, sendUiEvent, port: createSessionShellPort(entries.invoke) }
}

beforeEach(() => {
  state.roster = [{ name: 'Claude 1', agent_type: 'claude-code', gugu_user_id: AGENT, cache: { emdash_session_id: 'task', sessionpage_owner_user_id: 'owner' } }]
  state.rows = [{ id: AGENT, display_name: 'Claude 1', name_serial: 1, gugu_number: null, type: 'agent', owner_user_id: 'owner' }]
  state.error = null
  state.signedOut = false
  state.getAuth.mockReset()
  state.lock.mockClear()
  state.lockTail = Promise.resolve()
  state.actualQueue = false
  state.reconnected = undefined
  state.notify = undefined
  state.notified = undefined
  state.warn.mockClear()
  state.beforeWrite = undefined
  state.syncError = null
  state.provision.mockReset().mockImplementation(async () => { state.rows[0].name_serial = 1; return { displayName: state.rows[0].display_name } })
})

describe('task and identity shared rename operation', () => {
  it('uses the same cloud identity, task mirror, roster and notice from both rename entry points', async () => {
    const app = setup()
    await app.renameTask('task', 'Task menu', 'manual')
    expect([state.rows[0].display_name, state.roster[0].name, app.title()]).toEqual(['Task menu', 'Task menu', 'Task menu'])
    await app.host.renameAgent({ sessionId: 'task', name: 'Agent profile' })
    expect([state.rows[0].display_name, state.roster[0].name, app.title()]).toEqual(['Agent profile', 'Agent profile', 'Agent profile'])
    // Each rename is announced as locally pending, then as published.
    expect(app.notices.mock.calls.map(([notice]) => [notice.agentUserId, notice.pendingManual])).toEqual([
      [AGENT, true], [AGENT, undefined], [AGENT, true], [AGENT, undefined]])
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
    await expect(app.host.renameAgent({ sessionId: 'task', name: 'Saved locally' })).resolves.toMatchObject({ displayName: 'Saved locally' })
    expect(app.title()).toBe('Saved locally')
    expect(app.mirror).not.toHaveBeenCalled()
    expect(app.notices).toHaveBeenCalledExactlyOnceWith({ conversationId: 'task', agentUserId: AGENT, displayName: 'Saved locally', pendingManual: true })
    expect(state.roster[0].name).toBe('Saved locally')
    expect(state.warn).toHaveBeenCalled()
    expect(state.rows[0].display_name).toBe('Claude 1')
    state.error = null
    // Connect the actual identity source's existing onSubscribed -> existing host IPC operation.
    state.notify = () => app.host.synchronizeNames()
    const stop = createSupabaseAccountRevisionSource().subscribeWake('owner', vi.fn(), vi.fn())
    state.reconnected!()
    await state.notified
    stop()
    expect([state.rows[0].display_name, state.roster[0].name, app.title()]).toEqual(['Saved locally', 'Saved locally', 'Saved locally'])
    // Publication is announced so every surface holding the pending name can release it.
    expect(app.notices).toHaveBeenCalledTimes(2)
    expect(app.notices).toHaveBeenLastCalledWith({ conversationId: 'task', agentUserId: AGENT, displayName: 'Saved locally' })
  })

  it('publishes an outage rename when account sync answers again, without the identity bus resubscribing', async () => {
    const app = setup()
    state.error = 'offline'
    state.syncError = { message: 'Failed to fetch' }
    await app.host.renameAgent({ sessionId: 'task', name: 'Renamed offline' })
    state.notify = () => app.host.synchronizeNames()
    const source = createSupabaseAccountRevisionSource()
    const signal = new AbortController().signal
    await expect(source.syncSince('0', 10, signal)).rejects.toMatchObject({ message: 'Failed to fetch' })
    expect(state.notified).toBeUndefined()
    // The network returns: the realtime bus never dropped, but the next account read succeeds.
    state.error = null
    state.syncError = null
    await source.syncSince('0', 10, signal)
    await state.notified
    expect([state.rows[0].display_name, state.roster[0].name, app.title()]).toEqual(['Renamed offline', 'Renamed offline', 'Renamed offline'])
    expect(app.notices).toHaveBeenLastCalledWith({ conversationId: 'task', agentUserId: AGENT, displayName: 'Renamed offline' })
    // A healthy read afterwards does not ask the host again.
    state.notified = undefined
    await source.syncSince('0', 10, signal)
    expect(state.notified).toBeUndefined()
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
    expect(await app.renameTask('task', 'Offline choice', 'manual')).toBe(true)
    expect(app.title()).toBe('Offline choice')
    expect(state.roster[0].name).toBe('Offline choice')
    expect(app.notices).toHaveBeenCalledExactlyOnceWith({ conversationId: 'task', agentUserId: AGENT, displayName: 'Offline choice', pendingManual: true })
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

  it('rejects overlong legacy intent per row and continues migrating the next task', async () => {
    const app = setup({ title: 'x'.repeat(41), source: 'manual', managed: false })
    state.roster.push({ ...state.roster[0], gugu_user_id: 'second', cache: { ...state.roster[0].cache, emdash_session_id: 'task-2' } })
    state.rows.push({ ...state.rows[0], id: 'second' })
    app.taskStates.set('task-2', { title: '  Valid old title  ', source: 'manual', managed: false, pendingManual: true, fallback: false })
    await app.host.synchronizeNames()
    expect(state.rows.map((row) => row.display_name)).toEqual(['Claude 1', 'Valid old title'])
    expect(state.warn).toHaveBeenCalledWith(expect.objectContaining({ sessionId: 'task', error: expect.stringContaining('1–40') }), expect.any(String))
    expect(app.mirror).toHaveBeenCalledWith('task-2', 'Valid old title', 'manual')
  })

  it('continues after an authorized update fails for one legacy row', async () => {
    const app = setup({ title: 'First manual', source: 'manual', managed: false })
    // The canonical read is allowed, but the first row's owner mutation returns no identity.
    state.rows[0].owner_user_id = 'owner'
    state.roster.push({ ...state.roster[0], gugu_user_id: 'second', cache: { ...state.roster[0].cache, emdash_session_id: 'task-2' } })
    state.rows.push({ ...state.rows[0], id: 'second' })
    app.taskStates.set('task-2', { title: 'Second manual', source: 'manual', managed: false, pendingManual: true, fallback: false })
    state.beforeWrite = async () => { state.rows[0].owner_user_id = 'different-owner' }
    await app.host.synchronizeNames()
    expect(state.rows[1].display_name).toBe('Second manual')
    expect(state.warn).toHaveBeenCalledWith(expect.objectContaining({ sessionId: 'task' }), expect.any(String))
  })

  it.each([false, true])('returns and broadcasts the current name when an older cloud write completes while logged in (actual queue: %s)', async (actualQueue) => {
    state.actualQueue = actualQueue
    const app = setup()
    const events = new EventTarget()
    vi.stubGlobal('window', events)
    const published: string[] = []
    events.addEventListener(UI_EVENTS.ownedAgentRenamed, (event) => published.push((event as CustomEvent).detail.displayName))
    const web = createWebSessionShellAnswers(async (channel, ...args) => {
      expect(channel).toBe('sessionpageIdentity.renameAgent')
      return app.host.renameAgent(args[0] as { sessionId: string; name: string })
    })
    const renameAgent = web.renameAgent
    if (!renameAgent) throw new Error('Shared web rename handler is not registered')
    let release!: () => void
    state.getAuth.mockImplementationOnce(() => undefined)
      .mockImplementationOnce(() => new Promise<void>((resolve) => { release = resolve }))
    try {
      const first = renameAgent({ sessionId: 'task', name: 'First choice' })
      await vi.waitFor(() => expect(release).toBeTypeOf('function'))
      const second = renameAgent({ sessionId: 'task', name: 'Newer choice' })
      await vi.waitFor(() => expect(app.title()).toBe('Newer choice'))
      expect(state.signedOut).toBe(false)
      release()
      const [firstResult] = await Promise.all([first, second])
      expect(firstResult).toMatchObject({ displayName: 'Newer choice' })
      expect(app.title()).toBe('Newer choice')
      expect(state.rows[0].display_name).toBe('Newer choice')
      expect(published).toEqual(['Newer choice', 'Newer choice'])
      expect(app.mirror.mock.calls.map(([, name]) => name)).toEqual(['Newer choice'])
    } finally { vi.unstubAllGlobals() }
  })

  it('projects pending local intent through the existing parsed name port, peers and card without writing on reads', async () => {
    const app = setup()
    state.error = 'offline'
    await app.renameTask('task', 'Local choice', 'manual')
    state.error = null // A later successful cloud read still contains the old name.
    state.lock.mockClear()
    const port = createSessionShellPort(async (channel) => {
      expect(channel).toBe(SESSION_SHELL_CHANNELS.agentNames)
      return app.host.agentNames()
    })
    expect(await port.agentNames()).toEqual([{ conversationId: 'task', agentUserId: AGENT, displayName: 'Local choice', pendingManual: true }])
    expect((await app.host.sessionPeers())[0]).toMatchObject({ title: 'Local choice', identity: { users: { display_name: 'Local choice' } } })
    expect(await app.host.agentCard('task')).toMatchObject({ agentUserId: AGENT, displayName: 'Local choice' })
    expect(state.rows[0].display_name).toBe('Claude 1')
    expect(state.lock).not.toHaveBeenCalled()
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


describe('actual desktop identity registrations', () => {
  it('accepts a later explicit profile choice through the same parsed task rename entry after an offline edit', async () => {
    const app = setup()
    state.error = 'offline'
    await app.renameTask('task', 'Earlier task choice', 'manual')
    state.error = null
    expect(await desktop(app).port.renameAgent({ sessionId: 'task', name: 'Later profile choice' })).toMatchObject({ displayName: 'Later profile choice' })
    expect([app.title(), state.roster[0].name, state.rows[0].display_name]).toEqual(['Later profile choice', 'Later profile choice', 'Later profile choice'])
  })

  it.each([false, true])('keeps newer task intent across an older profile confirmation and failed publication (actual queue: %s)', async (actualQueue) => {
    state.actualQueue = actualQueue
    const app = setup()
    const entry = desktop(app)
    state.rows[0].display_name = 'Older profile'
    let release!: () => void
    state.getAuth.mockImplementationOnce(() => new Promise<void>((resolve) => { release = resolve }))
    const older = entry.invoke('owned-agent:rename-local-footprint', { agentUserId: AGENT, name: 'Older profile' })
    await vi.waitFor(() => expect(release).toBeTypeOf('function'))
    const newer = app.renameTask('task', 'Newer task', 'manual')
    await vi.waitFor(() => expect(app.title()).toBe('Newer task'))
    expect(state.roster[0].name).toBe('Newer task')
    expect(state.signedOut).toBe(false)
    state.error = 'offline'
    release()
    expect(await Promise.all([older, newer])).toEqual([true, true])
    expect([app.title(), state.roster[0].name]).toEqual(['Newer task', 'Newer task'])
    expect(app.mirror).not.toHaveBeenCalled()
    state.error = null
    expect((await app.host.agentNames())[0]).toMatchObject({ displayName: 'Newer task', pendingManual: true })
    await app.host.synchronizeNames()
    expect([app.title(), state.roster[0].name, state.rows[0].display_name]).toEqual(['Newer task', 'Newer task', 'Newer task'])
    expect((await app.host.agentNames())[0].pendingManual).toBeUndefined()
    if (actualQueue) console.log('ACTUAL_PROVISION_QUEUE_SOURCE', provisionQueueSourceHash)
  })

  it('publishes a confirmed profile rename through the real local-footprint handler', async () => {
    const app = setup()
    state.rows[0].display_name = 'Profile choice' // The profile cloud mutation already succeeded.
    const entry = desktop(app)
    expect(await entry.invoke('owned-agent:rename-local-footprint', { agentUserId: AGENT, name: 'Profile choice' })).toBe(true)
    expect([app.title(), state.roster[0].name, state.rows[0].display_name]).toEqual(['Profile choice', 'Profile choice', 'Profile choice'])
    expect(app.notices).toHaveBeenCalledExactlyOnceWith({ conversationId: 'task', agentUserId: AGENT, displayName: 'Profile choice' })
  })

  it('keeps an unbound persistent agent footprint without applying the task name limit or emitting task events', async () => {
    const app = setup()
    delete state.roster[0].cache.emdash_session_id
    const name = 'x'.repeat(50)
    state.rows[0].display_name = name
    expect(await desktop(app).invoke('owned-agent:rename-local-footprint', { agentUserId: AGENT, name })).toBe(true)
    expect(state.roster[0].name).toBe(name)
    expect(app.mirror).not.toHaveBeenCalled()
    expect(app.notices).not.toHaveBeenCalled()
  })

  it('projects pending intent through the actual desktop parsed names, card, peer, share and MCP entries', async () => {
    const app = setup()
    state.error = 'offline'
    await app.renameTask('task', 'Local choice', 'manual')
    state.error = null
    const entry = desktop(app)
    expect(await entry.port.agentNames()).toEqual([{ conversationId: 'task', agentUserId: AGENT, displayName: 'Local choice', pendingManual: true }])
    expect(await entry.port.agentCard('task')).toMatchObject({ agentUserId: AGENT, displayName: 'Local choice' })
    for (const peers of [await entry.port.sessionPeers(), await entry.mcpPeers(), await entry.remotePeers()]) {
      expect(peers).toMatchObject([{ title: 'Local choice', identity: { users: { id: AGENT, display_name: 'Local choice' } } }])
    }
    expect(await entry.invoke(SESSION_SHELL_CHANNELS.shareAgent, 'task')).toBe(true)
    expect(entry.sendUiEvent).toHaveBeenLastCalledWith('share', expect.objectContaining({ sessionId: 'task', displayName: 'Local choice' }))
    expect(state.rows[0].display_name).toBe('Claude 1')
  })
})
