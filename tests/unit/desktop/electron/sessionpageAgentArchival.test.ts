import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { SessionArchivalState } from '@gugu/core/shared/sessionArchival'
import type { AgentSessionArchivalOperation } from '@gugu/core/cloud/sessionArchival'

vi.mock('../../../../apps/desktop/electron/sessionpage/emdash-agent-provisioning', () => ({
  OWNER_CACHE_KEY: 'owner', SESSION_CACHE_KEY: 'session', PARKED_SESSION_CACHE_KEY: 'parked',
  cacheString: () => '',
}))
import { SessionpageAgentArchivalSync, type SessionpageArchivalSyncDeps } from '../../../../apps/desktop/electron/sessionpage/sessionpage-agent-archival'
import { SessionpageLocalDeliveryRouter } from '../../../../apps/desktop/electron/sessionpage/session-injection'

let home: string
let local: SessionArchivalState
let remoteRevision: number
let sent: AgentSessionArchivalOperation[]
let deps: SessionpageArchivalSyncDeps
beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'gugu-archival-sync-'))
  local = { sessionId: 's', archivedAt: '2026-10-28T09:00:00Z', revision: 1,
    intervals: [{ id: 'interval', archivedAt: '2026-10-28T09:00:00Z', restoredAt: null }] }
  remoteRevision = 0; sent = []
  deps = { env: { GUGU_HOME: home }, getAuth: async () => ({ userId: 'owner', accessToken: 'fixture' }),
    resolveDeviceId: async () => 'device', inventory: async () => ({ archival: [local] }), subscribe: () => () => {},
    bindings: async () => [{ ownerUserId: 'owner', agentUserId: 'agent', sessionId: 's' }],
    readRevision: vi.fn(async () => remoteRevision), synchronize: vi.fn(async (_id, _device, _token, operation) => {
      sent.push(structuredClone(operation)); remoteRevision = operation.revision
    }) }
})
afterEach(async () => { await rm(home, { recursive: true, force: true }) })

const stored = async () => JSON.parse(await readFile(join(home, 'taskpage-agent-archival-sync.json'), 'utf8'))
const restore = () => { local = { ...local, revision: 2, archivedAt: null,
  intervals: local.intervals.map((interval) => ({ ...interval, restoredAt: '2026-10-28T09:01:00Z' })) } }

