import { isImplicitSessionHomeProjectId } from '@gugu/core/shared/sessionProject'
import { createGroupAdmin } from '@gugu/core/cloud/groupAdmin'
// @@@sessionpage TASKPAGE-FUSION — AUTO-PROVISIONING (Part C, the real thing). Turns a session-page session
// whose exact provider/surface declares addressable identity into a gugu agent at session start, so agents can
// message each other in the shipped product with NO test hook. Two delivery transports feed the SAME
// provisioning: codex delivers over its app-server UNIX socket (pty divert, codex-pty-provisioning) while
// claude — which has no app-server — delivers over ACP (Chat UI mode), where this same injector boundary
// provisions it and gugu's agent.deliver reaches it via `injectEmdashPromptDetached`. This is the wiring the old
// comments over-claimed: at the session backend's `session/new` (the same MCP-injector boundary where buildSocialBridge
// fires) we
//   1. resolve-or-provision a gugu agent identity (identity.users type=agent, owner_user_id=<logged-in
//      human>, bound to THIS device so its agent.deliver reaches this runtime) for the conversation, named
//      by whoever started it if they said a name (gugu_session spawn's title travels here as displayName),
//      otherwise by gugu's global serial convention (Codex 1 / Claude 2…) — either way the readable name IS
//      the addressing name (spec ⑨: an agent looks a peer's name up in the contact directory to get its id,
//      then sends by id), so BOTH sources pass the same exact-collision bump,
//   2. spec ⑨「项目 = 群」: if the conversation belongs to a session-page PROJECT, place that agent in the gugu
//      group mirroring that project (owner is a member → they watch the project's agents talk as an
//      ordinary group chat). A conversation with NO project gets NO group — it is simply a DM agent
//      contact. ❌ no catch-all group,
//   3. write the local roster record so the deliver dispatcher's findLocalAgentByGuguUserId gate finds it
//      and the wrapped ACP bridge routes the deliver onto the session-page control channel (never a gugu-native
//      engine spawn, never pty), and
//   4. promote the delivery claimant for this conversation — automatically, no test hook.
// The injector then builds the gugu MCP for that REAL identity so the agent can send/receive.
//
// Idempotent per conversation (the roster record is the SSOT for the binding — cached emdash_session_id
// + sessionpage_group_chat_id), and serialized in-process so two sessions starting back-to-back don't each
// mint a fresh task group. Fail-loud: any step that can't complete (no owner auth, no device id, group
// insert error) THROWS so session start fails rather than launching a codex agent that silently can't
// message back.
import type { BirthGroup } from '../../src/session/shared/core/sessions/create-session'
import { randomUUID } from 'node:crypto'
import { createLogger } from '../lib/logger'
import {
  createAgent,
  findReapedAgentForSession,
  listAgents,
  updateAgent,
  writeAgentRuntimeSession,
} from '@gugu/core'
import { getSupabaseAnonKey, getSupabaseUrl } from '@gugu/core/cloud/config'
import type { ProvisionSessionpageAgentOneTripInput, ProvisionedSessionpageAgentOneTrip } from '@gugu/core/cloud/ownedAgent'
import { normalizeAgentType } from '@gugu/core/agentTypes'
import { getAgentTypeLabel } from '@gugu/core/shared/enums/agentTypeModels'
import {
  resolveSessionpageSessionIntegration,
  type SessionpageSessionSurface,
} from '@gugu/session-plugins/agents'
import { electronFetch, makeChatClient } from '../supabase'
import { agentsForOwner } from '@gugu/core/local/state/agentOwner'
import { AGENT_CLOUD_IDENTITY_STATE_CACHE_KEY } from '@gugu/core/local/state/agentCloudIdentity'
import { emdashAgentRegistry, unregisterEmdashAgent } from './emdash-agent-registry'
// #5419 撤回一行没落地的本机身份 = 释放它的本机足迹,与「owner 删 agent」「回收器收 agent」
// 是同一个动作的第三条驱动 ⇒ 用同一个实现。(该模块回头引本文件的 cache key 常量,两边都只在
// 调用时用,模块初始化期互不依赖。)
import { releaseAgentLocalFootprint } from './agent-local-footprint'
import {
  prepareSessionpageDeliveryOwner,
  type SessionpageDeliveryOwnerKind,
} from './sessionpage-delivery-owner-registry'
import { forgetProjectGroupId, readProjectGroupId, rememberProjectGroupId } from './sessionpage-project-groups'
import { agentNameSerial, nextAgentDefaultName, uniqueAgentDisplayName } from '../../src/lib/agentDefaultName'
import { listAgentNameSerialsViaSupabase } from '@gugu/core/cloud/agentIdentityReconcile'
import { registerOfflineLocalSessionDelivery, unregisterLocalSessionDeliveryForAgent } from './local-session-delivery'
import {
  SESSIONPAGE_SESSION_CACHE_KEY,
  SESSIONPAGE_GROUP_CHAT_CACHE_KEY,
  SESSIONPAGE_OWNER_CACHE_KEY,
  SESSIONPAGE_PARKED_SESSION_CACHE_KEY,
  SESSIONPAGE_PROJECT_CACHE_KEY,
} from '@main/core/sessionpage/sessionpage-session-agent'

/** Roster-record cache keys binding a gugu agent to its session-page conversation, its project + task, and
 *  (project-scoped conversations only) the gugu group mirroring its project. Projectless conversations store
 *  empty project/group → they are plain DM agent-contacts, not group members (spec ⑨). project+task ids let
 *  a task/project cascade-delete reap this agent (cascade fires no per-conversation delete event). */
// 这三格另有一个读者:会话页会话自己的 MCP 面(`@main/core/sessionpage/sessionpage-session-agent`,
// spawn 回执据此说出对话该落在哪个项目群)。写者在这边、读者在那边,键名各写一份就会在改名时
// 无声分家 —— 读者查不到、回执悄悄退回点对点,正是 #4566 的病灶形状。所以键名只有一处定义。
export const SESSION_CACHE_KEY = SESSIONPAGE_SESSION_CACHE_KEY
export const GROUP_CACHE_KEY = SESSIONPAGE_GROUP_CHAT_CACHE_KEY
export const DIRECT_CHAT_CACHE_KEY = 'sessionpage_direct_chat_id'
export const PROJECT_CACHE_KEY = SESSIONPAGE_PROJECT_CACHE_KEY
export const PROVIDER_CACHE_KEY = 'sessionpage_provider_id'
export const OWNER_CACHE_KEY = SESSIONPAGE_OWNER_CACHE_KEY
export const PARKED_SESSION_CACHE_KEY = SESSIONPAGE_PARKED_SESSION_CACHE_KEY
export const SURFACE_CACHE_KEY = 'sessionpage_session_surface'
/**
 * #5331 公网身份落地状态:'pending'(本机身份已起、云端那一发在后台跑)/ 'ready' / 'failed'。
 * 老行没有这一格 = ready(它们是同步铸出来的)。
 *
 * 定义在 @gugu/core:设备运行时(packages/core)也要读它 —— 它的 gone-agent 守卫必须能认出
 * 「云端还没这一行」与「云端那一行没了」的区别,否则会把一条正在起的会话的名册行删掉。
 */
export const CLOUD_STATE_CACHE_KEY = AGENT_CLOUD_IDENTITY_STATE_CACHE_KEY
/** Fallback group name when the project's display name can't be resolved. */
const FALLBACK_PROJECT_GROUP_NAME = '任务项目'
/**
 * The session page's sentinel "implicit task-home project" — the execution context it gives a task created BEFORE the
 * user opens a repository. The session page never renders it as a selectable project, so to the user such a
 * conversation has NO project, and spec ⑨ makes its agent a plain DM contact rather than a group member.
 * The marker is shared by host, renderer and cloud readers in core/shared/sessionProject.
 */
export { IMPLICIT_SESSION_HOME_PROJECT_ID } from '@gugu/core/shared/sessionProject'

/**
 * @@@task-home-cwd — a conversation on the implicit task-home project runs in gugu's OWN app-owned
 * `<userData>/task-home` cwd, not a user repository. That distinction is load-bearing for the OpenCode
 * serve/attach leg: the task-home cwd is shared across every no-repo agent AND both legs, so anything
 * OpenCode auto-discovers there (a leftover `.opencode/plugins/*.js`, or one the acp leg legitimately
 * wrote) turns the serve's `POST /session` into a workspace npm install. A serve running in this
 * gugu-owned cwd should take its config only from `OPENCODE_CONFIG_CONTENT` + the user's GLOBAL config,
 * never from that shared workspace — whereas an agent opened in a real user repo keeps reading its repo
 * `.opencode`. So the boundary is directory ownership, keyed off this sentinel id.
 */
export { isImplicitSessionHomeProjectId } from '@gugu/core/shared/sessionProject'

/**
 * 建群看的项目 id:用户眼里「没有项目」的会话不建、不进项目群,agent 只是私聊联系人(spec ⑨ 的群只对用户看得见的项目成立)。
 *  - 会话页的隐式任务工作区(见上)。
 *  - 云电脑(#7199,`GUGU_CLOUD_COMPUTER=1`,云电脑管家启动 server 前设):那台机器上的项目只是 agent 的落脚处,
 *    用户在「助理」里看见的是个人助理、不是项目;建群会把这层内部结构露成聊天列表里一个莫名的「云电脑」群
 *    (owner 2026-10-15 经统筹:「那是内部结构，露给了用户」)。会话照旧属于那个项目(server 上的会话一律属于某个项目),
 *    只是 agent 走与主人的私聊。已经建了的旧群不动。
 */
export function groupProjectIdFor(rawProjectId: string | null | undefined, env: NodeJS.ProcessEnv): string {
  const projectId = (rawProjectId ?? '').trim()
  if (isImplicitSessionHomeProjectId(projectId)) return ''
  if (env.GUGU_CLOUD_COMPUTER === '1') return ''
  return projectId
}

/**
 * #6396 本机起号的起点:这个账号每个名字前缀在服务端已经用到几号(identity.agent_name_serials,
 * 删掉/改过名的 agent 用过的号也算)。序号只增不减,所以这份也只增不减地合并四路事实:登录时取一次、
 * 另一台设备发了号就当场再取一次(服务端给本账号每台设备推 agent_changed,渲染层转给主进程)、
 * 每建一条会话在后台再取一次(无头宿主没有那条推送,靠这一路)、本机刚发出去的号。
 *
 * ⚠️ 它落后了也不会发出重号 —— 服务端按自己的记录把偏低的候选往上抬(identity.provision_taskpage_agent)。
 *    这份的价值是让会话**起来时**的名字就是最终的名字,不在起来一秒后被改名。❌ 所以也不该为它挡启动链。
 */
const serialFloorsByOwner = new Map<string, Map<string, number>>()

function raiseSerialFloor(ownerUserId: string, base: string, serial: number): void {
  const floors = serialFloorsByOwner.get(ownerUserId) ?? new Map<string, number>()
  if ((floors.get(base) ?? 0) < serial) floors.set(base, serial)
  serialFloorsByOwner.set(ownerUserId, floors)
}

function serialFloor(ownerUserId: string, label: string): number {
  return serialFloorsByOwner.get(ownerUserId)?.get(label) ?? 0
}

/** 本机发出去 / 服务端定下的名字若是「<label> <n>」,n 就是用过的号。 */
function noteAgentName(ownerUserId: string, name: string, label: string): void {
  const serial = agentNameSerial(name, label)
  if (serial !== null) raiseSerialFloor(ownerUserId, label, serial)
}

const listAgentNameSerialsDefault = (auth: { accessToken: string; userId: string }): Promise<Map<string, number>> =>
  listAgentNameSerialsViaSupabase({ accessToken: auth.accessToken, fetch: electronFetch })

/**
 * 同一账号同一时刻只许一发在途。推送是成批来的(批量删 10 个 agent = 10 条 agent_changed),在途时再来的
 * 只记一笔「完了再取一次」—— 那一次取到的是这一批之后的状态,❌ 不是每条推送各打一发。
 */
const floorRefreshByOwner = new Map<string, { again: boolean }>()

