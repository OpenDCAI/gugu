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
import { electronFetch, makeIdentityClient } from '../supabase'
import {
  SESSION_CACHE_KEY,
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
  sessionPeers(): Promise<SessionShellPeer[]>
  /**
   * 改这条会话的 agent 名(#6091)。云端 identity.users.display_name 是显示真源；本机花名册只同步运行时需要的
   * 本地元数据，云端认了才跟上。
   * 只改自己名下的 agent;没身份 / 不归当前账号 / 空名 / 云端拒绝 → 抛,❌ 静默改一半。
   */
  renameAgent(input: SessionShellRenameAgentInput): Promise<SessionShellAgentName>
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
  const peersForAuth = (auth: SessionpageIdentityAuthSnapshot) => resolveSessionpageSessionPeers({
    listRoster: () => listAgents(env, { includeGuests: true }),
    ownerUserId: auth.userId,
    lookupIdentities: (agentUserIds) => loadSessionpageCanonicalAgentIdentities(auth, agentUserIds),
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
  return {
    provisionDeps,
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
    async sessionPeers() {
      const auth = await deps.getAuth()
      if (!auth) throw new Error('Session-page peer directory: owner not authenticated')
      return peersForAuth(auth)
    },
    async renameAgent(input) {
      const row = input as Partial<SessionShellRenameAgentInput> | null
      const sessionId = typeof row?.sessionId === 'string' ? row.sessionId.trim() : ''
      const name = typeof row?.name === 'string' ? row.name.trim() : ''
      if (!sessionId) throw new Error('Session-page agent rename requires sessionId')
      // 空名不是「不改」,是一个会把花名册与通讯录同时写坏的值 —— 响亮拒绝。
      if (!name) throw new Error('Session-page agent rename requires a non-empty name')
      const auth = await deps.getAuth()
      if (!auth) throw new Error('Session-page agent rename: owner not authenticated')
      const agent = await localAgentForSession(sessionId, env, auth.userId)
      const agentUserId = agent?.gugu_user_id
      if (!agent || !agentUserId) {
        throw new Error(`Session-page session ${sessionId} has no agent identity to rename`)
      }
      // 云端那半:与 lib/contacts.ts updateOwnedAgentProfile 同一条 RLS 路(authenticated 对 display_name
      // 有列级 UPDATE);多加 owner_user_id 一格是让「不归我」在这里就以 0 行结束,❌ 不靠错误文案猜。
      const { data, error } = await makeIdentityClient(auth.accessToken)
        .from('users')
        .update({ display_name: name })
        .eq('id', agentUserId)
        .eq('type', 'agent')
        .eq('owner_user_id', auth.userId)
        .select('id')
        .maybeSingle()
      if (error) throw new Error(`Session-page agent rename failed for ${agentUserId}: ${error.message}`)
      if (!data) throw new Error(`Session-page agent ${agentUserId} is not owned by the current account`)
      // 本机元数据仍要跟上运行时身份上下文与恢复路径；会话页显示面不再从这格读取名字。
      const { updateAgent } = await import('@gugu/core/local/state/agents')
      await updateAgent({ guguUserId: agentUserId }, { name }, env)
      const boundSessionId = agent.cache?.[SESSION_CACHE_KEY]
      return {
        conversationId: typeof boundSessionId === 'string' && boundSessionId ? boundSessionId : sessionId,
        agentUserId,
        displayName: name,
      }
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

