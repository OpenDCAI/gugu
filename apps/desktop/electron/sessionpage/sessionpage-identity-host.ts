// @@@task-shell-port (#5012) — 「给会话开咕咕账号并绑到会话」这一套,桌面主进程与网页版无头宿主共用的口。
//
// 从前只在 electron/main.ts 里有(它同时握着登录态与本机 roster),网页版宿主里一个字都没有,于是网页版
// 会话没有咕咕身份:分享、@、私聊全没对象。这里把 main.ts 的两条壳口应答(会话名片 / 会话地址)与
// 「会话启动即开账号」抽成一个只依赖注入的模块:登录态、设备 id、项目名、会话事实 都由宿主给,
// 模块本身 ❌ 不碰 BrowserWindow / ipcMain / app,两种宿主都能 import。
//
// ⚠️ 这不是把桌面版 main.ts 那 10 处触发点全搬来 —— 那些还带着 MCP 注入、投递登记、平台令牌,属于
// 「会话能收 IM 消息」那一层。本模块只管「会话有身份」:开账号、绑会话、进项目群、开私聊。
import type { BirthGroup } from '../../src/session/shared/core/sessions/create-session'
import type {
  SessionShellAgentAddress,
  SessionShellAgentAddressInput,
  SessionShellAgentCard,
  SessionShellAgentName,
  SessionShellRenameAgentInput,
  SessionShellPeer,
} from '../../src/session/shared/lib/ipc/shell-port'
import { localAgentForSession } from './sessionpage-session-agent'
import { listAgents, provisionSessionpageAgentOneTrip } from '@gugu/core'
import { updateAgent, type LocalAgentRecord } from '@gugu/core/local/state/agents'
import { normalizeAgentType } from '@gugu/core/agentTypes'
import { getAgentTypeLabel } from '@gugu/core/shared/enums/agentTypeModels'
import { getSupabaseUrl, getSupabaseAnonKey } from '@gugu/core/cloud/config'
import { agentNameSerial } from '../../src/lib/agentDefaultName'
import { updateOwnedAgentIdentity } from '@gugu/core/cloud/ownedAgent'
import { agentMayBelongTo } from '@gugu/core/local/state/agentOwner'
import { taskAgentName } from '@gugu/core/shared/taskAgentName'
import { electronFetch, makeIdentityClient } from '../supabase'
import { createLogger } from '../lib/logger'
import {
  SESSION_CACHE_KEY,
  awaitSessionpageCloudIdentity,
  withSessionpageProvisionLock,
  isSessionpageAddressable,
  openOwnerDirectChatForAgent,
  provisionSessionpageAgentForSession,
  type ProvisionedSessionpageAgent,
  type SessionpageProvisionDeps,
  type SessionpageSessionInfo,
} from './emdash-agent-provisioning'
import { resolveSessionpageAgentCard } from './sessionpage-agent-card'
import { resolveSessionpageSessionPeers } from './session-addressing'
import { agentNamesFromPeers } from '../../src/session/shared/lib/ipc/shell-port'
import type { LocalSessionFacts } from './emdash-agent-registry'
import { loadSessionpageCanonicalAgentIdentities } from './sessionpage-agent-identity'

export type SessionpageIdentityAuthSnapshot = { accessToken: string; refreshToken: string; userId: string }

/** 会话页引擎回答「这条会话是谁、在哪、属于哪个任务」的那一格(embedded-boot.emdashSessionProvisionInput)。 */
export interface SessionpageSessionFacts {
  sessionId: string
  providerId: string
  surface: 'acp' | 'tui'
  cwd: string
  projectId: string
  displayName?: string
}