function refreshSerialFloors(
  auth: { accessToken: string; userId: string },
  lister: (auth: { accessToken: string; userId: string }) => Promise<Map<string, number>> = listAgentNameSerialsDefault,
): void {
  const inFlight = floorRefreshByOwner.get(auth.userId)
  if (inFlight) {
    inFlight.again = true
    return
  }
  const slot = { again: false }
  floorRefreshByOwner.set(auth.userId, slot)
  void lister(auth)
    .then((serials) => {
      for (const [base, highWater] of serials) raiseSerialFloor(auth.userId, base, highWater)
    })
    .catch((error: unknown) => {
      createLogger('sessionpage/provision').warn(
        { error: error instanceof Error ? error.message : String(error) },
        '#6396 agent_name_serials read failed — the next session numbers from local names; the server lifts a stale candidate',
      )
    })
    .finally(() => {
      if (floorRefreshByOwner.get(auth.userId) === slot) floorRefreshByOwner.delete(auth.userId)
      if (slot.again) refreshSerialFloors(auth, lister)
    })
}

/**
 * 起名要用的账号级事实:各前缀用到几号(#6396)。两个时刻取:登录完成后先取一次;
 * 这个账号的 agent 有变动(另一台设备建了 / 改了名 / 删了)时再取一次 —— 于是另一台刚用掉的号,
 * 本机下一条会话起来时就已经避开,❌ 不是先用重、落地后再被改名。
 * **不在启动链上**:失败只是让下一条会话照旧自己去取,❌ 不该把登录或建会话拖住。
 */
export function refreshAgentNamingFacts(auth: { accessToken: string; userId: string }): void {
  refreshSerialFloors(auth)
}

/**
 * #5323 「这个 agent 有没有 owner 私聊」的短时记忆。
 *
 * 一次会话启动会跑**两遍**供给(ACP/PTY 钩子一遍、opencode serve/attach 这类 sidecar 再一遍;
 * `provisionSessionpageAgentForSession` 本就是幂等的)。第二遍走复用路径,而复用路径按设计要**查一次**
 * 私聊——那是给 resume 用的(owner 可能在两次会话之间自己开了私聊)。可这两遍只隔 1.4 秒,
 * 那 1.4 秒里开不出一条私聊,这一查是白白的一次云往返(真机实测 394 ms)。
 *
 * ⚠️ 只记很短一段:超过 TTL 就照旧去查,resume 的语义一个字没变。❌ 别改成进程级长缓存 ——
 * 「没有私聊」是会变的事实,记久了就把 owner 新开的私聊锚丢了。
 */
const DIRECT_CHAT_MEMO_TTL_MS = 30_000
const directChatMemo = new Map<string, { chatId: string; at: number }>()

async function findOwnerDirectChatMemoized(accessToken: string, agentUserId: string): Promise<string> {
  const hit = directChatMemo.get(agentUserId)
  if (hit && Date.now() - hit.at < DIRECT_CHAT_MEMO_TTL_MS) return hit.chatId
  const chatId = await findOwnerDirectChat(accessToken, agentUserId)
  directChatMemo.set(agentUserId, { chatId, at: Date.now() })
  return chatId
}

/** The slice of the session-page session-start info this module needs. */
export interface SessionpageSessionInfo {
  sessionId: string
  providerId: string
  surface: SessionpageSessionSurface
  cwd: string
  /** Existing durable saga identity; supplied when a team member owns the cloud identity already. */
  agentUserId?: string
  displayName?: string
  chatId?: string | null
  /** Session-page project this conversation belongs to (spec ⑨: project = gugu group). Empty/absent → the
   *  conversation has no project → the agent is a plain DM contact, not a group member. */
  projectId?: string | null
  /** Native transports can delay the UI notification until their delivery target is also registered. */
  deferProvisionedEvent?: boolean
  /** Session lifecycle from the start path. 'resume' rides the background lane of the provisioning
   *  queue so a user-initiated fresh spawn never starves behind a boot-time resume flood (#4162). */
  lifecycle?: 'fresh' | 'fork' | 'resume'
  /**
   * 运行时分叉(#3805 侧边聊天;product spec「侧边任务」)的**来源会话**。有值 = 这次 session
   * start 不是一条会话上位,而是那条会话的运行时分叉:临时、不落库、关标签页/重启即消失。
   *
   * 分叉是一条**分叉出来的 agent**(product spec「会话即 agent」),不是来源那个
   * agent 的第二张嘴;而 #3805 又要求它一个字都不落库 ⇒ 它没有 `identity.users` 行、没有咕咕 id、
   * 对外不可寻址。所以 provisioning 这一步**什么都不做**(返回 null):
   *   ❌ provision 就得盖章 roster 绑定 —— 会把来源会话的 surface 从 tui 改写成 acp,下次
   *      开机 registerExistingSessionpageAgents 按这一格选错 owner kind;projectId 对不上还会抹掉群绑定。
   *   ❌ provision 就会参与投递归属仲裁 —— prepareSessionpageDeliveryOwner 先 unregister 旧 claimant,
   *      codex 那条 unregister 会 dispose 掉来源会话**正在用**的 app-server(SIGTERM 进程组 + 删 sock)。
   *      owner 实测:开侧边聊天当场打死主 codex 会话,TUI 报 `Connection reset without closing handshake`。
   *
   * ⚠️ 「没有身份」≠「能力包也要削一套精简的」。分叉的能力包与来源**一字不差**(见
   * resolveRuntimeForkSource):系统提示与工具清单都在模型前缀里,分叉继承的又正是来源的
   * transcript —— 前缀只要有一处不同,那整段上下文就命中不了缓存,每开一次侧边聊天都全价重算。
   * 「不可寻址」这条改由 IM 那道闸表达:工具照常注册(前缀不变),一调用就拒(gugu-im-server.mjs
   * 的 dispatchTool)。owner 2026-08-21 定调。
   */
  sourceSessionId?: string
}

/** Owner auth + local device id — the two things only main.ts can resolve. */
export interface SessionpageProvisionDeps {
  getAuth: () => Promise<{ accessToken: string; refreshToken: string; userId: string } | null>
  resolveDeviceId: () => Promise<string | null>
  /** Resolve a session-page project's display name (to name its gugu group). Absent / returns null → fallback. */
  resolveProjectName?: (projectId: string) => Promise<string | null>
  /**
   * The chat a conversation's agent was born in (`session_spawn` chat_id, an App's `spawnAgent` chat), recorded at the
   * spawn and taken here when its identity is first minted (birth-groups.ts) — once: an agent later removed from the
   * group, or that left it, is not put back.
   */
  takeBirthGroup?: (sessionId: string) => Promise<BirthGroup | null | undefined>
  /**
   * #4277 老名册行没记 owner:问云端一次「这个 agent 归当前账号吗」。缺席 ⇒ 按「归我」认领(老行为,
   * 单账号机器上永远正确);在场 ⇒ 别家的行被停放、当前账号自己登记一个。
   */
  isAgentOwnedByCurrentUser?: (agentUserId: string) => Promise<boolean>
  /** #6396 这个账号各名字前缀用到几号(identity.agent_name_serials)。缺席 ⇒ 走 supabase 适配器;测试注入用。 */
  listAgentNameSerials?: (auth: { accessToken: string; userId: string }) => Promise<Map<string, number>>
  /**
   * #5331 一次往返供给:铸身份 + 名字唯一性 + 进项目群合成一个 RPC(identity.provision_taskpage_agent)。
   * 新身份只从这里铸。宿主接线时给 @gugu/core 的实现。
   */
  provisionOneTrip: (input: ProvisionSessionpageAgentOneTripInput) => Promise<ProvisionedSessionpageAgentOneTrip>
  env?: NodeJS.ProcessEnv
}

export interface ProvisionedSessionpageAgent {
  guguAgentUserId: string
  /** Canonical owner-agent DM. Project group membership is a separate collaboration fact. */
  chatId: string
  /**
   * #5323 这个身份的**会话系统块所需字段**,在铸它的那一步就已经全知道。
   *
   * 只在**刚铸出来**的那条路上给:persona 那时必然为空(会话页从不设 persona)。
   * 复用既有身份的那条路给 `undefined` —— 它的 persona 可能被别处改过,调用方仍需去读一次。
   * ❌ 别为一个自己 0.4 秒前刚写进库的字段再走一趟网络(真机实测 416 ms,与 #4320 同一类)。
   * 显示名不在这里(#6490):系统块不写名字,agent 要知道就调 profile_whoami。
   */
  agentIdentityFacts?: { specialFocus: string | null }
  /** Dynamic facts for the session system bootstrap; absent when the session has no project group. */
  projectContext?: {
    projectId: string
    projectName: string
    projectPath: string
    groupChatId: string
    groupName: string
  }
  event: SessionpageAgentProvisionedEvent
}

export interface SessionpageAgentIdentityInput {
  /** Existing cloud identity from the durable provision row. */
  agentUserId: string
  displayName?: string
  agentType: string
  projectPath?: string | null
  /** Existing canonical DM from the durable provision row; absent for a fresh session. */
  chatId?: string | null
  /** 调用方已经读过的名册。 */
  roster: RosterRow[]
}

export interface ProvisionedSessionpageAgentIdentity {
  guguAgentUserId: string
  chatId: string
  /**
   * 这个身份此刻的显示名 —— 也就是它的寻址名(spec agent-provisioning「命名即寻址名」)。
   *
   * #4320:它本来就是上面那一步算出来的(显式名过重名闸,或「<引擎 label> <序号>」自增),
   * 却没有被带出来,于是调用方为了把它读回来又整读了一遍 roster。返回值该带的事实就带出来。
   */
  displayName: string
}

/** What the session page learns the moment a session HAS an addressable identity (both legs). */
export interface SessionpageAgentProvisionedEvent {
  sessionId: string
  agentUserId: string
  /** Display name = addressing name (`Claude 1`), the same string the contact directory shows. */
  displayName: string
  /** Canonical owner-agent DM used by the ordinary message router. */
  chatId: string | null
  /**
   * #6396 这条会话起来时用的名字 —— 只在云端登记时发现它已经用过、登记成了 `displayName` 时才有。
   * 听的人据此告诉那条会话(对话里一行 + agent 的新身份),见 sessionpage-rename-announcement.ts。
   */
  renamedFrom?: string
}

// Provisioning is ASYNC relative to the UI: the session page renders a task the instant it is created, but the
// identity only exists a beat later (auth + cloud provision + roster write). Anything that shows "who is this
// session" must therefore be TOLD, not left holding the null it read too early (that was the 分享 button
// rendering permanently disabled on a freshly created task). One notifier here covers BOTH provisioning legs
// (ACP injector + pty divert) because both funnel through provisionLocked — no per-call-site wiring.
const provisionedListeners = new Set<(event: SessionpageAgentProvisionedEvent) => void>()

// #5331 内网身份即刻、公网身份后台(owner 2026-09-09:「有两层身份,内网身份和公网身份,往外分享才是公网身份;
// 原则上不能阻塞用户的会话起来」)。会话拿着本机预生成的 id / 名字 / 群 id 立刻起来;云端那一发在这里登记、
// 后台跑;「身份就绪」的通知等它落地再发 —— 通知的消费者(分享按钮、presence 投影)要的正是公网那一层。
export type CloudIdentityState = 'pending' | 'ready' | 'failed'
const cloudStateByAgent = new Map<string, CloudIdentityState>()
const cloudWorkByAgent = new Map<string, Promise<void>>()
const pendingProvisionedEvents = new Map<string, SessionpageAgentProvisionedEvent>()
/**
 * 第 19 条(10-12):#5419 撤掉的身份,按会话记着,直到这条会话下一次铸身份。撤行时会话照跑,手里还拿着发给
 * 这个身份的 gugu MCP 卡;它再起来就铸一个新身份,而 host 不给同一条会话换主体发卡(gugu-mcp-host `grant`),
 * 会话就再也起不来。⇒ 下一次铸之前,先收掉旧身份的卡 —— 与 #6938 云端已经没有这个 agent 时收卡是同一个口。
 * ❌ 撤行那一刻就收:那会让照跑的会话当场没了 gugu MCP。进程内记账:重启后 host 的活卡也没了,不会撞。
 */
const withdrawnIdentityBySession = new Map<string, string>()
let revokeAgentCards: ((agentUserId: string) => Promise<void>) | null = null

/** 宿主收卡的口(main.ts:三个 gugu MCP host 的 `revokeSubject`)。没有 gugu MCP 卡的宿主(网页版无头宿主)不装。 */
export function setSessionpageAgentCardRevoker(revoke: ((agentUserId: string) => Promise<void>) | null): void {
  revokeAgentCards = revoke
}