describe('durable background session archival synchronization', () => {
  it('refuses direct delivery and every automatic wake while archived', async () => {
    const wake = vi.fn(async () => {})
    const router = new SessionpageLocalDeliveryRouter([], { archivalState: () => local, wakeSession: wake })
    await expect(router.tryInjectOrWake('s', { id: 'message', text: 'Do not execute' })).rejects.toMatchObject({ code: 'SESSION_ARCHIVED' })
    await expect(router.wakeSession('s')).rejects.toMatchObject({ code: 'SESSION_ARCHIVED' })
    expect(wake).not.toHaveBeenCalled()
    expect(local.archivedAt).not.toBeNull()
  })
  it('persists the exact operation before sending and retries it after restart', async () => {
    const uncertain: AgentSessionArchivalOperation[] = []
    deps.synchronize = vi.fn(async (_id, _device, _token, operation) => {
      expect((await stored()).agents.agent.pending).toEqual(operation)
      uncertain.push(structuredClone(operation)); throw new Error('network unavailable')
    })
    await expect(new SessionpageAgentArchivalSync(deps).flush()).rejects.toThrow('pending')
    const pending = (await stored()).agents.agent.pending
    deps.synchronize = vi.fn(async (_id, _device, _token, operation) => { sent.push(operation); remoteRevision = operation.revision })
    await new SessionpageAgentArchivalSync(deps).flush()
    expect(sent).toEqual([pending]); expect(uncertain).toEqual([pending])
    expect((await stored()).agents.agent.pending).toBeUndefined()
    expect(deps.readRevision).toHaveBeenCalledTimes(1)
  })

  it('keeps a closed offline interval when archive has never reached the server', async () => {
    restore()
    await new SessionpageAgentArchivalSync(deps).flush()
    expect(sent).toHaveLength(1)
    expect(sent[0]).toMatchObject({ archivedAt: null, intervals: [{ archivedAt: '2026-10-28T09:00:00Z', restoredAt: '2026-10-28T09:01:00Z' }] })
  })

  it('does not let an in-flight archive overwrite the later restore', async () => {
    let release!: () => void
    const gate = new Promise<void>((resolve) => { release = resolve })
    let began!: () => void
    const started = new Promise<void>((resolve) => { began = resolve })
    deps.synchronize = vi.fn(async (_id, _device, _token, operation) => {
      sent.push(structuredClone(operation)); if (sent.length === 1) { began(); await gate }
      remoteRevision = operation.revision
    })
    const sync = new SessionpageAgentArchivalSync(deps)
    const first = sync.flush(); await started
    restore(); const second = sync.flush(); release()
    await Promise.all([first, second])
    expect(sent.map((operation) => operation.archivedAt)).toEqual(['2026-10-28T09:00:00Z', null])
    expect(sent[1].revision).toBeGreaterThan(sent[0].revision)
    expect(sent[1].intervals[0].id).toBe(sent[0].intervals[0].id)
    expect((await stored()).agents.agent.archivedAt).toBeNull()
  })

  it('uploads long offline histories in bounded batches without losing intervals', async () => {
    restore()
    local.intervals = Array.from({ length: 600 }, (_, i) => ({ ...local.intervals[0], id: `interval-${i}` }))
    await new SessionpageAgentArchivalSync(deps).flush()
    expect(sent.map((operation) => operation.intervals.length)).toEqual([256, 256, 88])
    expect(new Set(sent.flatMap((operation) => operation.intervals.map((interval) => interval.id))).size).toBe(600)
    const again = new SessionpageAgentArchivalSync(deps); await again.flush(); expect(sent).toHaveLength(3)
  })

  it('rebases a stale operation without changing or dropping its archive interval', async () => {
    deps.synchronize = vi.fn(async () => { restore(); remoteRevision = 20; throw Object.assign(new Error('stale'), { code: '40001' }) })
    await expect(new SessionpageAgentArchivalSync(deps).flush()).rejects.toThrow('pending')
    const pending = (await stored()).agents.agent.pending
    expect(pending.revision).toBe(21)
    expect(pending.archivedAt).toBeNull()
    expect(pending.intervals).toEqual(local.intervals)
    deps.synchronize = vi.fn(async (_id, _device, _token, operation) => { sent.push(operation) })
    await new SessionpageAgentArchivalSync(deps).flush()
    expect(sent).toEqual([pending])
  })

  it('stops resending an operation the cloud refused for this device, and resumes it from another device id', async () => {
    deps.synchronize = vi.fn(async () => { throw Object.assign(new Error('Agent archival device does not match its owner'), { code: '42501' }) })
    const sync = new SessionpageAgentArchivalSync(deps)
    await expect(sync.flush()).rejects.toThrow('pending')
    await sync.flush(); await new SessionpageAgentArchivalSync(deps).flush()
    expect(deps.synchronize).toHaveBeenCalledTimes(1)
    const pending = (await stored()).agents.agent.pending
    deps.resolveDeviceId = async () => 'bound-device'
    deps.synchronize = vi.fn(async (_id, device, _token, operation) => { expect(device).toBe('bound-device'); sent.push(operation) })
    await new SessionpageAgentArchivalSync(deps).flush()
    expect(sent).toEqual([pending])
  })

  it('does not change parked identities belonging to another account or mint a new identity', async () => {
    deps.bindings = async () => [{ ownerUserId: 'other', agentUserId: 'parked', sessionId: 's' }]
    await new SessionpageAgentArchivalSync(deps).flush()
    expect(deps.synchronize).not.toHaveBeenCalled(); expect(deps.readRevision).not.toHaveBeenCalled()
  })
})