export interface SessionpageIdentityHostDeps {
  getAuth: () => Promise<SessionpageIdentityAuthSnapshot | null>
  resolveDeviceId: () => Promise<string | null>
  resolveProjectName: (projectId: string) => Promise<string | null>
  /** The chat a conversation's agent was born in (SessionpageProvisionDeps `takeBirthGroup`). */
  takeBirthGroup?: (sessionId: string) => Promise<BirthGroup | null>
  sessionFacts: (target: SessionShellAgentAddressInput) => Promise<SessionpageSessionFacts | null>
  /** 这台机器侧栏上的会话(名册 session_peers 拿它对标题;名字表是那份名册的投影)。 */
  listSessionFacts: () => Promise<readonly LocalSessionFacts[]>
  taskNames?: {
    installRename: (rename: (sessionId: string, name: string, source: 'manual' | 'generated') => Promise<boolean | null>) => void
    mirror: (sessionId: string, name: string, source?: 'manual' | 'generated') => void
    writeManual: (sessionId: string, name: string) => void
    state: (sessionId: string) => { fallback: boolean; title?: string; source?: 'manual' | 'generated' | 'harness'; managed: boolean; identityName?: string; pendingManual: boolean }
  }
  onRenamed?: (renamed: SessionShellAgentName) => void
  env?: NodeJS.ProcessEnv
}

/** 会话启动时引擎交出来的事实(ACP 注入点 / PTY 钩子两处同形的那一小片)。 */
export interface SessionpageSessionStartFacts {
  sessionId: string
  sourceSessionId?: string
  providerId: string
  surface: 'acp' | 'tui'
  cwd: string
  projectId: string
  displayName?: string
  lifecycle?: 'fresh' | 'fork' | 'resume'
}

export interface SessionpageIdentityHost {
  readonly provisionDeps: SessionpageProvisionDeps
  agentCard(sessionId: string): Promise<SessionShellAgentCard | null>
  /** 侧栏身份卡要的那张表:本机名册(session_peers)的投影。 */
  agentNames(): Promise<SessionShellAgentName[]>
  sessionPeers(sessionId?: string): Promise<SessionShellPeer[]>
  /** A durable local manual edit succeeds immediately; the existing identity sync publishes it later if offline. */
  renameAgent(input: SessionShellRenameAgentInput): Promise<SessionShellAgentName>
  adoptAgentName(agentUserId: string, name: string, source?: 'manual' | 'generated'): Promise<SessionShellAgentName | null>
  synchronizeNames(): Promise<void>
  /** 「这条会话的地址是什么」—— 与桌面版 `sessionpage:ensure-agent-address` 同一条逻辑,逐字搬来。 */
  ensureAgentAddress(input: SessionShellAgentAddressInput): Promise<SessionShellAgentAddress>
  /** 会话启动即开账号(幂等,按 conversationId 收敛);运行时分叉 / 不可寻址的引擎返回 null。 */
  provisionSessionStart(facts: SessionpageSessionStartFacts): Promise<ProvisionedSessionpageAgent | null>
}

/** Name synchronization is a boot-owner side chain; it must not delay the existing reap. */
export function reconcileSessionpageOwnerNames(
  host: Pick<SessionpageIdentityHost, 'synchronizeNames'>,
  onFailure: (error: unknown) => void,
  reap: () => void,
): void {
  void host.synchronizeNames().catch(onFailure)
  reap()
}

function requireAddressInput(input: unknown): SessionShellAgentAddressInput {
  const target = input as Partial<SessionShellAgentAddressInput> | null
  if (!target?.projectId || !target.sessionId) {
    throw new Error('Session-page session address requires projectId and sessionId')
  }
  return { projectId: target.projectId, sessionId: target.sessionId }
}