/**
 * 第 19 条:终端会话「接回」(引擎还是原来那个,手里还是发给旧身份的卡)之前问一句。身份被撤过就 ❌ 铸新身份、❌ 收卡
 * —— 收了它手里的卡,这一轮就没有 gugu MCP、就绪也要等到超时 —— 当场说清;重新开(不是接回)才换新身份(评审 r1)。
 */
export function assertSessionpageIdentityForReattach(sessionId: string): void {
  if (withdrawnIdentityBySession.has(sessionId)) {
    throw new Error('这个会话的身份失效了(上次开户没成功):要重新开这个会话(不是接回)才能换新身份')
  }
}
/**
 * A newly minted agent joins the chat it was born in — `chat.add_group_agent`, as its owner, so the group's rules decide
 * (cap, approval queue). Nothing here fails the identity: what happened is logged, and a pending approval is the
 * group's to settle.
 */
async function joinBirthGroup(accessToken: string, ownerUserId: string, group: BirthGroup | null | undefined, agentUserId: string, log: ReturnType<typeof createLogger>): Promise<void> {
  if (!group) return
  const { chatId, asTask } = group
  try {
    const data = await createGroupAdmin(makeChatClient(accessToken), ownerUserId).addAgent(chatId, agentUserId, { asTask })
    log.info({ agentUserId, chatId, asTask, status: data.status }, 'agent born in a chat: asked to join it, the group answered')
  } catch (error) {
    log.warn({ agentUserId, chatId, error: error instanceof Error ? error.message : String(error) }, 'agent born in a chat could not join it')
  }
}

/** 测试 / 需要公网身份的调用方(签平台令牌)等这个 agent 的云端那一发落地;失败即抛。 */
export async function awaitSessionpageCloudIdentity(agentUserId: string): Promise<void> {
  const work = cloudWorkByAgent.get(agentUserId)
  if (work) await work
  if (cloudStateByAgent.get(agentUserId) === 'failed') {
    throw new Error(`session-page agent ${agentUserId}: cloud identity provisioning failed`)
  }
}

/** 等所有在途的后台云端供给结束(成功或失败都算)。给测试与关机用。 */
export async function settleSessionpageCloudProvisioning(): Promise<void> {
  await Promise.allSettled([...cloudWorkByAgent.values(), ...reuseBackfillByAgent.values()])
}

/**
 * #7341 等这几个 agent 在后台的云端那一发(铸身份 / 重开时的群核对)落定,成功失败都算。
 * 那两条后台路径落地时会回写名册里的群;绑定改群之前先等它们,否则晚到的回写会把刚改的群改回去。
 */
export async function settleSessionpageAgentBackgroundWork(agentUserIds: readonly string[]): Promise<void> {
  await Promise.allSettled(agentUserIds.flatMap((id) => {
    const work = [cloudWorkByAgent.get(id), reuseBackfillByAgent.get(id)]
    return work.filter((w): w is Promise<void> => Boolean(w))
  }))
}

/** #7341 这个 agent 的公网身份落地了没有(本机先起的行是 pending / failed,老行没有这一格 = ready)。 */
export function sessionpageCloudIdentityState(agent: { gugu_user_id: string; cache?: Record<string, unknown> | null }): CloudIdentityState {
  return cloudStateByAgent.get(agent.gugu_user_id) ?? ((cacheString(agent.cache, CLOUD_STATE_CACHE_KEY) || 'ready') as CloudIdentityState)
}

/** 只给单测:清掉模块级状态(探针结果、在途工作、待发通知)。 */

export function resetSessionpageCloudProvisioningForTests(): void {
  cloudStateByAgent.clear()
  cloudWorkByAgent.clear()
  withdrawnIdentityBySession.clear()
  pendingProvisionedEvents.clear()
  serialFloorsByOwner.clear()
  floorRefreshByOwner.clear()
}

/** Subscribe to "this session now has a gugu identity". Returns an unsubscribe. */
export function onSessionpageAgentProvisioned(
  listener: (event: SessionpageAgentProvisionedEvent) => void,
): () => void {
  provisionedListeners.add(listener)
  return () => provisionedListeners.delete(listener)
}

function emitProvisioned(event: SessionpageAgentProvisionedEvent): void {
  // #5331 公网身份还在后台铸 ⇒ 先压着;落地那一刻由 flushProvisionedEvent 发出同一份。
  if (cloudStateByAgent.get(event.agentUserId) === 'pending') {
    pendingProvisionedEvents.set(event.sessionId, event)
    return
  }
  for (const listener of provisionedListeners) {
    // A listener throwing must not fail the session start it is merely observing.
    try {
      listener(event)
    } catch (err) {
      console.error(`[sessionpage] sessionpage provisioned listener failed: ${(err as Error).message}`)
    }
  }
}

export function emitSessionpageAgentProvisioned(event: SessionpageAgentProvisionedEvent): void {
  emitProvisioned(event)
}

// In-process mutex so concurrent session starts don't race on task-group creation / duplicate identities.
//
// #4162 —— 互斥保留，修它的两个病：
// 1. 饥饿：冷启动的一批 resume 把用户此刻发起的 fresh spawn 压在队尾（Air 实测「正在加载对话…」
//    分钟级）。互斥语义不变，改两条 FIFO 车道：interactive（fresh/fork、设备命令）先于
//    background（boot resume）。仍然一次只跑一个，只是出队顺序让「有人正在等」的先走。
// 2. 静默：排队与慢供应零日志。等待 >2s、执行 >5s 必须开口。
const provisionLogger = createLogger('sessionpage/provision')
type ProvisionLane = 'interactive' | 'background'
const provisionQueue: Array<{
  lane: ProvisionLane
  label: string
  enqueuedAt: number
  run: () => void
}> = []
let provisionRunning = false
function pumpProvisionQueue(): void {
  if (provisionRunning) return
  const index = provisionQueue.findIndex((item) => item.lane === 'interactive')
  const next = index >= 0 ? provisionQueue.splice(index, 1)[0] : provisionQueue.shift()
  if (!next) return
  provisionRunning = true
  const waited = Date.now() - next.enqueuedAt
  if (waited > 2_000) {
    provisionLogger.warn(
      { label: next.label, lane: next.lane, waitedMs: waited, queueDepth: provisionQueue.length },
      'provision queue wait exceeded 2s — #4162',
    )
  }
  next.run()
}
export function serializeProvisionForTest<T>(
  fn: () => Promise<T>,
  lane: ProvisionLane = 'interactive',
  label = 'provision',
  runTimeoutMs?: number,
): Promise<T> {
  return serialize(fn, lane, label, runTimeoutMs)
}

/**
 * #7341 项目群绑定(并进来 / 预留群 id)与开会话共用这把锁:两边都读改写「项目 → 群」对照与名册里的群,
 * 背靠背发生时(刚并进来就开会话、开着会话就并进来)不排队就会各记各的群。interactive 车道 —— 有人正在等。
 * ❌ 在 fn 里再调本模块任何会进锁的入口(provisionSessionpageAgentForSession / provisionSessionpageAgentIdentity):锁不可重入。
 */
export function withSessionpageProvisionLock<T>(label: string, fn: () => Promise<T>): Promise<T> {
  return serialize(fn, 'interactive', label)
}

// #4181 —— 队列级 run 超时。曾有 provision run 永不结束：老遥测只在出队/结束时发声，卡死的 run 与被它
// 堵住的整条队列零输出（41 分钟静默）。三补：入队即记、运行中每 30s 报「still running」、超时强制放行
// 队列并向调用方 fail loud（被超时的 run 成为孤儿——它的迟到完成只写自己的状态，不再持有队列）。
// 480s 供应队列自身的兜底；agent.create 的有界启动预算另由 #4184 的 host abort（150s）权威约束。
// #4320 —— run 内部的分段计时。#4181 让「队列在不在跑」可见，但一次 run 里连着 6~8 个顺序云调用，
// 它们合起来只呈现为一行「exceeded 5s」——慢在哪一个调用上说不出来。每个云往返自己报名。
export function provisionStage(label: string, startedAt: number) {
  return (stage: string, extra?: Record<string, unknown>): void => {
    provisionLogger.info(
      { label, stage, elapsedMs: Date.now() - startedAt, ...extra },
      'provision stage — #4320',
    )
  }
}

const PROVISION_RUN_TIMEOUT_MS = 480_000
const PROVISION_STILL_RUNNING_INTERVAL_MS = 30_000
function serialize<T>(
  fn: () => Promise<T>,
  lane: ProvisionLane = 'interactive',
  label = 'provision',
  runTimeoutMs = PROVISION_RUN_TIMEOUT_MS,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    provisionLogger.debug({ label, lane, queueDepth: provisionQueue.length, running: provisionRunning }, 'provision enqueued — #4181')
    provisionQueue.push({
      lane,
      label,
      enqueuedAt: Date.now(),
      run: () => {
        const startedAt = Date.now()
        // #4320 —— `fn()` 同步抛出时,异常会从这里一路冒到 serialize 的 executor,而 `provisionRunning`
        // 停在 true —— 整条队列从此再也不会被唤起。这才是「队列唤醒的洞」真正长的样子(#4320 待归因 3
        // 猜的那种「排队没被唤起」并不存在:入队日志的 queueDepth=0/running=false 说明它当场就跑了)。
        // 直接启动 run，只有同步抛出才转成 rejection；队列出队后的启动时序必须保持同步。
        let released = false
        const release = () => {
          if (released) return
          released = true
          clearInterval(stillRunningTimer)
          clearTimeout(runTimeoutTimer)
          provisionRunning = false
          pumpProvisionQueue()
        }
        const stillRunningTimer = setInterval(() => {
          provisionLogger.warn(
            { label, lane, runningMs: Date.now() - startedAt, queueDepth: provisionQueue.length },
            'provision run still running — #4181',
          )
        }, PROVISION_STILL_RUNNING_INTERVAL_MS)
        const runTimeoutTimer = setTimeout(() => {
          provisionLogger.error(
            { label, lane, runningMs: Date.now() - startedAt, queueDepth: provisionQueue.length },
            'provision run timed out — releasing the queue, the stuck run is orphaned — #4181',
          )
          reject(new Error(`provision run for ${label} timed out after ${Math.round(runTimeoutMs / 1000)}s — #4181`))
          release()
        }, runTimeoutMs)
        let result: Promise<T>
        try {
          result = fn()
        } catch (error) {
          result = Promise.reject(error)
        }
        result.then(resolve, reject).finally(() => {
          const took = Date.now() - startedAt
          if (took > 5_000) {
            provisionLogger.warn({ label, tookMs: took }, 'provision run exceeded 5s — #4162')
          }
          release()
        })
      },
    })
    pumpProvisionQueue()
  })
}

export function cacheString(cache: Record<string, unknown> | null | undefined, key: string): string {
  const value = cache?.[key]
  return typeof value === 'string' ? value : ''
}

/** Replay a create against its durable roster binding, never the process-local registry. */
export async function sessionpageAgentSessionForStart(agentUserId: string, ownerUserId: string): Promise<string | undefined> {
  const agent = agentsForOwner(await listAgents(), null, { includeArchived: true }).find((row) => row.gugu_user_id === agentUserId)
  if (!agent) return undefined
  if (!agentsForOwner([agent], ownerUserId, { includeArchived: true }).length) throw new Error('agent.create roster owner mismatch')
  return cacheString(agent.cache, SESSION_CACHE_KEY) || cacheString(agent.cache, PARKED_SESSION_CACHE_KEY) || undefined
}

/**
 * 这个 provider/surface 的会话能不能拿到咕咕身份。唯一事实源是 plugin registry 的 sessionpage 两轴声明；
 * platform catalog 与 transport capability 读取同一格。
 */
/**
 * 这条腿**可不可寻址** —— 只问身份,不问 transport。
 *
 * @@@4682 它与下面的 `canProvisionSessionpageAgent` **是两个不同的问题**,故意并排放在这里,
 * 免得下一个要问「可不可寻址」的人对着同一批输入再推一遍(spec session-injection 的单一产地不变量)。
 * 差别:供给闸还要求这条腿有 message transport;而「原地进入这个 Agent 的私聊」只需要它有身份 ——
 * #4653 实测:那里曾经多问了一句 transport,于是对话页 PTY 首句改走启动通道之后,
 * 消息已落库、DM 已开好,用户却被这道闸挡住、创建面卡住不关。
 */
