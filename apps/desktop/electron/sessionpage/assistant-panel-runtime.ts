import { homedir } from 'node:os'
import { randomUUID } from 'node:crypto'
import { watch, type FSWatcher } from 'node:fs'
import { basename, dirname, isAbsolute, relative, sep } from 'node:path'
import { withBoundedOperation } from '@gugu/core/cloud/boundedOperation'
import { createGuguSupabaseClient } from '@gugu/core/cloud/supabase'
import { createAssistantPanelClient, type AssistantPanelChange, type AssistantPanelDomain, type AssistantPanelItem, type AssistantPanelSnapshot } from '@gugu/core/cloud/assistantPanel'
import { readAssistantPanelBody, uploadAssistantPanelBody } from '@gugu/core/cloud/assistantPanelBodies'
import type { AssistantHomeKind } from '@gugu/core/shared/assistantPolicy'
import { assistantHomePaths } from '@gugu/core/shared/assistantPolicy'
import type { assistantPanelLocal } from '../session/main/core/app/assistant-panel-local'
import { applyAssistantPanelService } from './assistant-panel-service'
import { localAgentForSession } from './sessionpage-session-agent'
import { createAssistantPanelApplication, type AssistantPanelHome } from './assistant-panel-application'
import { applyAssistantPanelPending, prepareAssistantPanelAdmission, type PanelPreparedAdmission } from './assistant-panel-admission'
import { prepareAssistantProfileReview } from './assistant-profile-review'
import { assistantResourceChanges } from './assistant-resource-changes'
import { invalidateAssistantIndex, stopAssistantIndexRefresh } from './assistant-index-cache'
import { collectAssistantPanelFiles, publishAssistantPanelCollection, type PanelObservation } from './assistant-panel-publisher'
import { createAssistantPanelBodyFailures } from './assistant-panel-body-failures'
import { isPersonalAssistantAgent } from './assistant-agent-role'
import { anySignal } from '@gugu/core/shared/anySignal'
import type { ConnectionRoute } from '@gugu/core/cloud/connectionRouting'

type Auth = { accessToken: string; userId: string }
type Binding = AssistantPanelHome & { sessionId: string }

/** Account-bound host state. Nothing here starts a device, opens a remote
 * workspace, or changes a native session's history. */
