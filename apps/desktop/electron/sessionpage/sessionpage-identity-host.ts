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
  SessionShellPeer,
} from '../../src/session/shared/lib/ipc/shell-port'
import { localAgentForSession } from './sessionpage-session-agent'
import { listAgents, provisionSessionpageAgentOneTrip, writeAgentName } from '@gugu/core'
import { agentsForOwner } from '@gugu/core/local/state/agentOwner'
import { createLogger } from '../lib/logger'

const log = createLogger('sessionpage/task-names')
import { electronFetch, makeIdentityClient } from '../supabase'
import {
  SESSION_CACHE_KEY,
  isSessionpageAddressable,
  openOwnerDirectChatForAgent,
  provisionSessionpageAgentForSession,
  type ProvisionedSessionpageAgent,
  type SessionpageProvisionDeps,
  type SessionpageSessionInfo,
  defaultTaskAgentName,
} from './emdash-agent-provisioning'
import { resolveSessionpageAgentCard } from './sessionpage-agent-card'
import { resolveSessionpageSessionPeers } from './session-addressing'
import { agentNamesFromPeers } from '../../src/session/shared/lib/ipc/shell-port'
import type { LocalSessionFacts } from './emdash-agent-registry'
import { loadSessionpageCanonicalAgentIdentities } from './sessionpage-agent-identity'
import { archiveIdentity } from '@gugu/core/cloud/agentIdentityRemoval'
import type { SessionIdentityHost } from '../session/main/core/sessions/session-identity-host'
import { releaseAgentLocalFootprint } from './agent-local-footprint'

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
  sessionFacts: (target: SessionShellAgentAddressInput, options?: { includeArchived?: boolean }) => Promise<SessionpageSessionFacts | null>
  /** 这台机器侧栏上的会话(名册 session_peers 拿它对标题;名字表是那份名册的投影)。 */
  listSessionFacts: () => Promise<readonly LocalSessionFacts[]>
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

export interface SessionpageIdentityHost extends SessionIdentityHost {
  readonly provisionDeps: SessionpageProvisionDeps
  /** The default name a new task is created with on this host (task-name.ts `TaskNamer`). */
  defaultTaskName(providerId: string, taken: readonly string[]): Promise<string>
  /** Rename a bound session's identity locally first, then publish it (task-name.ts `TaskNamer`). */
  renameBound(sessionId: string, agentUserId: string, name: string): Promise<void>
  /** Publish every pending local name of the signed-in owner's agents. */
  publishPendingNames(): Promise<void>
  /** Take the cloud names of the owner's bound agents (renamed on another device); pending local names win. */
  adoptCloudNames(): Promise<void>
  agentCard(sessionId: string): Promise<SessionShellAgentCard | null>
  /** 侧栏身份卡要的那张表:本机名册(session_peers)的投影。 */
  agentNames(): Promise<SessionShellAgentName[]>
  sessionPeers(sessionId?: string): Promise<SessionShellPeer[]>
  /** 「这条会话的地址是什么」—— 与桌面版 `sessionpage:ensure-agent-address` 同一条逻辑,逐字搬来。 */
  ensureAgentAddress(input: SessionShellAgentAddressInput): Promise<SessionShellAgentAddress>
  /** 会话启动即开账号(幂等,按 conversationId 收敛);运行时分叉 / 不可寻址的引擎返回 null。 */
  provisionSessionStart(facts: SessionpageSessionStartFacts): Promise<ProvisionedSessionpageAgent | null>
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
  const peersForAuth = (auth: SessionpageIdentityAuthSnapshot, sessionId?: string) => resolveSessionpageSessionPeers({
    sessionId,
    listRoster: () => listAgents(env, { includeGuests: true }),
    ownerUserId: auth.userId,
    lookupIdentities: (agentUserIds) => loadSessionpageCanonicalAgentIdentities(auth, agentUserIds, Boolean(sessionId)),
    listSessionFacts: deps.listSessionFacts,
  })
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
  /**
   * Publish an agent's pending local name to its cloud identity. Offline / transient answers keep it
   * pending (publishPendingNames retries when the backend answers again). A refusal (not owned, not
   * authorized, invalid) cannot change by retrying: the local name is dropped for the cloud's, loudly.
   */
  const publishName = async (agentUserId: string): Promise<void> => {
    const auth = await deps.getAuth()
    if (!auth) return
    const agent = (await listAgents(env, { includeGuests: true })).find((row) => row.gugu_user_id === agentUserId)
    if (!agent || agent.cache?.name_pending !== true) return
    const client = makeIdentityClient(auth.accessToken)
    const { data, error, status } = await client.from('users')
      .update({ display_name: agent.name })
      .eq('id', agentUserId).eq('type', 'agent').eq('owner_user_id', auth.userId)
      .select('display_name').maybeSingle()
    const transient = !status || status >= 500 || [401, 408, 429].includes(status)
    if (error && transient) {
      log.warn({ agentUserId, status, error: error.message }, 'Task name publish deferred; it stays pending on this device')
      return
    }
    if (error || !data) {
      log.error({ agentUserId, status, error: error?.message ?? 'not owned' }, 'Task name refused by the backend; adopting the cloud name')
      const cloud = await client.from('users').select('display_name').eq('id', agentUserId).maybeSingle()
      const cloudName = typeof cloud.data?.display_name === 'string' ? cloud.data.display_name : ''
      if (!cloudName) throw new Error(`Task name for ${agentUserId} was refused and its cloud name cannot be read`)
      await writeAgentName(agentUserId, agent.name, 'published', env)
      await writeAgentName(agentUserId, cloudName, 'cloud', env)
      return
    }
    await writeAgentName(agentUserId, agent.name, 'published', env)
    if (data.display_name !== agent.name) await writeAgentName(agentUserId, data.display_name, 'cloud', env)
  }