export function isSessionpageAddressable(
  providerId: string,
  surface: SessionpageSessionSurface,
): boolean {
  return resolveSessionpageSessionIntegration(providerId, surface).identity === 'addressable'
}

export function canProvisionSessionpageAgent(
  providerId: string,
  surface: SessionpageSessionSurface,
): boolean {
  const integration = resolveSessionpageSessionIntegration(providerId, surface)
  return integration.identity === 'addressable' && integration.messageTransport !== 'none'
}

export function resolveSessionpageDeliveryOwnerKind(
  providerId: string,
  surface: SessionpageSessionSurface,
): SessionpageDeliveryOwnerKind {
  const integration = resolveSessionpageSessionIntegration(providerId, surface)
  if (integration.messageTransport !== 'router') return 'none'
  return surface === 'acp' ? 'emdash' : 'native'
}

/**
 * 把调用方点名的既有云端身份接到这台机器上(名册、私聊锚、runtime session)。新身份不从这里铸:
 * 那一条是 provisionFreshLocalFirst(本机先起、公网身份后台一次往返)。
 */
async function adoptSessionpageAgentIdentityLocked(
  info: SessionpageAgentIdentityInput,
  deps: SessionpageProvisionDeps,
): Promise<ProvisionedSessionpageAgentIdentity> {
  const env = deps.env ?? process.env
  const guguAgentUserId = info.agentUserId.trim()
  const mark = provisionStage(`identity ${guguAgentUserId}`, Date.now())
  mark('identity-begin')
  const auth = await deps.getAuth()
  if (!auth?.accessToken || !auth.userId) {
    throw new Error('session-page agent provisioning: owner not authenticated')
  }
  mark('auth-resolved')
  const agentType = normalizeAgentType(info.agentType)
  const roster = info.roster
  const existing = roster.find((agent) => agent.gugu_user_id === guguAgentUserId)
  const displayName = info.displayName?.trim() || existing?.name || ''
  if (!displayName) throw new Error(`session-page agent provisioning: ${guguAgentUserId} has no display name`)
  // @@@no-auto-dm — 调用方显式给了 chat(对话页建号那条路会给)就用它;否则只**查**已有私聊,查不到
  // 就是 ''(这个 agent 目前没有私聊,也不该为它凭空开一条)。
  const chatId = info.chatId?.trim() || await findOwnerDirectChatMemoized(auth.accessToken, guguAgentUserId)
  mark('direct-chat-resolved')
  // #4277 每一行都记 owner:这个身份是拿当前账号复用的。
  const local = existing
    ? await updateAgent({ guguUserId: existing.gugu_user_id }, {
      name: displayName,
      agent_type: agentType,
      path: info.projectPath || '',
      gugu_user_id: guguAgentUserId,
      cache: { ...(existing.cache ?? {}), [DIRECT_CHAT_CACHE_KEY]: chatId, [OWNER_CACHE_KEY]: auth.userId },
    }, env)
    : await createAgent(
      { name: displayName, agent_type: agentType, path: info.projectPath || '', gugu_user_id: guguAgentUserId, prompt: '' },
      env,
    )
  if (!existing) {
    await updateAgent({ guguUserId: guguAgentUserId }, {
      cache: { ...(local.cache ?? {}), [DIRECT_CHAT_CACHE_KEY]: chatId, [OWNER_CACHE_KEY]: auth.userId },
    }, env)
  }
  mark('local-roster-written')
  await writeAgentRuntimeSession(
    { accessToken: auth.accessToken, refreshToken: auth.refreshToken, agentUserId: guguAgentUserId },
    env,
  )
  mark('runtime-session-written')
  return { guguAgentUserId, chatId, displayName }
}

/**
 * Resolve or provision the gugu agent identity for a starting addressable session-page session and
 * register its binding. Returns null when that exact sessionpage surface declares no addressable identity,
 * so the provider keeps its plugin-owned startup path. Throws (fail-loud)
 * on any provisioning failure.
 */
export async function provisionSessionpageAgentForSession(
  info: SessionpageSessionInfo,
  deps: SessionpageProvisionDeps,
): Promise<ProvisionedSessionpageAgent | null> {
  // 运行时分叉没有会话页身份(见 sourceConversationId):它既不铸新身份、也不借来源会话的,于是
  // 归属、绑定、provisioned 事件一格都不动。调用方按「无身份」处理 —— ACP 注入器给它会话级能力包。
  const sourceSessionId = info.sourceSessionId?.trim() ?? ''
  if (sourceSessionId && sourceSessionId !== info.sessionId) return null
  // @@@4670 供给闸只有**一处产地** —— 这里读它,❌ 不拿同一批输入再推一遍。
  // 它曾经是 `canProvisionSessionpageAgent` 的德摩根对偶,内联在这里、相距约 130 行、而且**不调用**它:
  // 于是"改了那个有名字的函数"与"改了真正把门的这一条"是两件事,产品会静默地不跟着变。
  if (!canProvisionSessionpageAgent(info.providerId, info.surface)) return null
  // @@@4526 owner 删过这条会话的 agent ⇒ 这条会话此后**没有**可寻址身份,和上面那两道闸是同一种回答。
  //
  // 幂等键是花名册记录上缓存的 conversation id;owner 删除会把那条记录摘掉,于是"重开这条会话"与
  // "这是条全新会话"在下面就完全同形 —— 不拦的话它会重新开户,把用户亲手删掉的联系人再造一个回来
  // (实测:删除 → 切到会话页 → 切回通讯录,它带着 Online 又在列表里)。墓碑是唯一能把这两者区分开的
  // durable 事实:会话页会话仍然存在、仍然照跑(删联系人不该删掉用户的工作),它只是不再有 gugu 身份。
  // #5331 锁**外**这一段从前没有台账,于是「供给花了多久」在宿主段的读数里对不上:
  // `provision-begin` 是进锁之后才打的第一枪,鉴权、墓碑、排队全在它前面。
  const preLockAt = Date.now()
  const tombstoneOwner = (await deps.getAuth())?.userId
  const authMs = Date.now() - preLockAt
  const tombstoneAt = Date.now()
  if (await findReapedAgentForSession(info.sessionId, deps.env ?? process.env, tombstoneOwner)) return null
  const tombstoneMs = Date.now() - tombstoneAt
  const queuedAt = Date.now()
  return serialize(
    () => {
      const queueMs = Date.now() - queuedAt
      if (authMs + tombstoneMs + queueMs > 100) {
        provisionLogger.info(
          { label: `session ${info.sessionId}`, authMs, tombstoneMs, queueMs },
          'provision pre-lock — #5331',
        )
      }
      return provisionLocked(
        info,
        deps,
        resolveSessionpageDeliveryOwnerKind(info.providerId, info.surface),
      )
    },
    info.lifecycle === 'resume' ? 'background' : 'interactive',
    `session ${info.sessionId}`,
  )
}

async function provisionLocked(
  info: SessionpageSessionInfo,
  deps: SessionpageProvisionDeps,
  deliveryOwnerKind: SessionpageDeliveryOwnerKind,
): Promise<ProvisionedSessionpageAgent> {
  const env = deps.env ?? process.env
  // session-page provider id → gugu agent_type ('codex'→'codex', 'claude'→'claude-code'). The gate above only
  // admits providers normalizeAgentType knows, so this never throws for a session-page session.
  // A conversation under the implicit task-home project — or on a cloud computer — has no project AS FAR AS
  // THE USER IS CONCERNED, so it gets no group — its agent is just a DM contact (spec ⑨; groupProjectIdFor).
  const projectId = groupProjectIdFor(info.projectId, env)
  const mark = provisionStage(`session ${info.sessionId}`, Date.now())
  mark('provision-begin', { providerId: info.providerId, surface: info.surface })
  // #5331 后台那些云端回写要等前台把名册写完(读-改-写不加锁,撞车就是「Agent 不存在」)。
  let bindingDone: () => void = () => {}
  const afterBinding = new Promise<void>((resolve) => { bindingDone = resolve })
  try {
    return await provisionLockedBody(info, deps, deliveryOwnerKind, { env, projectId, mark, afterBinding })
  } finally {
    bindingDone()
  }
}

