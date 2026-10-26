import { homedir } from 'node:os'
import { randomUUID } from 'node:crypto'
import { watch, type FSWatcher } from 'node:fs'
import { basename, dirname } from 'node:path'
import { withBoundedOperation } from '@gugu/core/cloud/boundedOperation'
import { createGuguSupabaseClient } from '@gugu/core/cloud/supabase'
import { createAssistantPanelClient, type AssistantPanelChange, type AssistantPanelDomain, type AssistantPanelItem } from '@gugu/core/cloud/assistantPanel'
import { readAssistantPanelBody, uploadAssistantPanelBody } from '@gugu/core/cloud/assistantPanelBodies'
import type { AssistantHomeKind } from '@gugu/core/shared/assistantPolicy'
import { assistantHomePaths } from '@gugu/core/shared/assistantPolicy'
import type { assistantPanelLocal } from '../session/main/core/app/assistant-panel-local'
import { applyAssistantPanelService } from './assistant-panel-service'
import { localAgentForSession } from './sessionpage-session-agent'
import { createAssistantPanelApplication, type AssistantPanelHome } from './assistant-panel-application'
import { prepareAssistantPanelAdmission } from './assistant-panel-admission'
import { invalidateAssistantIndex } from './assistant-index-cache'
import { collectAssistantPanelFiles, publishAssistantPanelCollection, type PanelObservation } from './assistant-panel-publisher'

type Auth = { accessToken: string; userId: string }
type Binding = AssistantPanelHome & { sessionId: string }

/** Account-bound host state. Nothing here starts a device, opens a remote
 * workspace, or changes a native session's history. */