export function createAssistantPanelRuntime(deps: {
  getAuth(): Promise<Auth | null>; instanceId(): string | null; deviceId(): Promise<string>
  local: typeof assistantPanelLocal; guguHome: string; kind: AssistantHomeKind; env: NodeJS.ProcessEnv
  failed(domain: string): void; locale(): string
  connectionAuthority?(): Promise<ConnectionRoute>
}) {
  const hostAuth = () => withBoundedOperation(2000,() => new Error('PANEL_AUTH_TIMEOUT'),() => deps.getAuth())
  const bindings = new Map<string, Binding>()
  const runtimes = new Map<string, ReturnType<typeof runtime>>()
  const roles = new Map<string, boolean>()
  const bodyFailures = new Map<string, ReturnType<typeof createAssistantPanelBodyFailures>>()
  const unavailable = new Set<string>()
  const removed = new Set<string>()
  const removedSessions = new Map<string,string>()
  const removals = new Map<string,number>()
  const recheck = new Set<string>()
  async function available(assistantId: string, ownerId: string, token: string) {
    if (unavailable.has(assistantId)) return false
    if (recheck.has(assistantId)) {
      const client = createGuguSupabaseClient({ schema: 'identity',headers: { Authorization: `Bearer ${token}` } })
      const result = await client.from('active_users').select('id').eq('id',assistantId).eq('owner_user_id',ownerId)
        .abortSignal(AbortSignal.timeout(2000)).maybeSingle()
      if (result.error) throw new Error('PANEL_IDENTITY_UNAVAILABLE')
      if (!result.data || unavailable.has(assistantId)) return false
      recheck.delete(assistantId)
    }
    return !unavailable.has(assistantId)
  }
  function stop(assistantId: string) {
    unavailable.add(assistantId)
    for (const [key,entry] of runtimes) if (entry.assistantId === assistantId) { entry.dispose(); runtimes.delete(key) }
  }
  function remove(assistantId: string) {
    removed.add(assistantId); stop(assistantId); recheck.delete(assistantId)
    for (const [key,binding] of bindings) if (binding.assistantId === assistantId) { removedSessions.set(key,assistantId); bindings.delete(key) }
    for (const key of roles.keys()) if (key.endsWith(`:${assistantId}`)) roles.delete(key)
    for (const key of bodyFailures.keys()) if (JSON.parse(key)[1] === assistantId) bodyFailures.delete(key)
  }
  async function resolve(sessionId: string): Promise<Binding | null> {
    if (removedSessions.has(sessionId)) return null
    const auth = await hostAuth()
    if (!auth) return null
    const known = bindings.get(sessionId)
    if (known?.ownerId === auth.userId) return await available(known.assistantId,auth.userId,auth.accessToken) ? known : null
    const agent = await localAgentForSession(sessionId,deps.env,auth.userId)
    if (!agent?.gugu_user_id) return null
    if (!await available(agent.gugu_user_id,auth.userId,auth.accessToken)) return null
    const key = `${auth.userId}:${agent.gugu_user_id}`
    let assistant = roles.get(key)
    if (assistant === undefined) {
      assistant = await isPersonalAssistantAgent(auth, agent.gugu_user_id)
      if ((await hostAuth())?.userId !== auth.userId) throw new Error('PANEL_ACCOUNT_CHANGED')
      roles.set(key,assistant)
    }
    if (!assistant) return null
    const home = await deps.local.home(sessionId, { assistantId: agent.gugu_user_id, deviceId: await deps.deviceId(), ownerId: auth.userId })
    const binding = { assistantId: agent.gugu_user_id,ownerId: auth.userId,sessionId,cwd: home.cwd,home: homedir(),kind: deps.kind }
    if (unavailable.has(binding.assistantId)) return null
    bindings.set(sessionId,binding)
    return binding
  }
  function runtime(binding: Binding) {
    const failureKey = JSON.stringify([binding.ownerId,binding.assistantId])
    if (!bodyFailures.has(failureKey)) bodyFailures.set(failureKey,createAssistantPanelBodyFailures(deps.guguHome,binding.ownerId,binding.assistantId))
    const failures = bodyFailures.get(failureKey)!
    let chatId: string | undefined
    let tail: Promise<unknown> = Promise.resolve()
    let publication: Promise<void> | null = null
    let pulling: Promise<void> | null = null
    let scheduled: ReturnType<typeof setTimeout> | undefined
    let republish = false, disposed = false, deferredPublication = false
    const lifetime = new AbortController()
    const watchers = new Map<string, FSWatcher>()
    const collectionTimers = new Map<AssistantPanelDomain, ReturnType<typeof setTimeout>>()
    const collections = new Map<AssistantPanelDomain, { promise: Promise<void>; again: boolean }>()
    const serial = <T>(work: () => Promise<T>): Promise<T> => {
      const next = tail.catch(() => undefined).then(work); tail = next; return next
    }
    async function auth(): Promise<Auth> {
      if (disposed) throw new Error('PANEL_RUNTIME_DISPOSED')
      const value = await hostAuth()
      lifetime.signal.throwIfAborted()
      if (!value || value.userId !== binding.ownerId) throw new Error('PANEL_ACCOUNT_CHANGED')
      return value
    }
    const cloud = createAssistantPanelClient((name,args) => withBoundedOperation(2000,() => new Error('PANEL_CLOUD_TIMEOUT'),async signal => {
      const current = await auth()
      const client = createGuguSupabaseClient({ schema: 'identity',headers: { Authorization: `Bearer ${current.accessToken}` } })
      const active = anySignal([signal,lifetime.signal])
      active.throwIfAborted()
      const result = await client.rpc(name,args).abortSignal(active)
      await auth()
      return result
    }),() => binding.ownerId)
    async function access() {
      const current = await auth()
      if (!chatId) {
        const client = createGuguSupabaseClient({ schema: 'chat',headers: { Authorization: `Bearer ${current.accessToken}` } })
        const result = await client.rpc('open_dm',{ p_target_user_id: binding.assistantId }).abortSignal(anySignal([AbortSignal.timeout(2000),lifetime.signal]))
        if (result.error || typeof result.data !== 'string') throw new Error('PANEL_PRIVATE_FOLDER_UNAVAILABLE')
        await auth(); chatId = result.data
      }
      return { signal: lifetime.signal,token: current.accessToken,ownerId: binding.ownerId,chatId,accountId: async () => { await auth(); return binding.ownerId } }
    }
    async function readBody(change: AssistantPanelChange) {
      const item = await cloud.resource(binding.assistantId,change.domain as AssistantPanelDomain,change.resource_key)
      if (!item || item.deleted_at || item.body_item_id !== change.payload.bodyItemId || item.body_sha256 !== change.payload.bodySha256) throw new Error('PANEL_RESOURCE_SUPERSEDED')
      return withBoundedOperation(5000,() => new Error('PANEL_BODY_TIMEOUT'),async () => readAssistantPanelBody(item,await access()))
    }
    const resources = assistantResourceChanges(deps.guguHome, binding.ownerId)
    const application = createAssistantPanelApplication(binding,{
      locale: deps.locale,
      resourceChanged: (operation, notice) => resources.notice(operation, notice),
      assertCurrent: async () => { await auth() },readBody,
      applyService: async change => {
        if (change.domain === 'integrations' && deps.connectionAuthority) {
          const route = await deps.connectionAuthority()
          if (route.mode !== 'legacy' || route.phase !== 'stable' || !route.acceptingNewOperations) throw new Error('CONNECTION_ROUTE_CHANGED')
        }
        return applyAssistantPanelService(change,async () => deps.local.apply(change,change.operation === 'remove' || !change.payload.bodyItemId ? null : await readBody(change),
          (await deps.local.sessions(binding.ownerId)).filter(row => row.agentId === binding.assistantId).map(row => row.summary.conversationId),binding.ownerId),cloud)
      },
      invalidate: () => invalidateAssistantIndex(deps.guguHome,binding.cwd,binding.kind,binding.ownerId),
    })
    async function currentInstance() {
      let instance = deps.instanceId()
      for (const pause of [150,450]) {
        if (instance) break
        await new Promise(resolve => setTimeout(resolve,pause))
        instance = deps.instanceId()
      }
      if (!instance) throw new Error('PANEL_RUNTIME_LEASE_UNAVAILABLE')
      return instance
    }
    async function prepare(text: string) {
      return prepareAssistantPanelAdmission({ assistant: binding.assistantId,instance: await currentInstance(),cloud,application,text,locale: deps.locale() })
    }
    function pullPending(): Promise<void> {
      if (pulling) return pulling
      pulling = serial(async () => {
        await auth()
        const instance = await currentInstance()
        for (let pass = 0; pass < 12; pass++) {
          const result = await applyAssistantPanelPending({ assistant: binding.assistantId,instance,cloud,application,locale: deps.locale() })
          if (!result.settledFailure && !result.superseded) return
        }
        throw new Error('CONCURRENT_CHANGES_RETRY')
      }).finally(() => { pulling = null })
      return pulling
    }
    async function observations(domain: AssistantPanelDomain, previous: AssistantPanelItem[]): Promise<PanelObservation[]> {
      if (['memory','files','skills','personality','voice-notes'].includes(domain)) {
        const rows = await collectAssistantPanelFiles(binding,
          domain as 'memory' | 'files' | 'skills' | 'personality' | 'voice-notes',application.identify,{ requireRoot: previous.length > 0 })
        if (domain !== 'personality') await application.remember(domain,rows.map(row => ({ key: row.key,
          path: String(domain === 'memory' ? row.data.relativePath : domain === 'files' ? row.data.path : domain === 'skills' ? `${row.key}/SKILL.md` : row.key),
        })))
        return rows
      }
      if (domain === 'capabilities' || domain === 'device-notes') return (await deps.local.library(domain === 'capabilities' ? 'capabilities' : 'devices')).map(row => ({
        key: row.id,data: { name: row.name,description: row.description,group: row.group,modifiedAt: row.modifiedAt,contentFormat: 'markdown' },
        bytes: new TextEncoder().encode(row.content),
      }))
      if (domain === 'integrations') return [
        ...deps.local.integrationCatalog().map(row => ({ key: `catalog:${row.id}`,data: { providerId: row.id,configured: false,displayName: row.en.name,catalog: row.en.catalog },
          bytes: new TextEncoder().encode(JSON.stringify({ version: 1,en: row.en,'zh-CN': row.zh })),
        })),
        ...(await deps.local.integrations(binding.ownerId,() => scheduleCollection('integrations'))).map(({ publicMetadata,...row }) => {
          const checkedAt = typeof row.checkedAt === 'number' ? row.checkedAt : Date.parse(String(row.checkedAt ?? ''))
          const { checkResult,checkedAt: _checkedAt,...metadata } = row
          return { key: JSON.stringify([row.providerId,row.accountId]),data: { ...metadata,
            ...(typeof publicMetadata.updatedAt === 'number' && checkedAt >= publicMetadata.updatedAt ? { checkResult,checkedAt: row.checkedAt } : {}) },
            bytes: new TextEncoder().encode(JSON.stringify(publicMetadata)) }
        }),
      ]
      const sessions = await deps.local.sessions(binding.ownerId)
      const own = sessions.filter(row => row.agentId === binding.assistantId).map(row => row.summary.conversationId)
      if (domain === 'schedules') return (await deps.local.schedules(own)).map(row => ({ key: row.id,data: {
        title: row.name,nextRunAt: row.nextRunAt,lastRun: row.lastRun,prompt: row.agentConfig?.prompt ?? '',at: row.triggerConfig?.at ?? null,cron: row.triggerConfig?.expr ?? null,
        tz: row.triggerConfig?.tz ?? null,enabled: row.enabled,
      } }))
      return []
    }
    function observeFiles() {
      if (disposed) return
      for (const watcher of watchers.values()) watcher.close()
      watchers.clear()
      const paths = assistantHomePaths(binding.home,binding.cwd,binding.kind)
      function observe(key: string, path: string, recursive: boolean, accept: (file: string) => boolean, rearm = false) {
        const watcher = watch(path,{ recursive },(_event,file) => {
          if (disposed || watchers.get(key) !== watcher) return
          const name = file ? basename(String(file)) : ''
          if (!accept(name)) return
          if (rearm) observeFiles()
          schedulePublication()
        })
        watchers.set(key,watcher)
        watcher.on('error',() => {
          if (watchers.get(key) === watcher) { watcher.close(); watchers.delete(key) }
          deferredPublication = true; deps.failed('panel')
        })
      }
      for (const target of new Set([paths.memoryDir,paths.resourcesDir,paths.skillsDir,paths.instructions])) {
        try {
          observe(target,target,target !== paths.instructions,name => !name.startsWith('.') && !name.endsWith('.tmp'))
        } catch { /* Its parent observes first creation or replacement. */ }
        let parent = dirname(target), child = basename(target)
        while (parent) {
          const outside = relative(binding.kind === 'cloud' ? binding.home : binding.cwd,parent)
          if (isAbsolute(outside) || outside.split(sep)[0] === '..') break
          const expected = child
          try { observe(`parent:${target}`,parent,false,name => !name || name === expected,true); break }
          catch {
            const next = dirname(parent)
            if (next === parent) break
            child = basename(parent); parent = next
          }
        }
      }
    }
    function schedulePublication() {
      if (disposed) return
      republish = true
      if (publication) return
      clearTimeout(scheduled)
      scheduled = setTimeout(() => {
        if (publication) return // Its finally schedules the outstanding update.
        republish = false
        void publish().catch(() => deps.failed('panel'))
      },250)
      scheduled.unref()
    }
    // Native library tools notify only after their atomic write is durable.
    // Give that domain its own lane: a memory upload or integration check must
    // not hold a newly created capability behind the full inventory sweep.
    function scheduleCollection(domain: AssistantPanelDomain) {
      if (disposed) return
      clearTimeout(collectionTimers.get(domain))
      const timer = setTimeout(() => {
        collectionTimers.delete(domain)
        void publishCollection(domain).catch(() => { if (!disposed) { deferredPublication = true; deps.failed(domain) } })
      },100)
      timer.unref(); collectionTimers.set(domain,timer)
    }
    const stopLibrary = deps.local.onLibraryChanged?.((ownerId,kind) => {
      if (ownerId === binding.ownerId) scheduleCollection(kind === 'capabilities' ? 'capabilities' : 'device-notes')
    })
    const stopIntegrations = deps.local.onIntegrationsChanged?.(() => scheduleCollection('integrations'))
    const stopSchedules = deps.local.onSchedulesChanged?.(() => scheduleCollection('schedules'))
    function publishCollection(domain: AssistantPanelDomain, baseline?: AssistantPanelSnapshot): Promise<void> {
      const active = collections.get(domain)
      if (active) { active.again = true; return active.promise }
      const state = { promise: null as unknown as Promise<void>,again: false }
      state.promise = (async () => {
        do {
          state.again = false
          if (disposed) return
          await auth()
          if (domain === 'integrations' && deps.connectionAuthority) {
            const route = await deps.connectionAuthority()
            if (route.mode !== 'legacy' || route.phase !== 'stable' || !route.acceptingNewOperations) return
          }
          const instanceId = deps.instanceId(),deviceId = await deps.deviceId()
          if (!instanceId) throw new Error('PANEL_RUNTIME_LEASE_UNAVAILABLE')
          await publishAssistantPanelCollection({ assistantId: binding.assistantId,instanceId,deviceId,domain,cloud,
            baseline: baseline ?? await cloud.snapshot(binding.assistantId),
            bodyFailures: failures,
            collect: previous => observations(domain,previous),
            upload: async row => uploadAssistantPanelBody({ ...await access(),label: row.key.split('/').pop() ?? domain,bytes: row.bytes! }),
            discard: async itemId => {
              const current = await auth()
              const client = createGuguSupabaseClient({ schema: 'chat',headers: { Authorization: `Bearer ${current.accessToken}` } })
              const { error } = await client.rpc('workspace_delete_as',{ p_item_id: itemId,p_as_user_id: binding.ownerId })
              if (error) throw new Error('PANEL_UNUSED_BODY_CLEANUP_FAILED')
            },
            revoke: async (item,row) => application.apply({ operation_id: randomUUID(),revision: item.revision,assistant_user_id: binding.assistantId,
              owner_user_id: binding.ownerId,domain,resource_key: row.key,device_id: deviceId,operation: 'remove',payload: { before: row.data },status: 'applied',error_code: null }),
          })
          baseline = undefined // A trailing observation gets its own authority.
        } while (state.again && !disposed)
      })().finally(() => { collections.delete(domain); if (state.again && !disposed) scheduleCollection(domain) })
      collections.set(domain,state)
      return state.promise
    }
    function publish(): Promise<void> {
      if (publication) return publication
      clearTimeout(scheduled); scheduled = undefined; republish = false; deferredPublication = false
      publication = (async () => {
        if ((await hostAuth())?.userId !== binding.ownerId) { dispose(); return }
        await pullPending()
        const baseline = await cloud.snapshot(binding.assistantId)
        for (const domain of ['memory','personality','files','skills','voice-notes','schedules','capabilities','device-notes','integrations'] as const) {
          if (disposed) break
          try {
            await publishCollection(domain,baseline)
          } catch { if (!disposed) { deferredPublication = true; deps.failed(domain) } }
        }
        observeFiles()
      })().catch(error => { if (!disposed) { deferredPublication = true; throw error } })
        .finally(() => { publication = null; if (republish) schedulePublication() })
      return publication
    }
    // The existing host is already running. This timer cannot start or wake it.
    const refresh = setInterval(() => {
      void pullPending().then(() => { if (deferredPublication) schedulePublication() }).catch(() => { if (!disposed) deps.failed('panel') })
    },30_000)
    refresh.unref()
    const reconcile = setInterval(() => { void publish().catch(() => deps.failed('panel')) },600_000)
    reconcile.unref()
    function dispose() {
      if (disposed) return
      disposed = true; republish = false
      lifetime.abort(new Error('PANEL_IDENTITY_REMOVED'))
      clearInterval(refresh); clearInterval(reconcile); clearTimeout(scheduled)
      stopLibrary?.()
      stopIntegrations?.()
      stopSchedules?.()
      for (const timer of collectionTimers.values()) clearTimeout(timer)
      collectionTimers.clear()
      for (const watcher of watchers.values()) watcher.close()
      watchers.clear()
    }
    observeFiles()
    schedulePublication()
    return { assistantId: binding.assistantId,application,dispose,
      prepare: (text: string) => serial(async () => {
        const prepared = await prepareAssistantProfileReview(await prepare(text),
          assistantHomePaths(binding.home,binding.cwd,binding.kind).memoryDir)
        const changes = await resources.prepare().catch(() => {
          deps.failed('resources')
          return { text: '', accepted: async () => {}, rejected: async () => {} }
        })
        return { ...prepared,
          beforeText: [changes.text, prepared.beforeText].filter(Boolean).join('\n\n') || undefined,
          accepted: async () => { await prepared.accepted(); await changes.accepted() },
          rejected: async () => { await changes.rejected(); await prepared.rejected?.() },
        }
      }),
      publish,
    }
  }
  async function current(sessionId: string) {
    const binding = await resolve(sessionId)
    if (!binding) return null
    if (recheck.has(binding.assistantId)) {
      const auth = await hostAuth()
      if (!auth || auth.userId !== binding.ownerId || !await available(binding.assistantId,auth.userId,auth.accessToken)) return null
    }
    if (unavailable.has(binding.assistantId)) return null
    const key = `${binding.ownerId}:${binding.assistantId}:${binding.cwd}`
    let entry = runtimes.get(key)
    if (!entry) { entry = runtime(binding); runtimes.set(key,entry) }
    return entry
  }
  return {
    async bind(input: { sessionId: string; assistantId: string; ownerId: string; cwd: string }) {
      if ((await hostAuth())?.userId !== input.ownerId) throw new Error('PANEL_ACCOUNT_CHANGED')
      if (unavailable.has(input.assistantId)) throw new Error('PANEL_IDENTITY_REMOVED')
      removedSessions.delete(input.sessionId)
      bindings.set(input.sessionId,{ ...input,home: homedir(),kind: deps.kind })
      const entry = await current(input.sessionId)
      if (!entry) throw new Error('PANEL_IDENTITY_REMOVED')
      await entry.application.prepareText('')
      return entry.application.statePath
    },
    async prepare(sessionId: string, text: string): Promise<PanelPreparedAdmission & { assistantPanel?: true }> {
      const entry = await current(sessionId)
      return entry ? { ...await entry.prepare(text),assistantPanel: true as const } : { text,accepted: async () => {} }
    },
    async publish(sessionId: string) { await (await current(sessionId))?.publish() },
    /** Stop before the removal RPC; an uncertain failure must prove liveness before resuming. */
    pauseRemoval(assistantId: string) {
      removals.set(assistantId,(removals.get(assistantId) ?? 0)+1)
      stop(assistantId)
      let settled = false
      return (confirmed: boolean) => {
        if (settled) return
        settled = true
        if (confirmed) remove(assistantId)
        const remaining = (removals.get(assistantId) ?? 1)-1
        if (remaining) removals.set(assistantId,remaining)
        else removals.delete(assistantId)
        if (!remaining && !removed.has(assistantId)) { recheck.add(assistantId); unavailable.delete(assistantId) }
      }
    },
    remove,
    dispose() { for (const entry of runtimes.values()) entry.dispose(); runtimes.clear(); bindings.clear(); roles.clear(); stopAssistantIndexRefresh(deps.guguHome) },
  }
}