async function provisionLockedBody(
  info: SessionpageSessionInfo,
  deps: SessionpageProvisionDeps,
  deliveryOwnerKind: SessionpageDeliveryOwnerKind,
  ctx: {
    env: NodeJS.ProcessEnv
    projectId: string
    mark: ReturnType<typeof provisionStage>
    afterBinding: Promise<void>
  },
): Promise<ProvisionedSessionpageAgent> {
  const { env, projectId, mark, afterBinding } = ctx

  // 1. Idempotent resolve: a roster record already bound to this conversation → reuse it (session resume /
  //    reopen). Register the live binding and return without minting a second identity. chatId may be ''
  //    for an agent the owner never opened a private chat with — that is a legitimate state (@@@no-auto-dm).
  //    #4277 —— 会话不带账号:按(会话, **当下登录的账号**)找。命中别家的行 ⇒ 停放它、再找自己停放过的
  //    行恢复;都没有 ⇒ 下面第 2 步为当前账号登记一个新的。
  const ownerAuth = await deps.getAuth()
  if (!ownerAuth?.userId) throw new Error('session-page agent provisioning: owner not authenticated')
  const ownerUserId = ownerAuth.userId
  const roster = await listAgents(env, { includeGuests: true })
  mark('roster-loaded', { rosterSize: roster.length })
  const existing = await resolveOwnedBindingForSession(roster, info.sessionId, ownerAuth, deps, env)
  mark('owner-binding-resolved', { found: Boolean(existing) })
  if (existing) {
    /**
     * @@@no-auto-dm — 这里曾经(#3702 的 `@@@backfill-every-agent-has-a-chat`)给缓存里没有 chat 的存量
     * agent **补建**一条私聊。现在不补了:「没有私聊」是合法状态,不是待修的残缺(见 findOwnerDirectChat
     * 的长注释与 behavior conversation-list)。resume 时仍**查**一次 —— owner 后来自己开过私聊的,
     * 这一查就把锚接上;没开过就一直是 ''。
     * ❌ 有项目却缺群仍要补:群是「项目 = 群」的承载,不是可有可无的锚(那一支不在本次改动范围)。
     */
    const cachedProjectId = cacheString(existing.cache, PROJECT_CACHE_KEY)
    let directChatId = cacheString(existing.cache, DIRECT_CHAT_CACHE_KEY)
    // Compatibility migration: projectless records historically stored their DM in GROUP_CACHE_KEY.
    if (!directChatId && !cachedProjectId) directChatId = cacheString(existing.cache, GROUP_CACHE_KEY)
    const groupChatId = cachedProjectId === projectId && projectId
      ? cacheString(existing.cache, GROUP_CACHE_KEY)
      : ''
    const projectName = projectId ? await resolveProjectGroupName(deps, projectId) : ''
    // #5331 重开也不等云端:缓存里的群 / 私聊直接用;「群还在不在」「owner 后来开没开私聊」「有项目却缺群」
    // 三件事都是公网那一层的核对与补齐,放到后台做,结果回写名册,下次重开就对了。老代码在这里串着
    // 1–3 发云往返(groupIsUsable / findOwnerDirectChat / ensureProjectGroupMembership),全挡在 spawn 前。
    if (ownerAuth.accessToken && (groupChatId || !directChatId || (projectId && !groupChatId))) {
      startReuseBackfill({
        env,
        accessToken: ownerAuth.accessToken,
        ownerUserId,
        sessionId: info.sessionId,
        agentUserId: existing.gugu_user_id,
        projectId,
        projectName,
        groupChatId,
        directChatId,
        roster,
        afterBinding,
      })
    }
    mark('reuse-chats-resolved')
    // #5331 上次起会话时公网那一发没落地(pending = 进程半路死了 / failed = 重试完还是失败)⇒ 这次重开在后台再试一次。
    const cloudState = cacheString(existing.cache, CLOUD_STATE_CACHE_KEY)
    if (cloudState === 'pending' || cloudState === 'failed') {
      {
        const agentType = normalizeAgentType(info.providerId)
        const deviceId = Promise.resolve(deps.resolveDeviceId())
        deviceId.catch(() => undefined)
        startCloudProvision({
          oneTrip: deps.provisionOneTrip,
          env,
          ownerAuth: { accessToken: ownerAuth.accessToken ?? '', refreshToken: ownerAuth.refreshToken ?? '', userId: ownerUserId },
          sessionId: info.sessionId,
          projectId,
          guguAgentUserId: existing.gugu_user_id,
          displayName: existing.name ?? '',
          // #6396 这个名字早就发出去了(会话、agent 自己、owner 都拿它称呼这个身份),云端这一发只是补登记
          // ⇒ 保名:此刻没被占就原样收下(被占才从账本往上占号)。按 serial 递上去,服务端会把低于账本的号
          // 往上抬 —— 离线时先起的会话一重开就被改名。
          nameMode: 'explicit',
          agentType,
          deviceId,
          localPath: info.cwd || null,
          groupName: projectId ? projectName : null,
          groupChatId,
          afterBinding,
          provisionalLocalRow: false,
          // The creation's cloud send never landed, so this is still its first mint — it still joins where it was born.
          ...(deps.takeBirthGroup ? { birthGroup: () => deps.takeBirthGroup!(info.sessionId) } : {}),
        })
      }
    }
    await updateAgent({ guguUserId: existing.gugu_user_id }, {
      status: 'idle',
      cache: {
        ...(existing.cache ?? {}),
        [DIRECT_CHAT_CACHE_KEY]: directChatId,
        [GROUP_CACHE_KEY]: groupChatId,
        [PROJECT_CACHE_KEY]: projectId,
        [PROVIDER_CACHE_KEY]: info.providerId,
        [SURFACE_CACHE_KEY]: info.surface,
        [OWNER_CACHE_KEY]: ownerUserId,
      },
    }, env)
    mark('reuse-roster-updated')
    await prepareSessionpageDeliveryOwner(deliveryOwnerKind, {
      guguAgentUserId: existing.gugu_user_id,
      sessionId: info.sessionId,
    }, { providerId: info.providerId })
    mark('reuse-delivery-owner-ready')
    const event = {
      sessionId: info.sessionId,
      agentUserId: existing.gugu_user_id,
      displayName: existing.name ?? '',
      chatId: directChatId,
    }
    if (!info.deferProvisionedEvent) emitProvisioned(event)
    return {
      guguAgentUserId: existing.gugu_user_id,
      chatId: directChatId,
      ...(projectId && groupChatId
        ? { projectContext: { projectId, projectName, projectPath: info.cwd, groupChatId, groupName: projectName } }
        : {}),
      event,
    }
  }

  // 2. Fresh provision: a new identity (local-first) or one the caller names (adopt).
  //    This session caller adds project/session binding and a delivery owner below.
  if (!ownerAuth.accessToken) throw new Error('session-page agent provisioning: owner not authenticated')
  // 第 19 条:这条会话上一个身份开户失败被撤了 ⇒ 铸新身份之前先收它的卡,新身份才要得到卡。铸新身份与接既有身份都从这里过。
  const withdrawn = withdrawnIdentityBySession.get(info.sessionId)
  if (withdrawn) {
    await revokeAgentCards?.(withdrawn)
    withdrawnIdentityBySession.delete(info.sessionId)
  }
  // #5331 内网身份即刻、公网身份后台:本机预生成 id / 名字 / 群 id,会话立刻起;铸身份 + 云端名字去重 +
  // 进群/建群合成一次往返在后台跑(provision_taskpage_agent)。
  let guguAgentUserId: string
  let directChatId: string
  let displayName: string
  let identityCreated: boolean
  let projectName = ''
  let groupChatId = ''
  if (!info.agentUserId?.trim()) {
    const fresh = await provisionFreshLocalFirst(info, deps, { env, ownerAuth: { accessToken: ownerAuth.accessToken, refreshToken: ownerAuth.refreshToken, userId: ownerUserId }, roster, projectId, mark, afterBinding })
    guguAgentUserId = fresh.guguAgentUserId
    displayName = fresh.displayName
    groupChatId = fresh.groupChatId
    projectName = fresh.projectName
    directChatId = ''
    identityCreated = true
    mark('identity-provisioned', { created: true, localFirst: true })
    mark('project-group-ensured', { hasProject: Boolean(projectId), localFirst: true })
  } else {
  // 启动提速 —— 群的第一拍(项目名 + 群在不在/还能不能用)只依赖项目,与接身份并行;没有项目就
  // 什么都不发。这一拍是只读的(归档映射的清理挪到了 joinProjectGroup 建新群那一刻),所以身份那边
  // 失败时它没有留下任何副作用;Promise.all 让任一失败都当场 fail-loud。
  const [identity, group] = await Promise.all([
    adoptSessionpageAgentIdentityLocked(
      {
        agentUserId: info.agentUserId,
        displayName: info.displayName,
        agentType: info.providerId,
        projectPath: info.cwd,
        chatId: info.chatId,
        roster,
      },
      deps,
    ),
    projectId
      ? Promise.all([
          resolveProjectGroupName(deps, projectId),
          prepareProjectGroup(ownerAuth.accessToken, ownerUserId, projectId, roster, env),
        ]).then(([projectName, prepared]) => ({ projectName, prepared }))
      : null,
  ])
  guguAgentUserId = identity.guguAgentUserId
  directChatId = identity.chatId
  displayName = identity.displayName
  identityCreated = false
  mark('identity-provisioned', { created: false })

  // 3. spec ⑨ — 项目 = 群。有项目的会话 → 进该项目的 gugu 群(owner 旁观其 agent 互发的场所);无项目的
  //    会话 → owner 与它的**私聊**。
  //
  // @@@no-auto-dm — 无项目的会话**不自动获得私聊**(owner 2026-07-24,behavior session-fork-share /
  // conversation-list)。群照建:项目 = 群,群是 agent 互发与 owner 旁观的场所,不建就没有那个场所;
  // 私聊不建:它不承载会话页的对话(对话在任务会话里),只有 owner 真去开的那一刻才有意义。
  // 「有没有私聊」由上面的 findOwnerDirectChat 只读地回答 —— `''` 是合法答案,不是待补的残缺。
  projectName = group?.projectName ?? ''
  groupChatId = group ? await joinProjectGroup(group.prepared, guguAgentUserId, projectName) : ''
  mark('project-group-ensured', { hasProject: Boolean(projectId) })
  }

  // Stamp the binding onto the roster record (SSOT for idempotent resolve, boot re-registration, and
  // cascade-delete reaping by project). Projectless → project/group empty.
  await updateAgent(
    { guguUserId: guguAgentUserId },
    {
      cache: {
        [DIRECT_CHAT_CACHE_KEY]: directChatId,
        [SESSION_CACHE_KEY]: info.sessionId,
        [GROUP_CACHE_KEY]: groupChatId,
        [PROJECT_CACHE_KEY]: projectId,
        [PROVIDER_CACHE_KEY]: info.providerId,
        [SURFACE_CACHE_KEY]: info.surface,
        [OWNER_CACHE_KEY]: ownerUserId,
        // #5331 公网身份落没落地。接来的既有身份本就在云端 = ready;本机先起的行以后台那一发的当下状态为准。
        [CLOUD_STATE_CACHE_KEY]: cloudStateByAgent.get(guguAgentUserId) ?? 'ready',
      },
    },
    env,
  )

  mark('roster-binding-stamped')
  // Register the live binding — the whole point (was: only the test hook did this).
  await prepareSessionpageDeliveryOwner(deliveryOwnerKind, {
    guguAgentUserId,
    sessionId: info.sessionId,
  }, { providerId: info.providerId })
  mark('delivery-owner-ready')
  const event = {
    sessionId: info.sessionId,
    agentUserId: guguAgentUserId,
    displayName,
    chatId: directChatId,
  }
  if (!info.deferProvisionedEvent) emitProvisioned(event)
  return {
    guguAgentUserId,
    chatId: directChatId,
    // 刚铸的身份:persona 必然为空 —— 不必再去库里读。
    ...(identityCreated ? { agentIdentityFacts: { specialFocus: null } } : {}),
    ...(projectId && groupChatId
      ? { projectContext: { projectId, projectName, projectPath: info.cwd, groupChatId, groupName: projectName } }
      : {}),
    event,
  }
}

/**
 * #5331 全新身份的一次往返供给。失败照旧 fail-loud。
 * 名字:先按本机名册去重(spec agent-provisioning 的那条规则),云端那一半(#4277 名册重置场景)由服务端补。
 * 群:映射里的群 id 与「要建就用这个」的新 id 都由客户端预生成递上去,服务端核状态后二选一,与 joinProjectGroup 同形。
 */
/**
 * #5331 内网身份即刻:本机预生成 agent id + 按本机名册取名 + 群 id(映射里有就用它,没有就预生成),写名册、
 * 写 runtime session,立刻返回让会话起来;公网那一发(铸身份 + 云端名字去重 + 进群/建群,一次往返)登记到后台。
 */
async function provisionFreshLocalFirst(
  info: SessionpageSessionInfo,
  deps: SessionpageProvisionDeps,
  ctx: {
    env: NodeJS.ProcessEnv
    ownerAuth: { accessToken: string; refreshToken: string; userId: string }
    roster: Awaited<ReturnType<typeof listAgents>>
    projectId: string
    mark: ReturnType<typeof provisionStage>
    afterBinding: Promise<void>
  },
): Promise<{ guguAgentUserId: string; displayName: string; groupChatId: string; projectName: string }> {
  const { env, ownerAuth, roster, projectId, mark, afterBinding } = ctx
  const agentType = normalizeAgentType(info.providerId)
  // 设备 id 是**铸公网身份**的入参(death-bind),本机身份不需要它 —— 冷的那一次是一发云往返
  // (gugu_devices 查询,440ms 的库上实测 0.49 s)。❌ 不 await:整个交给后台那一发,连同它的失败。
  const deviceIdPromise = Promise.resolve(deps.resolveDeviceId())
  deviceIdPromise.catch(() => undefined)
  const [projectName, mappedGroupId] = await Promise.all([
    projectId ? resolveProjectGroupName(deps, projectId) : Promise.resolve(''),
    projectId
      ? readProjectGroupId(projectId, ownerAuth.userId, env).then((id) => id || findGroupIdForProject(roster, projectId, ownerAuth.userId) || '')
      : Promise.resolve(''),
  ])
  mark('identity-inputs-loaded', { rosterSize: roster.length, minting: true, localFirst: true })
  // #6396 序号只增不减:起点 = max(服务端账本记的这个前缀用到几号, 本机名册里归这个账号的最大号) + 1。
  // 账本落后时服务端会往上抬(会话起来后再改名),所以每铸一次都在后台把账本再取一次,给下一条会话用。
  const rosterNames = agentsForOwner(roster, ownerAuth.userId).map((a) => ({ display_name: a.name }))
  const requested = info.displayName?.trim() || ''
  const label = getAgentTypeLabel(agentType)
  const displayName = requested
    ? uniqueAgentDisplayName(rosterNames, requested)
    : nextAgentDefaultName(rosterNames, label, { floor: serialFloor(ownerAuth.userId, label) })
  noteAgentName(ownerAuth.userId, displayName, label)
  refreshSerialFloors(ownerAuth, deps.listAgentNameSerials)
  const guguAgentUserId = randomUUID()
  const groupChatId = projectId ? (mappedGroupId || randomUUID()) : ''
  // 刚铸出来的身份必然没有私聊(@@@no-auto-dm)。
  directChatMemo.set(guguAgentUserId, { chatId: '', at: Date.now() })
  cloudStateByAgent.set(guguAgentUserId, 'pending')
  const local = await createAgent(
    { name: displayName, agent_type: agentType, path: info.cwd || '', gugu_user_id: guguAgentUserId, prompt: '' },
    env,
  )
  await updateAgent({ guguUserId: guguAgentUserId }, {
    cache: {
      ...(local.cache ?? {}),
      [DIRECT_CHAT_CACHE_KEY]: '',
      [OWNER_CACHE_KEY]: ownerAuth.userId,
      [CLOUD_STATE_CACHE_KEY]: 'pending',
    },
  }, env)
  mark('local-roster-written', { localFirst: true })
  await writeAgentRuntimeSession(
    { accessToken: ownerAuth.accessToken, refreshToken: ownerAuth.refreshToken, agentUserId: guguAgentUserId },
    env,
  )
  mark('runtime-session-written')
  // 群 id 现在就记进映射:背靠背起的下一条会话(同一把锁后面排着)拿到同一个 id,服务端撞主键改加座位。
  if (projectId && groupChatId) await rememberProjectGroupId(projectId, groupChatId, ownerAuth.userId, env)
  mark('local-identity-ready', { localFirst: true })

  startCloudProvision({
    oneTrip: deps.provisionOneTrip,
    env,
    ownerAuth,
    sessionId: info.sessionId,
    projectId,
    guguAgentUserId,
    displayName,
    nameMode: requested ? 'explicit' : 'serial',
    agentType,
    deviceId: deviceIdPromise,
    localPath: info.cwd || null,
    groupName: projectId ? projectName : null,
    groupChatId,
    afterBinding,
    provisionalLocalRow: true,
    ...(deps.takeBirthGroup ? { birthGroup: () => deps.takeBirthGroup!(info.sessionId) } : {}),
  })
  return { guguAgentUserId, displayName, groupChatId, projectName }
}