export function createAssistantPanelRuntime(deps: {
  getAuth(): Promise<Auth | null>; instanceId(): string | null; deviceId(): Promise<string>
  local: typeof assistantPanelLocal; guguHome: string; kind: AssistantHomeKind; env: NodeJS.ProcessEnv
  failed(domain: string): void; locale(): string
}) {
  const hostAuth = () => withBoundedOperation(2000,() => new Error('PANEL_AUTH_TIMEOUT'),() => deps.getAuth())
  const bindings = new Map<string, Binding>()
  const runtimes = new Map<string, ReturnType<typeof runtime>>()
  const roles = new Map<string, boolean>()
  async function resolve(sessionId: string): Promise<Binding | null> {
    const auth = await hostAuth()
    if (!auth) return null
    const known = bindings.get(sessionId)
    if (known?.ownerId === auth.userId) return known
    const agent = await localAgentForSession(sessionId,deps.env,auth.userId)
    if (!agent?.gugu_user_id) return null
    const key = `${auth.userId}:${agent.gugu_user_id}`
    let assistant = roles.get(key)
    if (assistant === undefined) {
      const client = createGuguSupabaseClient({ schema: 'identity',headers: { Authorization: `Bearer ${auth.accessToken}` } })
      const { data,error } = await client.from('agent_provisions').select('agent_user_id').eq('owner_user_id',auth.userId)
        .eq('agent_user_id',agent.gugu_user_id).eq('member_key','assistant').limit(1).abortSignal(AbortSignal.timeout(2000))
      if (error) throw new Error('PANEL_ROLE_UNAVAILABLE')
      if ((await hostAuth())?.userId !== auth.userId) throw new Error('PANEL_ACCOUNT_CHANGED')
      assistant = Boolean(data?.length)
      roles.set(key,assistant)
    }
    if (!assistant) return null
    const home = await deps.local.home(sessionId)
    const binding = { assistantId: agent.gugu_user_id,ownerId: auth.userId,sessionId,cwd: home.cwd,home: homedir(),kind: deps.kind }
    bindings.set(sessionId,binding)
    return binding
  }
  function runtime(binding: Binding) {
    let chatId: string | undefined
    let tail: Promise<unknown> = Promise.resolve()
    let publication: Promise<void> | null = null
    let scheduled: ReturnType<typeof setTimeout> | undefined
    const watchers = new Map<string, FSWatcher>()
    const serial = <T>(work: () => Promise<T>): Promise<T> => {
      const next = tail.catch(() => undefined).then(work); tail = next; return next
    }
    async function auth(): Promise<Auth> {
      const value = await hostAuth()
      if (!value || value.userId !== binding.ownerId) throw new Error('PANEL_ACCOUNT_CHANGED')
      return value
    }
    const cloud = createAssistantPanelClient((name,args) => withBoundedOperation(2000,() => new Error('PANEL_CLOUD_TIMEOUT'),async signal => {
      const current = await auth()
      const client = createGuguSupabaseClient({ schema: 'identity',headers: { Authorization: `Bearer ${current.accessToken}` } })
      signal.throwIfAborted()
      const result = await client.rpc(name,args).abortSignal(signal)
      await auth()
      return result
    }),() => binding.ownerId)
    async function access() {
      const current = await auth()
      if (!chatId) {
        const client = createGuguSupabaseClient({ schema: 'chat',headers: { Authorization: `Bearer ${current.accessToken}` } })
        const result = await client.rpc('open_dm',{ p_target_user_id: binding.assistantId }).abortSignal(AbortSignal.timeout(2000))
        if (result.error || typeof result.data !== 'string') throw new Error('PANEL_PRIVATE_FOLDER_UNAVAILABLE')
        await auth(); chatId = result.data
      }
      return { token: current.accessToken,ownerId: binding.ownerId,chatId,accountId: async () => (await hostAuth())?.userId ?? null }
    }
    async function readBody(change: AssistantPanelChange) {
      const item = await cloud.resource(binding.assistantId,change.domain as AssistantPanelDomain,change.resource_key)
      if (!item || item.deleted_at || item.body_item_id !== change.payload.bodyItemId || item.body_sha256 !== change.payload.bodySha256) throw new Error('PANEL_RESOURCE_SUPERSEDED')
      return withBoundedOperation(5000,() => new Error('PANEL_BODY_TIMEOUT'),async () => readAssistantPanelBody(item,await access()))
    }
    const application = createAssistantPanelApplication(binding,{
      locale: deps.locale,
      assertCurrent: async () => { await auth() },readBody,
      applyService: async change => applyAssistantPanelService(change,async () => deps.local.apply(change,change.operation === 'remove' || !change.payload.bodyItemId ? null : await readBody(change),
        (await deps.local.sessions(binding.ownerId)).filter(row => row.agentId === binding.assistantId).map(row => row.summary.conversationId),binding.ownerId),cloud),
      invalidate: () => invalidateAssistantIndex(deps.guguHome,binding.cwd,binding.kind,binding.ownerId),
    })
    async function prepare(text: string) {
      let instance = deps.instanceId()
      for (const pause of [150,450]) {
        if (instance) break
        await new Promise(resolve => setTimeout(resolve,pause))
        instance = deps.instanceId()
      }
      if (!instance) throw new Error('PANEL_RUNTIME_LEASE_UNAVAILABLE')
      return prepareAssistantPanelAdmission({ assistant: binding.assistantId,instance,cloud,application,text,locale: deps.locale() })
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
        bytes: new TextEncoder().encode(row.content),contentType: 'text/plain',
      }))
      if (domain === 'integrations') return [
        ...deps.local.integrationCatalog().map(row => ({ key: `catalog:${row.id}`,data: { providerId: row.id,configured: false },
          bytes: new TextEncoder().encode(JSON.stringify({ version: 1,en: row.en,'zh-CN': row.zh })),contentType: 'application/json',
        })),
        ...(await deps.local.integrations(binding.ownerId)).map(({ publicMetadata,...row }) => ({ key: JSON.stringify([row.providerId,row.accountId]),data: row,
          bytes: new TextEncoder().encode(JSON.stringify(publicMetadata)),contentType: 'application/json',
        })),
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
      const paths = assistantHomePaths(binding.home,binding.cwd,binding.kind)
      for (const root of new Set([paths.memoryDir,paths.resourcesDir,paths.skillsDir,dirname(paths.instructions)])) {
        if (watchers.has(root)) continue
        try {
          watchers.set(root,watch(root,{ recursive: root !== dirname(paths.instructions) },(_event,file) => {
            const name = file ? basename(String(file)) : ''
            if (name.startsWith('.') || name.endsWith('.tmp') || root === dirname(paths.instructions) && name !== basename(paths.instructions)) return
            clearTimeout(scheduled)
            scheduled = setTimeout(() => { void publish().catch(() => deps.failed('panel')) },250)
            scheduled.unref()
          }))
          watchers.get(root)!.on('error',() => { watchers.get(root)?.close(); watchers.delete(root); deps.failed('panel') })
        } catch { /* A new collection may not have a directory yet; retry after publication. */ }
      }
    }
    function publish(): Promise<void> {
      if (publication) return publication
      publication = (async () => {
        if ((await hostAuth())?.userId !== binding.ownerId) { dispose(); return }
        await serial(() => prepare(''))
        const instanceId = deps.instanceId()!, deviceId = await deps.deviceId()
        for (const domain of ['memory','personality','files','skills','voice-notes','schedules','capabilities','device-notes','integrations'] as const) {
          try {
            await publishAssistantPanelCollection({ assistantId: binding.assistantId,instanceId,deviceId,domain,cloud,
              collect: previous => observations(domain,previous),
              upload: async row => uploadAssistantPanelBody({ ...await access(),name: `${row.key.split('/').pop() ?? domain}.bin`,bytes: row.bytes!,contentType: row.contentType ?? 'application/octet-stream' }),
              discard: async itemId => {
                const current = await auth()
                const client = createGuguSupabaseClient({ schema: 'chat',headers: { Authorization: `Bearer ${current.accessToken}` } })
                const { error } = await client.rpc('workspace_delete_as',{ p_item_id: itemId,p_as_user_id: binding.ownerId })
                if (error) throw new Error('PANEL_UNUSED_BODY_CLEANUP_FAILED')
              },
              revoke: async (item,row) => application.apply({ operation_id: randomUUID(),revision: item.revision,assistant_user_id: binding.assistantId,
                owner_user_id: binding.ownerId,domain,resource_key: row.key,device_id: deviceId,operation: 'remove',payload: { before: row.data },status: 'applied',error_code: null }),
            })
          } catch { deps.failed(domain) }
        }
        observeFiles()
      })().finally(() => { publication = null })
      return publication
    }
    // The existing host is already running. This timer cannot start or wake it.
    const refresh = setInterval(() => { void publish().catch(() => deps.failed('panel')) },30_000)
    refresh.unref()
    function dispose() {
      clearInterval(refresh); clearTimeout(scheduled)
      for (const watcher of watchers.values()) watcher.close()
      watchers.clear()
    }
    observeFiles()
    return { application,dispose,
      prepare: (text: string) => serial(() => prepare(text)),
      publish,
    }
  }
  async function current(sessionId: string) {
    const binding = await resolve(sessionId)
    if (!binding) return null
    const key = `${binding.ownerId}:${binding.assistantId}:${binding.cwd}`
    let entry = runtimes.get(key)
    if (!entry) { entry = runtime(binding); runtimes.set(key,entry) }
    return entry
  }
  return {
    async bind(input: { sessionId: string; assistantId: string; ownerId: string; cwd: string }) {
      if ((await hostAuth())?.userId !== input.ownerId) throw new Error('PANEL_ACCOUNT_CHANGED')
      bindings.set(input.sessionId,{ ...input,home: homedir(),kind: deps.kind })
      const entry = (await current(input.sessionId))!
      await entry.application.prepareText('')
      return entry.application.statePath
    },
    async prepare(sessionId: string, text: string) {
      const entry = await current(sessionId)
      return entry ? { ...await entry.prepare(text),assistantPanel: true as const } : { text,accepted: async () => {} }
    },
    async publish(sessionId: string) { await (await current(sessionId))?.publish() },
    dispose() { for (const entry of runtimes.values()) entry.dispose(); runtimes.clear(); bindings.clear(); roles.clear() },
  }
}