  // Local first: the roster is this device's mirror of the identity name, pending until published.
  const renameBound = async (agentUserId: string, name: string): Promise<void> => {
    await writeAgentName(agentUserId, name, 'local', env)
    await publishName(agentUserId)
  }

  return {
    provisionDeps,
    async archive(sessionId, confirmedRemoval) {
      const auth = await deps.getAuth()
      if (!auth) {
        const bound = await localAgentForSession(sessionId, env)
        if (!bound?.gugu_user_id && !confirmedRemoval) return null
        throw new Error('Removing the identity needs a connection; retry, or archive without removing it.')
      }
      const agent = await localAgentForSession(sessionId, env, auth.userId, Boolean(confirmedRemoval))
      if (confirmedRemoval) {
        if (agent?.gugu_user_id !== confirmedRemoval.userId) throw new Error('Confirmed removal no longer matches the task identity');
        return confirmedRemoval
      }
      if (!agent?.gugu_user_id) return null
      try {
        const receipt = await archiveIdentity(makeIdentityClient(auth.accessToken), agent.gugu_user_id)
        return { userId: receipt.userId, removedAt: receipt.removedAt! }
      } catch (error) {
        throw new Error(`${error instanceof Error ? error.message : String(error)}. Removing the identity needs a connection; retry, or archive without removing it.`, { cause: error })
      }
    },
    async release(identity) {
      await releaseAgentLocalFootprint({ agentUserId: identity.userId, identityRemoved: true, env })
    },
    async restore(target, removedIdentity) {
      if (!(await deps.getAuth())) throw new Error('Restoring this task needs a connection and a signed-in account')
      const info = await deps.sessionFacts(target, { includeArchived: true })
      if (!info) throw new Error('Session-page session not found')
      // Retry cleanup before provisioning: a partial local teardown must never reuse the removed binding.
      await releaseAgentLocalFootprint({ agentUserId: removedIdentity.userId, identityRemoved: true, env })
      const provisioned = await provisionSessionpageAgentForSession({ ...info, replacesRemovedIdentity: removedIdentity.userId }, provisionDeps)
      if (!provisioned || provisioned.guguAgentUserId === removedIdentity.userId) {
        throw new Error('Restoring this task requires a new identity')
      }
    },
    async defaultTaskName(providerId, taken) {
      return defaultTaskAgentName(providerId, taken, (await deps.getAuth())?.userId ?? null, env)
    },
    async agentCard(sessionId) {
      // 名片按当下登录的账号解析(#4277):网页版换账号不重启宿主,不收紧就会把上一个账号的号递给现在这位。
      const auth = await deps.getAuth()
      if (!auth) return null
      return resolveSessionpageAgentCard(
        String(sessionId ?? ''),
        env,
        auth.userId,
        (agentUserIds) => loadSessionpageCanonicalAgentIdentities(auth, agentUserIds),
      )
    },
    async agentNames() {
      // 同上:名字表也按当下登录的账号过一遍,❌ 别把别家账号的 agent 名字画到侧栏上。
      const auth = await deps.getAuth()
      if (!auth) return []
      return agentNamesFromPeers(await peersForAuth(auth))
    },
    async sessionPeers(sessionId) {
      const auth = await deps.getAuth()
      if (!auth) throw new Error('Session-page peer directory: owner not authenticated')
      return peersForAuth(auth, sessionId)
    },
    renameBound: (_sessionId, agentUserId, name) => renameBound(agentUserId, name),
    async adoptCloudNames() {
      const auth = await deps.getAuth()
      if (!auth) return
      const bound = agentsForOwner(await listAgents(env, { includeGuests: true }), auth.userId)
        .filter((agent) => agent.gugu_user_id && typeof agent.cache?.[SESSION_CACHE_KEY] === 'string')
      const cloud = await loadSessionpageCanonicalAgentIdentities(auth, bound.map((agent) => agent.gugu_user_id))
      for (const identity of cloud) await writeAgentName(identity.id, identity.display_name, 'cloud', env)
    },
    async publishPendingNames() {
      const auth = await deps.getAuth()
      if (!auth) return
      const pending = agentsForOwner(await listAgents(env, { includeGuests: true }), auth.userId)
        .filter((agent) => agent.gugu_user_id && agent.cache?.name_pending === true)
      for (const agent of pending) await publishName(agent.gugu_user_id)
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
}