let cloudProvisionRetryDelaysMs: readonly number[] = [2_000, 8_000]
/** 只给单测:把重试间隔压到 0。 */
export function setCloudProvisionRetryDelaysForTests(delays: readonly number[]): void {
  cloudProvisionRetryDelaysMs = delays
}

/**
 * 公网那一发,在会话已经起来之后跑。成功:名字 / 群 id 以服务端为准回写名册,发「身份就绪」通知;
 * 失败(重试两次之后):记 failed、响亮打日志 —— 会话照跑,只是分享 / 云端投递这些**公网能力**不可用,
 * 下次重开这条会话再试。❌ 不拿供给锁:锁是给交互路径排队用的,后台一发云往返不该挡下一条会话。
 */
function startCloudProvision(job: {
  oneTrip: SessionpageProvisionDeps['provisionOneTrip']
  env: NodeJS.ProcessEnv
  ownerAuth: { accessToken: string; refreshToken: string; userId: string }
  sessionId: string
  projectId: string
  guguAgentUserId: string
  displayName: string
  nameMode: 'serial' | 'explicit'
  agentType: ReturnType<typeof normalizeAgentType>
  /** 设备 id 冷解析是一发云往返 ⇒ 它也在后台等,❌ 不挡会话。 */
  deviceId: string | Promise<string | null>
  localPath: string | null
  groupName: string | null
  groupChatId: string
  /** 前台把绑定盖章写完名册之后才 resolve:后台回写名册不能与前台的读-改-写撞车(实机撞出过「Agent 不存在」)。 */
  afterBinding: Promise<void>
  /**
   * #5419 这一行是**这一次创建**刚预生成的、云端还没有对应物 ⇒ 铸不出来时它没有资格留下。
   * 复用路径上的行不是:那种行可能有一个我们此刻看不见的云端孪生(上一轮 RPC 落库、进程在回写
   * 'ready' 之前死了),删它会把公网那一半变成真孤儿 ⇒ 那条路仍然只记 'failed',下次重开再试。
   */
  provisionalLocalRow: boolean
  /** The chat it was born in — given only while the identity has never landed (its creation, or a retry of it). */
  birthGroup?: () => Promise<BirthGroup | null | undefined>
}): void {
  const log = createLogger('sessionpage/provision')
  // 同一个身份只许有一发在途。❌ 少了这道闸就会并发铸两次:会话本体起了一发,平台令牌那条腿随后走
  // 复用路径、看到状态还是 pending 又补一发,两发撞同一个 agent id ⇒ 第二发必败、重试到底、把这个
  // 身份标成 failed,会话跟着起不来(#5331 实测:opencode + 咕咕自营模型 120 s 起不来)。
  if (cloudWorkByAgent.has(job.guguAgentUserId)) return
  const startedAt = Date.now()
  cloudStateByAgent.set(job.guguAgentUserId, 'pending')
  const work = (async () => {
    const deviceId = await job.deviceId
    if (!deviceId) {
      throw new Error('session-page agent provisioning: local device id unresolved (runtime not registered yet)')
    }
    let minted: ProvisionedSessionpageAgentOneTrip | null = null
    for (let attempt = 0; ; attempt++) {
      try {
        minted = await job.oneTrip({
          supabaseUrl: getSupabaseUrl(),
          anonKey: getSupabaseAnonKey(),
          accessToken: job.ownerAuth.accessToken,
          agentId: job.guguAgentUserId,
          displayName: job.displayName,
          nameMode: job.nameMode,
          agentType: job.agentType,
          deviceId,
          localPath: job.localPath,
          groupName: job.groupName,
          priorGroupChatId: job.groupChatId || null,
          newGroupChatId: job.groupName ? randomUUID() : null,
        })
        break
      } catch (error) {
        const delay = cloudProvisionRetryDelaysMs[attempt]
        if (delay === undefined) throw error
        log.warn(
          { sessionId: job.sessionId, agentUserId: job.guguAgentUserId, attempt, error: (error as Error).message },
          '#5331 cloud identity provisioning failed — retrying',
        )
        await new Promise((resolve) => setTimeout(resolve, delay))
      }
    }
    if (!minted) throw new Error('unreachable')
    noteAgentName(job.ownerAuth.userId, minted.displayName, getAgentTypeLabel(job.agentType))
    await job.afterBinding
    const patch: Record<string, unknown> = {}
    if (minted.displayName !== job.displayName) patch.name = minted.displayName
    const resolved = resolveProvisionedProjectGroup(job, minted)
    const groupChatId = resolved.groupChatId
    if (resolved.kind === 'pending-approval') {
      log.info(
        { sessionId: job.sessionId, agentUserId: job.guguAgentUserId, groupChatId: job.groupChatId },
        'project group requires approval for Agents — join request queued, agent not in the group yet',
      )
    } else if (resolved.kind === 'remapped') {
      // 映射里的群已归档、或不是这个账号所在的群(foreign)⇒ 服务端另建了一个:映射与名册都改指新群。会话启动时拿到的旧 id 留在它的系统块里,
      // 那是一个归档群 —— 与老链上「归档群在 provisioning 之外发生」同一形状,下次重开就对了。
      await forgetProjectGroupId(job.projectId, job.ownerAuth.userId, job.env)
      await rememberProjectGroupId(job.projectId, groupChatId, job.ownerAuth.userId, job.env)
    }
    // Born in a chat — joined now, once, while the identity is new: what reads this agent's groups waits for this
    // work (awaitSessionpageCloudIdentity), so its first session already counts that group.
    if (job.birthGroup) await joinBirthGroup(job.ownerAuth.accessToken, job.ownerAuth.userId, await job.birthGroup(), job.guguAgentUserId, log)
    const current = (await listAgents(job.env, { includeGuests: true })).find((a) => a.gugu_user_id === job.guguAgentUserId)
    await updateAgent({ guguUserId: job.guguAgentUserId }, {
      ...patch,
      cache: {
        ...(current?.cache ?? {}),
        [GROUP_CACHE_KEY]: groupChatId,
        [CLOUD_STATE_CACHE_KEY]: 'ready',
      },
    }, job.env)
    cloudStateByAgent.set(job.guguAgentUserId, 'ready')
    log.info(
      {
        sessionId: job.sessionId,
        agentUserId: job.guguAgentUserId,
        displayName: minted.displayName,
        renamed: minted.displayName !== job.displayName,
        groupChatId,
        groupCreated: minted.groupCreated,
        priorGroupState: minted.priorGroupState,
        tookMs: Date.now() - startedAt,
      },
      '#5331 cloud identity landed',
    )
    const pending = pendingProvisionedEvents.get(job.sessionId)
    pendingProvisionedEvents.delete(job.sessionId)
    const renamed = minted.displayName !== job.displayName ? { renamedFrom: job.displayName } : {}
    emitProvisioned(pending
      ? { ...pending, displayName: minted.displayName, ...renamed }
      : { sessionId: job.sessionId, agentUserId: job.guguAgentUserId, displayName: minted.displayName, chatId: '', ...renamed })
  })()
  const tracked = work
    .catch(async (error: unknown) => {
      cloudStateByAgent.set(job.guguAgentUserId, 'failed')
      pendingProvisionedEvents.delete(job.sessionId)
      log.error(
        {
          sessionId: job.sessionId,
          agentUserId: job.guguAgentUserId,
          error: error instanceof Error ? error.message : String(error),
          tookMs: Date.now() - startedAt,
          withdrewLocalRow: job.provisionalLocalRow,
        },
        job.provisionalLocalRow
          // #5419 会话本体照跑,但它此后没有 gugu 身份 —— ❌ 不留一个服务端查不到、却在名册里占着名字的联系人。
          ? '#5331/#5419 cloud identity provisioning failed — withdrawing the local row this creation pre-generated; the session keeps running without a gugu identity'
          : '#5331 cloud identity provisioning failed — the session keeps running on its local identity; public-facing capabilities stay unavailable until the next start',
      )
      try {
        await job.afterBinding
        if (job.provisionalLocalRow) {
          // 一次创建从用户视角是一个事务:公网身份没铸出来 ⇒ 这次创建没有产生 agent。
          // identityRemoved:false —— 云端那一行**从来没存在过**,这不是删除,不立碑:
          // 这条会话下次起来照常重新开户(「随后落地被接纳」的另一支)。
          await releaseAgentLocalFootprint({ agentUserId: job.guguAgentUserId, identityRemoved: false, env: job.env })
          withdrawnIdentityBySession.set(job.sessionId, job.guguAgentUserId)
        } else {
          const current = (await listAgents(job.env, { includeGuests: true })).find((a) => a.gugu_user_id === job.guguAgentUserId)
          await updateAgent({ guguUserId: job.guguAgentUserId }, {
            cache: { ...(current?.cache ?? {}), [CLOUD_STATE_CACHE_KEY]: 'failed' },
          }, job.env)
        }
      } catch { /* 名册写不进去就只剩日志 */ }
      throw error
    })
    .finally(() => {
      if (cloudWorkByAgent.get(job.guguAgentUserId) === tracked) cloudWorkByAgent.delete(job.guguAgentUserId)
    })
  // 没人 await 的那份不能变成 unhandled rejection;awaitSessionpageCloudIdentity 会拿到同一个 promise。
  tracked.catch(() => undefined)
  cloudWorkByAgent.set(job.guguAgentUserId, tracked)
}

/**
 * #5331 重开会话时公网那一层的核对与补齐,在会话已经起来之后跑:群归档了就换群、私聊后来开了就接上、
 * 有项目却没群就补群。全部回写名册;失败只打日志(下次重开再试),❌ 不影响这条会话。不拿供给锁。
 */
function startReuseBackfill(job: {
  env: NodeJS.ProcessEnv
  accessToken: string
  ownerUserId: string
  sessionId: string
  agentUserId: string
  projectId: string
  projectName: string
  groupChatId: string
  directChatId: string
  roster: Awaited<ReturnType<typeof listAgents>>
  afterBinding: Promise<void>
}): void {
  const log = createLogger('sessionpage/provision')
  const work = (async () => {
    let { groupChatId, directChatId } = job
    if (groupChatId) {
      const state = await groupIsUsable(makeChatClient(job.accessToken), groupChatId)
      if (state !== 'active') {
        log.info(
          { sessionId: job.sessionId, chatId: groupChatId, state },
          '#4277 cached project group is no longer usable — re-ensuring the group for this agent',
        )
        groupChatId = ''
      }
    }
    if (!directChatId) directChatId = await findOwnerDirectChatMemoized(job.accessToken, job.agentUserId)
    if (job.projectId && !groupChatId) {
      groupChatId = await ensureProjectGroupMembership(
        job.accessToken, job.ownerUserId, job.agentUserId, job.projectId, job.projectName, job.roster, job.env,
      )
    }
    if (groupChatId === job.groupChatId && directChatId === job.directChatId) return
    await job.afterBinding
    const current = (await listAgents(job.env, { includeGuests: true })).find((a) => a.gugu_user_id === job.agentUserId)
    if (!current) return
    await updateAgent({ guguUserId: job.agentUserId }, {
      cache: { ...(current.cache ?? {}), [DIRECT_CHAT_CACHE_KEY]: directChatId, [GROUP_CACHE_KEY]: groupChatId },
    }, job.env)
    log.info(
      { sessionId: job.sessionId, agentUserId: job.agentUserId, groupChatId, directChatId: Boolean(directChatId) },
      '#5331 reuse backfill landed',
    )
  })()
  const tracked = work
    .catch((error: unknown) => {
      log.warn(
        { sessionId: job.sessionId, agentUserId: job.agentUserId, error: error instanceof Error ? error.message : String(error) },
        '#5331 reuse backfill failed — cached chats stay as they were until the next start',
      )
    })
    .finally(() => {
      if (reuseBackfillByAgent.get(job.agentUserId) === tracked) reuseBackfillByAgent.delete(job.agentUserId)
    })
  reuseBackfillByAgent.set(job.agentUserId, tracked)
}
const reuseBackfillByAgent = new Map<string, Promise<void>>()