export function createSessionpageIdentityHost(deps: SessionpageIdentityHostDeps): SessionpageIdentityHost {
  const env = deps.env ?? process.env
  const log = createLogger('sessionpage/identity-name')
  const pendingName = (sessionId: string) => {
    const state = deps.taskNames?.state(sessionId)
    return state?.pendingManual ? state.title : undefined
  }
  const peersForAuth = async (auth: SessionpageIdentityAuthSnapshot, sessionId?: string) => {
    const peers = await resolveSessionpageSessionPeers({
      sessionId,
      listRoster: () => listAgents(env, { includeGuests: true }),
      ownerUserId: auth.userId,
      lookupIdentities: (agentUserIds) => loadSessionpageCanonicalAgentIdentities(auth, agentUserIds, Boolean(sessionId)),
      listSessionFacts: deps.listSessionFacts,
    })
    return peers.map((peer) => {
      const name = pendingName(peer.sessionId)
      return name ? { ...peer, identity: { users: { ...peer.identity.users, display_name: name } } } : peer
    })
  }
  const provisionDeps: SessionpageProvisionDeps = {
    getAuth: deps.getAuth,
    resolveDeviceId: deps.resolveDeviceId,
    resolveProjectName: deps.resolveProjectName,
    ...(deps.takeBirthGroup ? { takeBirthGroup: deps.takeBirthGroup } : {}),
    // #5331 铸身份 + 名字去重 + 进群一次往返。
    provisionOneTrip: (input) => provisionSessionpageAgentOneTrip({ ...input, fetchImpl: electronFetch }),
    // #4277 老名册行没记 owner 时问云端一次:identity.users 的 owner_user_id 是既有事实,RLS 下 owner
    // 读得到自己名下的 agent 行。查询出错要抛(❌ 当「不归我」—— 那会把自己的 agent 停放掉)。
    //
    // 这一格住在共用模块而不是各形态的接线里,是因为它**与形态无关**:它只要登录态和 identity client,
    // 两种宿主都有。留在 main.ts 就等于让网页版形态自己再接一遍 —— 而缺席这一格是**静默**的(可选字段,
    // 缺了照样编译、照样跑),后果是网页版退回 #4277 修掉的那个行为:同一台无头宿主上换个账号登录,
    // 别家的名册行被当成「归我」认领。网页版比桌面版更容易撞上它:浏览器那头换账号不需要重启宿主。
    isAgentOwnedByCurrentUser: async (agentUserId: string) => {
      const auth = await deps.getAuth()
      if (!auth) throw new Error('session-page agent ownership probe: owner not authenticated')
      const { data, error } = await makeIdentityClient(auth.accessToken)
        .from('users')
        .select('id')
        .eq('id', agentUserId)
        .eq('owner_user_id', auth.userId)
        .maybeSingle()
      if (error) throw new Error(`session-page agent ownership probe failed for ${agentUserId}: ${error.message}`)
      return Boolean(data)
    },
    env,
  }
  async function publishRecordName(agent: LocalAgentRecord, name: string, notify = false): Promise<SessionShellAgentName | null> {
    const sessionId = agent.cache?.[SESSION_CACHE_KEY]
    if (typeof sessionId !== 'string' || !sessionId) return null
    const renamed = { conversationId: sessionId, agentUserId: agent.gugu_user_id, displayName: name }
    if (notify || agent.name !== name) deps.onRenamed?.(renamed)
    if (agent.name !== name) {
      await updateAgent({ guguUserId: agent.gugu_user_id }, { name }, env)
    }
    return renamed
  }

  async function adoptRecordName(agent: LocalAgentRecord, name: string, source?: 'manual' | 'generated'): Promise<SessionShellAgentName | null> {
    const sessionId = agent.cache?.[SESSION_CACHE_KEY]
    if (typeof sessionId === 'string' && sessionId) deps.taskNames?.mirror(sessionId, name, source)
    return publishRecordName(agent, name)
  }

  async function adoptAgentName(agentUserId: string, name: string, source?: 'manual' | 'generated'): Promise<SessionShellAgentName | null> {
    const auth = await deps.getAuth()
    if (!auth) throw new Error('Session-page agent rename: owner not authenticated')
    const agent = (await listAgents(env, { includeGuests: true }))
      .find((row) => row.gugu_user_id === agentUserId && agentMayBelongTo(row, auth.userId))
    return agent ? adoptRecordName(agent, name, source) : null
  }

  async function renameBoundAgent(sessionId: string, value: string, source: 'manual' | 'generated'): Promise<SessionShellAgentName | false | null> {
    const name = taskAgentName(value, source === 'generated')
    const agent = await localAgentForSession(sessionId, env)
    if (!agent?.gugu_user_id) return null
    const current = () => ({ conversationId: sessionId, agentUserId: agent.gugu_user_id,
      displayName: deps.taskNames?.state(sessionId).title ?? name })
    if (source === 'manual') {
      deps.taskNames?.writeManual(sessionId, name)
      await publishRecordName(agent, name, true).catch((error: unknown) => {
        log.warn({ sessionId, error: String(error) }, 'Local task name saved; roster publication failed')
      })
    }
    try {
      const auth = await deps.getAuth()
      if (!auth || !agentMayBelongTo(agent, auth.userId)) return source === 'manual' ? current() : false
      return await withSessionpageProvisionLock('task identity rename', async () => {
        await awaitSessionpageCloudIdentity(agent.gugu_user_id)
        if (source === 'generated' && !deps.taskNames?.state(sessionId).fallback) return false
        const client = makeIdentityClient(auth.accessToken)
        let write = updateOwnedAgentIdentity(client, agent.gugu_user_id, { display_name: name }, 'id', auth.userId)
        // A remote manual rename received while the automatic name was in flight wins too.
        if (source === 'generated') write = write.eq('display_name', agent.name)
        const { data, error } = await write.maybeSingle()
        if (error) throw new Error(`Session-page agent rename failed for ${agent.gugu_user_id}: ${error.message}`)
        if (!data) {
          if (source === 'generated') return false
          throw new Error(`Session-page agent ${agent.gugu_user_id} is not owned by the current account`)
        }
        if (source === 'generated' && !deps.taskNames?.state(sessionId).fallback) return false
        // A newer local manual choice must survive completion of an older cloud request.
        if (source === 'manual' && deps.taskNames?.state(sessionId).title !== name) return current()
        return adoptAgentName(agent.gugu_user_id, name, source)
      })
    } catch (error) {
      if (source !== 'manual') throw error
      log.warn({ sessionId, error: String(error) }, 'Local task name saved; identity publication deferred until synchronization')
      return current()
    }
  }

  deps.taskNames?.installRename(async (sessionId, name, source) => {
    const renamed = await renameBoundAgent(sessionId, name, source)
    return renamed ? true : renamed
  })

  const host: SessionpageIdentityHost = {
    provisionDeps,
    async agentCard(sessionId) {
      // 名片按当下登录的账号解析(#4277):网页版换账号不重启宿主,不收紧就会把上一个账号的号递给现在这位。
      const auth = await deps.getAuth()
      if (!auth) return null
      return resolveSessionpageAgentCard(
        String(sessionId ?? ''),
        env,
        auth.userId,
        async (agentUserIds) => (await loadSessionpageCanonicalAgentIdentities(auth, agentUserIds))
          .map((identity) => ({ ...identity, display_name: pendingName(sessionId) ?? identity.display_name })),
      )
    },
    async agentNames() {
      // 同上:名字表也按当下登录的账号过一遍,❌ 别把别家账号的 agent 名字画到侧栏上。
      const auth = await deps.getAuth()
      if (!auth) return []
      return agentNamesFromPeers(await peersForAuth(auth)).map((row) => ({ ...row,
        ...(pendingName(row.conversationId) ? { pendingManual: true as const } : {}) }))
    },
    async sessionPeers(sessionId) {
      const auth = await deps.getAuth()
      if (!auth) throw new Error('Session-page peer directory: owner not authenticated')
      return peersForAuth(auth, sessionId)
    },
    async renameAgent(input) {
      const sessionId = input?.sessionId?.trim()
      if (!sessionId) throw new Error('Session-page agent rename requires sessionId')
      const renamed = await renameBoundAgent(sessionId, input.name, 'manual')
      if (!renamed) throw new Error(`Session-page session ${sessionId} has no agent identity to rename`)
      return renamed
    },
    adoptAgentName: (agentUserId, name, source) => withSessionpageProvisionLock('task identity rename', () => adoptAgentName(agentUserId, name, source)),
    async synchronizeNames() {
      if (!deps.taskNames) return
      const auth = await deps.getAuth()
      if (!auth) return
      await withSessionpageProvisionLock('task identity name changes', async () => {
        const roster = (await listAgents(env, { includeGuests: true }))
          .filter((agent) => agentMayBelongTo(agent, auth.userId) && typeof agent.cache?.[SESSION_CACHE_KEY] === 'string')
        const identities = await loadSessionpageCanonicalAgentIdentities(auth, roster.map((agent) => agent.gugu_user_id), false)
        for (const agent of roster) {
          const sessionId = agent.cache![SESSION_CACHE_KEY] as string
          try {
            const state = deps.taskNames!.state(sessionId)
            if (!state.title) continue
            const identity = identities.find((row) => row.id === agent.gugu_user_id)
            if (!identity?.display_name) continue
            // A legacy manual title and an offline manual edit are intent, never a cloud-name fallback.
            const localManual = state.pendingManual
            let name = identity.display_name
            if (localManual) {
              name = taskAgentName(state.title)
              const { data, error } = await updateOwnedAgentIdentity(makeIdentityClient(auth.accessToken), agent.gugu_user_id,
                { display_name: name }, 'id', auth.userId).maybeSingle()
              if (error) throw new Error(error.message)
              if (!data) throw new Error('Task identity name update was not authorized')
            } else if (!state.managed) {
              const agentType = normalizeAgentType(agent.agent_type)
              const label = getAgentTypeLabel(agentType)
              if (identity.name_serial == null && agentNameSerial(name, label) !== null) {
                const deviceId = await deps.resolveDeviceId()
                if (!deviceId) throw new Error('Task name migration requires the host device identity')
                const migrated = await provisionDeps.provisionOneTrip({ supabaseUrl: getSupabaseUrl(), anonKey: getSupabaseAnonKey(),
                  accessToken: auth.accessToken, agentId: identity.id, displayName: name,
                  nameMode: 'serial', nameSerialBase: label, agentType, deviceId })
                name = migrated.displayName
              }
            }
            if (deps.taskNames!.state(sessionId).title !== state.title) continue
            const source = localManual || !state.managed || (state.identityName && state.identityName !== name) ? 'manual' : state.source
            await adoptRecordName(agent, name, source === 'harness' ? 'manual' : source)
          } catch (error) {
            log.warn({ sessionId, agentUserId: agent.gugu_user_id, error: String(error) }, 'Task identity name synchronization failed; continuing with the remaining tasks')
          }
        }
      })
    },
    async ensureAgentAddress(input) {
      const target = requireAddressInput(input)
      const info = await deps.sessionFacts(target)
      if (!info) throw new Error('Session-page session not found')
      // 这个入口回答的是「这个会话的**地址**是什么」—— 只交回 `{chatId, agentUserId}`,一个目的地,
      // 不是一张发送许可证,所以闸判的是**可寻址性**(❌ 再判一遍 transport,#4653 的教训)。
      if (!isSessionpageAddressable(info.providerId, info.surface)) {
        throw new Error(
          `Session-page session ${info.sessionId} declares no addressable identity on ${info.surface}`,
        )
      }
      const provisioned = await provisionSessionpageAgentForSession(info, provisionDeps)
      if (!provisioned) {
        throw new Error(`Session-page router for ${info.sessionId} has no addressable identity`)
      }
      let chatId = provisioned.chatId
      if (!chatId) {
        const auth = await deps.getAuth()
        if (!auth) throw new Error('Session-page agent address: owner not authenticated')
        chatId = await openOwnerDirectChatForAgent(provisioned.guguAgentUserId, auth.accessToken, env)
      }
      return { chatId, agentUserId: provisioned.guguAgentUserId }
    },
    provisionSessionStart(facts) {
      const info: SessionpageSessionInfo = {
        sessionId: facts.sessionId,
        sourceSessionId: facts.sourceSessionId,
        providerId: facts.providerId,
        surface: facts.surface,
        cwd: facts.cwd,
        projectId: facts.projectId,
        // spec agent-provisioning:显式命名过的会话用那个名字开户;缺席才落到「<引擎 label> <序号>」。
        displayName: facts.displayName,
        lifecycle: facts.lifecycle,
      }
      return provisionSessionpageAgentForSession(info, provisionDeps)
    },
  }
  return host
}
