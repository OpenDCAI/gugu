import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { listAgents } from '@gugu/core'
import { atomicWriteText, resolveGuguHome } from '@gugu/core/local/state/paths'
import { agentSessionArchivalRevision, syncAgentSessionArchival, type AgentSessionArchivalOperation } from '@gugu/core/cloud/sessionArchival'
import type { SessionArchivalState } from '@gugu/core/shared/sessionArchival'
import { cacheString, OWNER_CACHE_KEY, SESSION_CACHE_KEY, PARKED_SESSION_CACHE_KEY } from './emdash-agent-provisioning'
import { createLogger } from '../lib/logger'

interface SyncedAgent {
  ownerUserId: string
  archivedAt?: string | null
  /** Closed interval stamps differ from the same interval's earlier open stamp. */
  intervals: Record<string, string | null>
  pending?: AgentSessionArchivalOperation
}
interface SyncStore { version: 1; agents: Record<string, SyncedAgent> }

function changedIntervals(local: SessionArchivalState, synced: SyncedAgent) {
  const changed = local.intervals.filter((interval) => !Object.hasOwn(synced.intervals, interval.id) || synced.intervals[interval.id] !== interval.restoredAt)
  const open = changed.filter((interval) => interval.restoredAt === null)
  if (open.length > 1) throw new Error('Session archival journal has multiple open intervals')
  return [...changed.filter((interval) => interval.restoredAt !== null).slice(0, 256 - open.length), ...open]
}

export interface SessionpageArchivalSyncDeps {
  getAuth: () => Promise<{ userId: string; accessToken: string } | null>
  resolveDeviceId: () => Promise<string | null>
  inventory: () => Promise<{ archival: SessionArchivalState[] }>
  subscribe: (listener: () => void) => () => void
  env?: NodeJS.ProcessEnv
  bindings?: () => Promise<Array<{ agentUserId: string; ownerUserId: string; sessionId: string }>>
  readRevision?: typeof agentSessionArchivalRevision
  synchronize?: typeof syncAgentSessionArchival
}

/**
 * SQLite owns local admission. This durable outbox only synchronizes its facts;
 * archive/restore never await it. A timed-out operation is retried byte-for-byte.
 */
export class SessionpageAgentArchivalSync {
  private readonly path: string
  private store: SyncStore | undefined
  private running: Promise<void> | undefined
  private again = false

  constructor(private readonly deps: SessionpageArchivalSyncDeps) {
    this.path = join(resolveGuguHome(deps.env ?? process.env), 'taskpage-agent-archival-sync.json')
  }

  flush(): Promise<void> {
    this.again = true
    if (this.running) return this.running
    const run = async () => {
      while (this.again) { this.again = false; await this.synchronize() }
    }
    this.running = run().finally(() => { this.running = undefined })
    return this.running
  }

  private async load(): Promise<SyncStore> {
    if (this.store) return this.store
    try {
      const value = JSON.parse(await readFile(this.path, 'utf8')) as SyncStore
      if (value.version !== 1 || !value.agents || typeof value.agents !== 'object' || Array.isArray(value.agents)) {
        throw new Error('Invalid session archival synchronization store')
      }
      for (const state of Object.values(value.agents)) {
        if (typeof state.ownerUserId !== 'string' || !state.intervals || typeof state.intervals !== 'object') {
          throw new Error('Invalid session archival synchronization entry')
        }
      }
      return (this.store = value)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      return (this.store = { version: 1, agents: {} })
    }
  }

  private async persist(): Promise<void> {
    await atomicWriteText(this.path, JSON.stringify(this.store) + '\n')
  }

  private async synchronize(): Promise<void> {
    const auth = await this.deps.getAuth()
    if (!auth) return
    const deviceId = await this.deps.resolveDeviceId()
    if (!deviceId) return
    const store = await this.load()
    const inventory = await this.deps.inventory()
    const states = new Map(inventory.archival.map((state) => [state.sessionId, state]))
    const bindings = this.deps.bindings ? await this.deps.bindings() : (await listAgents(this.deps.env ?? process.env, { includeGuests: true })).map((agent) => ({
      agentUserId: agent.gugu_user_id, ownerUserId: cacheString(agent.cache, OWNER_CACHE_KEY),
      sessionId: cacheString(agent.cache, SESSION_CACHE_KEY) || cacheString(agent.cache, PARKED_SESSION_CACHE_KEY),
    }))
    const failures: unknown[] = []
    for (const binding of bindings) {
      if (binding.ownerUserId !== auth.userId || !binding.agentUserId) continue
      const local = states.get(binding.sessionId)
      if (!local || local.revision === 0 || local.removedIdentity?.userId === binding.agentUserId) continue
      try {
        const previous = store.agents[binding.agentUserId]
        if (previous && previous.ownerUserId !== auth.userId) throw new Error('Session archival synchronization owner changed')
        const state = previous ?? (store.agents[binding.agentUserId] = { ownerUserId: auth.userId, intervals: {} })
        // One open interval plus up to 255 closed intervals per operation keeps
        // arbitrarily long offline histories within the RPC's bounded payload.
        for (;;) {
          if (!state.pending) {
            const intervals = changedIntervals(local, state)
            if (intervals.length === 0 && state.archivedAt === local.archivedAt) break
            const revision = await (this.deps.readRevision ?? agentSessionArchivalRevision)(binding.agentUserId, auth.accessToken)
            state.pending = { operationId: randomUUID(), revision: revision + 1, archivedAt: local.archivedAt, intervals }
            await this.persist()
          }
          const operation = state.pending
          try {
            await (this.deps.synchronize ?? syncAgentSessionArchival)(binding.agentUserId, deviceId, auth.accessToken, operation)
          } catch (error) {
            if ((error as { code?: string }).code === '40001') {
              // Rebase from today's local journal, never from an old pending
              // archive that a later restore has already superseded.
              const latest = (await this.deps.inventory()).archival.find((item) => item.sessionId === binding.sessionId)
              if (!latest) throw new Error('Session disappeared while archival synchronization was pending')
              state.pending = { operationId: randomUUID(), archivedAt: latest.archivedAt, intervals: changedIntervals(latest, state),
                revision: 1 + await (this.deps.readRevision ?? agentSessionArchivalRevision)(binding.agentUserId, auth.accessToken) }
              await this.persist()
            }
            throw error
          }
          for (const interval of operation.intervals) state.intervals[interval.id] = interval.restoredAt
          state.archivedAt = operation.archivedAt
          delete state.pending
          await this.persist()
          // Re-read on a coalesced pass: archive/restore may have changed while
          // this operation was in flight. Never overwrite that newer journal.
        }
      } catch (error) { failures.push(error) }
    }
    if (failures.length) throw new AggregateError(failures, 'Session archival synchronization is pending; local refusal remains active')
  }
}

export function startSessionpageAgentArchivalSync(deps: SessionpageArchivalSyncDeps): () => void {
  const sync = new SessionpageAgentArchivalSync(deps)
  const log = createLogger('sessionpage/archival')
  const kick = () => { void sync.flush().catch((error: unknown) => log.warn({ err: error }, 'archive state synchronization will retry; local archive has already completed')) }
  const off = deps.subscribe(kick)
  const timer = setInterval(kick, 15_000)
  timer.unref()
  kick()
  return () => { clearInterval(timer); off() }
}