type RosterRow = Awaited<ReturnType<typeof listAgents>>[number]

/**
 * #4277 按(会话, 当前账号)找名册行。返回可直接走复用路径的那一行(绑定已在 emdash_session_id 上),
 * 或 undefined(该为当前账号新登记)。副作用只有两种:把别家的活动行停放、把自己停放过的行恢复。
 *
 * 判「归谁」:行上记了 owner 就认它;老行没记 ⇒ 有探针就问云端一次,没探针按「归我」认领。
 */
async function resolveOwnedBindingForSession(
  roster: RosterRow[],
  sessionId: string,
  ownerAuth: { accessToken: string; refreshToken: string; userId: string },
  deps: SessionpageProvisionDeps,
  env: NodeJS.ProcessEnv,
): Promise<RosterRow | undefined> {
  const ownerUserId = ownerAuth.userId
  const isMine = async (agent: RosterRow): Promise<boolean> => {
    const recorded = cacheString(agent.cache, OWNER_CACHE_KEY)
    if (recorded) return agentsForOwner([agent], ownerUserId, { includeArchived: true }).length > 0
    if (!deps.isAgentOwnedByCurrentUser) return true
    return deps.isAgentOwnedByCurrentUser(agent.gugu_user_id)
  }

  roster = agentsForOwner(roster, null, { includeArchived: true })
  const active = roster.find(
    (agent) => agent.gugu_user_id && cacheString(agent.cache, SESSION_CACHE_KEY) === sessionId,
  )
  if (active) {
    if (await isMine(active)) return active
    await parkSessionpageAgentBinding(active, sessionId, env)
  }
  for (const parked of roster) {
    if (!parked.gugu_user_id || parked === active) continue
    if (cacheString(parked.cache, PARKED_SESSION_CACHE_KEY) !== sessionId) continue
    if (!(await isMine(parked))) continue
    return unparkSessionpageAgentBinding(parked, sessionId, ownerAuth, env)
  }
  return undefined
}

/** 停放:绑定挪到 parked 格、摘掉进程内的投递注册与 registry 项。名册行、云端身份一字不动。 */
async function parkSessionpageAgentBinding(agent: RosterRow, sessionId: string, env: NodeJS.ProcessEnv): Promise<void> {
  const cache: Record<string, unknown> = { ...(agent.cache ?? {}) }
  delete cache[SESSION_CACHE_KEY]
  cache[PARKED_SESSION_CACHE_KEY] = sessionId
  await updateAgent({ guguUserId: agent.gugu_user_id }, { cache }, env)
  emdashAgentRegistry.unregister(agent.gugu_user_id)
  unregisterLocalSessionDeliveryForAgent(agent.gugu_user_id, sessionId)
  createLogger('sessionpage/provision').info(
    { sessionId, agentUserId: agent.gugu_user_id },
    '#4277 parked another account agent binding; the current account gets its own',
  )
}

/** 恢复:自己停放过的行把绑定挪回来。复用路径随后重新登记投递归属与 registry。
 *  换账号时运行态文件已被清(clearLocalAgentRuntimesForOwnerChange),这里用当下的 token 重写一份。 */
async function unparkSessionpageAgentBinding(
  agent: RosterRow,
  sessionId: string,
  ownerAuth: { accessToken: string; refreshToken: string; userId: string },
  env: NodeJS.ProcessEnv,
): Promise<RosterRow> {
  const cache: Record<string, unknown> = { ...(agent.cache ?? {}) }
  delete cache[PARKED_SESSION_CACHE_KEY]
  cache[SESSION_CACHE_KEY] = sessionId
  cache[OWNER_CACHE_KEY] = ownerAuth.userId
  await updateAgent({ guguUserId: agent.gugu_user_id }, { cache }, env)
  await writeAgentRuntimeSession(
    { accessToken: ownerAuth.accessToken, refreshToken: ownerAuth.refreshToken, agentUserId: agent.gugu_user_id },
    env,
  )
  createLogger('sessionpage/provision').info(
    { sessionId, agentUserId: agent.gugu_user_id },
    '#4277 restored the current account parked agent binding',
  )
  return { ...agent, cache }
}

/** Resolve the project's display name for its group; best-effort — a lookup hiccup must not fail session
 *  start, so fall back to a stable name derived from the project id. */
async function resolveProjectGroupName(deps: SessionpageProvisionDeps, projectId: string): Promise<string> {
  let name: string | null | undefined = null
  try {
    name = await deps.resolveProjectName?.(projectId)
  } catch {
    // fall through to fallback
  }
  return projectGroupDisplayName(name, projectId)
}

/** 项目群的群名:项目名(截 60 字);没有名字就按项目 id 起一个稳定的。#7341 项目群绑定建群时用同一个口径。 */
export function projectGroupDisplayName(projectName: string | null | undefined, projectId: string): string {
  if (projectName && projectName.trim()) return projectName.trim().slice(0, 60)
  return `${FALLBACK_PROJECT_GROUP_NAME} ${projectId.slice(0, 8)}`
}

/**
 * spec ⑨「项目 = 群」:resolve the gugu group mirroring THIS session-page project (one group per project) and make
 * the agent an active-listening member. Creates the group named after the project on first use; adds the
 * agent to the project's existing group otherwise (the human owner is the group creator, so RLS
 * members_insert_group_manager permits the insert). The owner is a member, so they can watch the project's
 * agents talk to each other as an ordinary group chat.
 */
/**
 * @@@no-auto-dm — 会话页 agent 的私聊**只找不建**(取代 #3702 的 `@@@every-agent-has-a-chat`)。
 *
 * behavior 的 [session-fork-share]「不自动开私聊 ⇒ 不进会话列表」(owner 2026-07-24)与
 * [conversation-list]:自动建出来的 agent 不自动获得私聊,用户确实想单独拎一个出来聊时,**那一刻**
 * 才开(renderer 的 `chat.getOrCreateDM` 就是那一刻)。会话页每开一件活就多一个 agent、agent 还能
 * 再开子 agent —— provision 时一律 `open_dm`,空私聊就随 agent 数线性增长。
 *
 * #3702 当初改成 provision 即开,理由是工具会从会话绑定推导 chat。现在 message/workspace 工具都要求模型
 * 显式传目标 chat_id，私聊不再是任何 MCP 能力的隐式地址；投递路由仍按 **agentUserId** 走。
 * ⇒ 这里只做一次**只读**查询，供需要展示或投递地址的产品面使用；没有私聊就是没有(`''`)，❌ 不顺手建一条。
 *
 * ❌ 不用 `open_dm`(那是 find-or-create,会建);❌ 也不能只按「agent 在哪些 chat 里」取第一条 ——
 * 有项目的 agent 同时是项目群的成员,不按 kind 收口会把群误当成私聊。
 */
async function findOwnerDirectChat(accessToken: string, guguAgentUserId: string): Promise<string> {
  const chat = makeChatClient(accessToken)
  // RLS 策略 `members_select_peer` = `USING (chat.is_member(chat_id))`:owner 只看得见**自己也在其中**的
  // chat 的成员行。所以「这个 agent 的成员行」天然就是「owner 与它共处的 chat」——不会捞到 agent 与别人
  // 的会话。这条等价关系是本函数的前提,那条策略改了要回来复核。
  const { data: memberships, error: membershipError } = await chat
    .from('chat_members')
    .select('chat_id')
    .eq('user_id', guguAgentUserId)
  if (membershipError) {
    throw new Error(`session-page agent provisioning: dm lookup failed for ${guguAgentUserId}: ${membershipError.message}`)
  }
  const chatIds = ((memberships as { chat_id: string }[] | null) ?? []).map((row) => row.chat_id)
  if (!chatIds.length) return ''
  const { data: chats, error: chatsError } = await chat
    .from('chats')
    .select('id')
    .in('id', chatIds)
    .in('kind', ['dm', 'ai'])
    .in('status', ['active', 'stopped', 'paused'])
    .limit(1)
  if (chatsError) {
    throw new Error(`session-page agent provisioning: dm lookup failed for ${guguAgentUserId}: ${chatsError.message}`)
  }
  return ((chats as { id: string }[] | null) ?? [])[0]?.id ?? ''
}

/**
 * @@@chat-page-dm — 聊天页「新建 Agent」的私聊，在 ensure-agent-address 那个 seam 显式开。
 * 这不是 provision 自动开（#4121 @@@no-auto-dm 禁的那种）：走到这里的只有聊天页首条消息一条路
 * （use-create-session-callback → sessionpage:ensure-agent-address），即 owner「真去开私聊」的那一刻，
 * 而私聊正是这条路的消息容器（sendMessageToChat / openAgentChat 都以它为地址）。
 * `open_dm` 幂等（find-or-create）；开出来写回 roster 缓存，后续 resume 的只读查询直接命中。
 *
 * 私聊地址是**公网身份的派生物**（spec agent-provisioning「身份分两层」）：`open_dm` 按目标 id 查的正是
 * `identity.users` 那一行，而 #5331 之后那一行由后台车道铸。所以这里先等它落地再发 RPC——等在**派生私聊
 * 这一个 seam** 上，而不是让每个调用方各自记得等：ensure-agent-address 与聊天页首轮的启动信封是同一个
 * 派生动作的两个入口。公网身份铸失败即原样抛出，❌ 不交出一个服务端查不到目标的地址。
 * 顺带把读-改-写也排开了：下面写回 roster 的那一笔不再与后台那一发撞车。
 */
export async function openOwnerDirectChatForAgent(
  guguAgentUserId: string,
  accessToken: string,
  env: NodeJS.ProcessEnv,
): Promise<string> {
  const target = guguAgentUserId.trim()
  if (!target) throw new Error('session-page agent address: agent identity is empty')
  await awaitSessionpageCloudIdentity(target)
  const { data, error } = await makeChatClient(accessToken).rpc('open_dm', { p_target_user_id: target })
  if (error) throw new Error(`session-page agent address: open_dm failed for ${target}: ${error.message}`)
  const chatId = typeof data === 'string' ? data.trim() : ''
  if (!chatId) throw new Error(`session-page agent address: open_dm returned no chat for ${target}`)
  const record = (await listAgents(env, { includeGuests: true }))
    .find((agent) => agent.gugu_user_id === target)
  if (!record) throw new Error(`session-page agent address: no roster row for ${target}`)
  await updateAgent({ guguUserId: target }, {
    cache: { ...(record.cache ?? {}), [DIRECT_CHAT_CACHE_KEY]: chatId },
  }, env)
  return chatId
}

async function ensureProjectGroupMembership(
  accessToken: string,
  ownerUserId: string,
  guguAgentUserId: string,
  projectId: string,
  groupName: string,
  roster: Awaited<ReturnType<typeof listAgents>>,
  env: NodeJS.ProcessEnv,
): Promise<string> {
  const prepared = await prepareProjectGroup(accessToken, ownerUserId, projectId, roster, env)
  return joinProjectGroup(prepared, guguAgentUserId, groupName)
}

/** 「这个项目的群在哪、还能不能用」—— 只依赖项目,不依赖 agent。 */
interface PreparedProjectGroup {
  chat: ReturnType<typeof makeChatClient>
  ownerUserId: string
  projectId: string
  env: NodeJS.ProcessEnv
  /** 可以直接加座位的既有群;'' = 要新建。 */
  activeGroupId: string
  /** 映射里指着的那个群已归档:建新群时把这条映射忘掉。 */
  archivedGroupId: string
  /**
   * #7341 映射里指着一个云端还没有的群 = 预留的 id(本机先起的那一拍记下、云端那一发还没落地;或另一台机器的项目并进来时
   * 记下的)。第一个 agent 用**这个 id** 把群建出来 —— 与服务端 provision_taskpage_agent 的 'missing' 一支同口径;
   * ❌ 另起一个新 id(那样两台机器各记各的群,一个项目裂成两个)。
   */
  reservedGroupId: string
}

/**
 * 启动提速 —— 入群拆成两拍。这一拍(查映射 + 群还在不在)只看项目、**只读**,与铸身份并行跑;
 * 下一拍(加座位 / 建群)才需要 agent id。串在一起时它是关键路径上又一次云往返。
 */
async function prepareProjectGroup(
  accessToken: string,
  ownerUserId: string,
  projectId: string,
  roster: Awaited<ReturnType<typeof listAgents>>,
  env: NodeJS.ProcessEnv,
): Promise<PreparedProjectGroup> {
  const chat = makeChatClient(accessToken)
  // 群的寿命属于项目,不属于某个 agent 实例 → 先问那份与 agent 生命周期无关的映射;它没有再退回 roster
  // (老数据只记在 roster 上)。只依赖 roster 时,项目里最后一个 agent 被摘掉映射就没了,同一项目下次开
  // 会话又建一个新群(实机上攒出过两个同名群)。
  const priorGroupId = (await readProjectGroupId(projectId, ownerUserId, env)) || findGroupIdForProject(roster, projectId, ownerUserId)
  const priorState = priorGroupId ? await groupIsUsable(chat, priorGroupId) : 'missing'
  return {
    chat, ownerUserId, projectId, env,
    activeGroupId: priorGroupId && priorState === 'active' ? priorGroupId : '',
    archivedGroupId: priorGroupId && priorState === 'archived' ? priorGroupId : '',
    reservedGroupId: priorGroupId && priorState === 'missing' ? priorGroupId : '',
  }
}

async function joinProjectGroup(
  prepared: PreparedProjectGroup,
  guguAgentUserId: string,
  groupName: string,
): Promise<string> {
  const { chat, ownerUserId, projectId, env } = prepared
  const priorGroupId = prepared.activeGroupId
  if (prepared.archivedGroupId) {
    // 群在 provisioning 之外被归档了(见 groupIsUsable):映射忘掉,下面按「没有群」另建一个。
    createLogger('sessionpage/provision').info(
      { projectId, chatId: prepared.archivedGroupId },
      '#4277 mapped project group is archived — forgetting the mapping and creating a fresh group',
    )
    await forgetProjectGroupId(projectId, ownerUserId, env)
  }
  const takeSeat = async (groupId: string): Promise<string> => {
    const admin = createGroupAdmin(chat, ownerUserId)
    // 任务 agent 进项目群坐任务座位:主动、不发入群提示(gugu-dev#181)。
    const result = await admin.addAgent(groupId, guguAgentUserId, { asTask: true })
    if (result.status === 'pending_approval') throw new Error('Project Agent join requires approval')
    await rememberProjectGroupId(projectId, groupId, ownerUserId, env)
    return groupId
  }
  if (priorGroupId) return takeSeat(priorGroupId)

  const createGroup = (groupId: string) => chat.rpc('create_gugu_group', {
    p_chat_id: groupId,
    p_name: groupName,
    p_owner_user_id: ownerUserId,
    p_initial_members: [{ user_id: guguAgentUserId, role: 'member' }],
    p_default_agent_type: null,
    p_group_prompt: null,
  })
  let chatId = prepared.reservedGroupId || randomUUID()
  let { error } = await createGroup(chatId)
  if (error && prepared.reservedGroupId && isUniqueViolation(error)) {
    // #7341 预留的 id 刚被占了:另一台机器 / 背靠背的另一条会话刚用它把群建出来(⇒ 加座位),或它是一个
    // 这个账号看不见的群(⇒ 另建、改指映射)。与服务端 provision_taskpage_agent 的撞主键 / 'foreign' 两支同处置。
    if ((await groupIsUsable(chat, chatId)) === 'active') return takeSeat(chatId)
    createLogger('sessionpage/provision').warn(
      { projectId, chatId },
      '#7341 reserved project group id is taken by a group this account cannot see — creating a fresh group',
    )
    chatId = randomUUID()
    ;({ error } = await createGroup(chatId))
  }
  if (error) throw new Error(`create project group failed: ${error.message}`)
  // 建群时它是初始成员(建群不发入群提示);任务座位是主动档,与 takeSeat、provision_taskpage_agent 同一档。
  await createGroupAdmin(chat, ownerUserId).setListenMode(chatId, guguAgentUserId, 'active')
  await rememberProjectGroupId(projectId, chatId, ownerUserId, env)
  return chatId
}

/** Postgres 撞主键(23505)。PostgREST 把 code 带在错误上;老一些的形状只有文字。 */
export function isUniqueViolation(error: { code?: string | null; message?: string | null }): boolean {
  return error.code === '23505' || /duplicate key|unique constraint/i.test(error.message ?? '')
}

/** The group id already bound to THIS session-page project (recorded on any prior agent of the same project).
 *  Scans the roster already in hand (see provisionLocked) rather than re-reading GUGU_HOME/agents. */
export function findGroupIdForProject(
  roster: Awaited<ReturnType<typeof listAgents>>,
  projectId: string,
  ownerUserId: string,
): string | null {
  for (const agent of roster) {
    if (cacheString(agent.cache, PROJECT_CACHE_KEY) !== projectId) continue
    // #4277 别家的行记着别家的群,拿来只会白问一次云端(RLS 看不见)—— 只看归我的与不知道归谁的老行。
    const rowOwner = cacheString(agent.cache, OWNER_CACHE_KEY)
    if (rowOwner && rowOwner !== ownerUserId) continue
    const groupId = cacheString(agent.cache, GROUP_CACHE_KEY)
    if (groupId) return groupId
  }
  return null
}

/**
 * 映射里的群还能不能用:在、且 active。
 *
 * #4277 只判「在不在」不够:群会在 provisioning 之外被归档 —— remove_owned_agent 摘掉一个群里最后一个
 * agent 时会把群归档(#1982 的成员数下限),回收器的群步骤不知道,映射还指着它;下一条会话拿到这个归档群
 * 「加座位」,agent 就进了一个通讯录不显示的群(真机 B 轮:项目 hello 的群 05:51 被归档,新铸的三个 agent
 * 全塞进去,owner 在通讯录看不到群)。归档的按「不能用」处理:忘掉映射、另建。
 * 真查询出错要抛(❌ 静默再铸一个重复群);data=null 且无错 = 群被删了 → 重建。
 */
async function groupIsUsable(chat: ReturnType<typeof makeChatClient>, chatId: string): Promise<'active' | 'archived' | 'missing'> {
  const { data, error } = await chat.from('chats').select('id, status').eq('id', chatId).maybeSingle()
  if (error) throw new Error(`project group existence check failed: ${error.message}`)
  if (!data) return 'missing'
  return (data as { status?: string | null }).status === 'archived' ? 'archived' : 'active'
}

/**
 * 一次往返供给回来之后,这个 agent 实际在哪个项目群里(名册记这个)。
 *  · pending_approval:项目群开了「Agent 加入需审批」而账号不是管理员 ⇒ 进了待审请求、这次不在群里;
 *    映射照旧指着项目群(批准后再开会话即在群里),名册 ❌ 记它在群里。
 *  · 服务端另建了群(映射的群已归档 / foreign)⇒ 映射与名册改指新群。
 */
export function resolveProvisionedProjectGroup(
  job: { groupName?: string | null; groupChatId: string },
  minted: { groupChatId: string; priorGroupState: string },
): { kind: 'pending-approval' | 'remapped' | 'unchanged'; groupChatId: string } {
  if (minted.priorGroupState === 'pending_approval') return { kind: 'pending-approval', groupChatId: '' }
  if (job.groupName && minted.groupChatId && minted.groupChatId !== job.groupChatId) {
    return { kind: 'remapped', groupChatId: minted.groupChatId }
  }
  return { kind: 'unchanged', groupChatId: job.groupChatId }
}

/**
 * Rebuild persisted session-page identity bindings at boot. Every roster conversation stays represented behind
 * one offline compatibility owner until its actual transport promotes; a delivery during that gap fails loud
 * instead of falling through to a gugu-native engine. Returns the number of identity rows retained.
 */
export async function registerExistingSessionpageAgents(
  env: NodeJS.ProcessEnv = process.env,
  options: { ownerUserId?: string | null } = {},
): Promise<number> {
  const log = createLogger('sessionpage/boot')
  const startedAt = Date.now()
  log.info({}, 'persisted binding roster read started')
  const roster = agentsForOwner(await listAgents(env, { includeGuests: true }), options.ownerUserId)
  const readMs = Date.now() - startedAt
  log.info({ readMs, rows: roster.length }, 'persisted binding roster read finished')
  let count = 0
  const incompleteCapabilityRows: string[] = []
  for (const agent of roster) {
    const sessionId = cacheString(agent.cache, SESSION_CACHE_KEY)
    const providerId = cacheString(agent.cache, PROVIDER_CACHE_KEY)
    const surface = cacheString(agent.cache, SURFACE_CACHE_KEY)
    // Identity reconstruction is surface-blind. Every persisted conversation binding is kept behind
    // the same offline owner until its actual transport promotes; no owner-kind branch may decide
    // whether the identity exists.
    const registerOfflineOwner = () => {
      if (agent.gugu_user_id && sessionId) {
        registerOfflineLocalSessionDelivery(agent.gugu_user_id, {
          sessionId,
          providerId: providerId || agent.agent_type,
        })
        count++
      }
    }
    if (!providerId || (surface !== 'acp' && surface !== 'tui')) {
      registerOfflineOwner()
      if (providerId || surface) incompleteCapabilityRows.push(agent.gugu_user_id)
      continue
    }
    try {
      const integration = resolveSessionpageSessionIntegration(providerId, surface)
      if (integration.identity !== 'addressable') continue
    } catch {
      registerOfflineOwner()
      incompleteCapabilityRows.push(agent.gugu_user_id)
      continue
    }
    registerOfflineOwner()
  }
  if (incompleteCapabilityRows.length) {
    throw new Error(
      `session-page capability cache is incomplete or invalid for agent record(s): ${incompleteCapabilityRows.join(', ')}`,
    )
  }
  log.info({ readMs, registerMs: Date.now() - startedAt - readMs, bindings: count }, 'persisted binding reconstruction finished')
  return count
}

/**
 * #5025 开机重注册跑在「还不知道现在是谁」的时候(那个答案要等渲染进程就绪,~2.7s),所以它按老行为
 * 全注册。等归属真的定下来,再把**明确属于别的账号**的行摘掉。
 *
 * 为什么是「先全注册、后摘」而不是「等确定了再注册」:两种错的代价不对等。漏注册自己的行,投递会掉到
 * 原生引擎去 spawn 一个进程(严重);多注册别家的行,只是内存路由表里一条死记录加收件扫描几行 400(轻微)。
 * 让路由多等 2.7s 去换那点轻微收益,是拿严重风险换轻微风险。
 *
 * 只摘 owner **明确不等于**当前账号的行:没记 owner 的老行归属未知,照旧留着(与 agentMayBelongTo 同口径)。
 * 摘别家的行不会制造「无主空窗」—— 这个进程本来就投不动它们。
 *
 * @returns 处理过的别家账号行数。⚠️ 不等于「真的从路由表里摘下来几条」:多数别家的行本就不满足注册
 *          条件,对它们调 unregister 是空操作。这个数字读作「确认过的别家的行」,❌ 别读成占用量。
 */
export async function unregisterForeignSessionpageAgents(
  env: NodeJS.ProcessEnv = process.env,
  ownerUserId: string,
): Promise<number> {
  if (!ownerUserId) return 0
  let released = 0
  for (const agent of agentsForOwner(await listAgents(env, { includeGuests: true }), null, { includeArchived: true })) {
    if (!agent.gugu_user_id) continue
    if (agentsForOwner([agent], ownerUserId, { includeArchived: true }).length) continue
    unregisterEmdashAgent(agent.gugu_user_id)
    unregisterLocalSessionDeliveryForAgent(agent.gugu_user_id)
    released++
  }
  return released
}
