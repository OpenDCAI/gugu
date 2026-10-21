// @@@sessionpage TASKPAGE-FUSION — DELETION SYNC (spec ⑨「删除必同步」, owner: 千万不要只同步增、不同步删).
// Provisioning mirrors a session-page conversation INTO gugu's social side (an agent contact, and for a
// project-scoped conversation a member seat in the group mirroring that project). This module mirrors the
// REMOVALS back out: archive or delete a conversation and its agent leaves the contact list; delete a
// project and the group mirroring it is archived along with the agents it produced.
//
// RECONCILE, NOT PER-EVENT BOOKKEEPING. We diff the roster against the session backend's authoritative inventory
// (`emdashSessionpageInventory`) instead of subscribing to a delete event per entity — because two of the
// removal paths emit no usable per-entity signal at all: archiving is a TASK-level flag change that fires
// no domain event, and deleting a task/project cascades its conversation rows away WITHOUT emitting a
// per-conversation delete. A diff catches those, plus any future removal path nobody wired up. The session backend's
// trigger (`onEmdashSessionpageReapTrigger`) only says "something may have changed" and makes us re-diff; it
// is never the source of truth. Also runs once at boot, so removals that happened while gugu was closed
// still converge. This is spec ⑨'s 单向真源 in code: the session page decides, the social side follows.
//
// FAIL-LOUD, BUT COMPLETE: every stale agent is attempted; per-agent failures are collected and re-thrown
// as one aggregate error at the end (a single Supabase hiccup must not silently strand the other agents,
// and it must not be swallowed either). Reaping is idempotent — a half-finished reap converges on the next
// trigger, since the roster record is the thing that makes an agent visible.
//
// TWO ENUMERATION FACES (#4277, product spec「本机段…❌ 出现本机已经没有会话的 agent」). The roster diff
// above only ever sees identities the LOCAL ROSTER still points at. The roster is a third artifact — neither
// the source of truth (the session page) nor the projection (this account's cloud agents) — and once a roster
// row is gone (reinstall, wiped userData, a different GUGU_HOME) the cloud identity it pointed at is
// unreachable by a roster-driven diff forever. A real machine accumulated 95 contacts / 55 distinct names
// that way. So the reap ALSO enumerates the projection itself: every cloud agent of this account whose home
// device is this machine and which no roster row references is, by construction, an agent this machine has
// no conversation for — the exact thing the spec forbids in the local section — and is reaped (home-guarded).
import { listAgents } from '@gugu/core'
import { removeAgentCloudIdentityViaSupabase } from '@gugu/core/cloud/agentIdentityRemoval'
import { listOwnedCloudAgentsViaSupabase } from '@gugu/core/cloud/agentIdentityReconcile'
import { makeChatClient, makeIdentityClient } from '../supabase'
import {
  SESSION_CACHE_KEY,
  GROUP_CACHE_KEY,
  OWNER_CACHE_KEY,
  PARKED_SESSION_CACHE_KEY,
  PROJECT_CACHE_KEY,
  cacheString,
} from './emdash-agent-provisioning'
import { releaseAgentLocalFootprint } from './agent-local-footprint'
import { emdashAgentRegistry } from './emdash-agent-registry'
import { createLogger } from '../lib/logger'
import { forgetProjectGroupId, listProjectGroupIds } from './sessionpage-project-groups'

/** The session backend's authoritative inventory: what still EXISTS and is not archived. */
export interface SessionpageInventory {
  sessionIds: string[]
  projectIds: string[]
}

export interface SessionpageReapDeps {
  getAuth: () => Promise<{ accessToken: string; refreshToken: string; userId: string } | null>
  resolveDeviceId: () => Promise<string | null>
  getInventory: () => Promise<SessionpageInventory>
  /** Dispose the runtime session bound to a conversation (codex app-server). Injected by main.ts so this
   *  module doesn't depend on the pty provisioning module. */
  disposeSession?: (sessionId: string) => Promise<void>
  /**
   * Sessions the trigger KNOWS are gone: only `session:archived` / `session:deleted`, fired after the
   * row op. A runtime teardown never names a session — app quit tears mounts down with `terminate` while the
   * sessions still exist (#6168). Naming the session lets that pass reap without depending on when rows disappear.
   */
  deadSessionIds?: readonly string[]
  /**
   * 投影的枚举面:这个账号名下的云端 agent(RLS 之内、owner 过滤之后)。缺席 ⇒ 走 supabase 适配器;
   * 测试注入用。
   */
  listOwnedCloudAgents?: (auth: { accessToken: string; userId: string }) => Promise<ProjectionAgent[]>
  /** 时钟注入(测试用);缺席 ⇒ Date.now。 */
  now?: () => number
  /**
   * #7341 归档项目群之前问一句:群里还有没有别的机器上的 agent(`identity.users.device_id` ≠ 本机)。
   * 返回那些 agent 的 id;缺席 ⇒ 走 supabase(listGroupAgentsOnOtherDevices)。测试注入用。
   */
  listGroupAgentsElsewhere?: (input: { chatId: string; deviceId: string; accessToken: string; ownerUserId: string }) => Promise<string[]>
  env?: NodeJS.ProcessEnv
}

/** 投影里的一行:云端 identity.users 的 agent 行(只取回收要用的几列)。 */
export interface ProjectionAgent {
  agentUserId: string
  deviceId: string | null
  displayName: string | null
  /** identity.users.created_at(ISO);缺席按「很久以前」处理。 */
  createdAt?: string | null
}

/**
 * 刚铸出来的身份不当孤儿。provisioning 是「先铸云端身份、再写名册行」,两步之间有一小段窗口;更要紧的是
 * 对账自己读云端可能很慢(真机一次网络抖动读了 28 秒),这期间别处新铸的身份会出现在云端清单里而不在
 * 对账手里的名册快照里 —— 真机上就这样把一条活会话 5 秒前刚铸的 agent 当孤儿删了(#4277 验收 B 轮)。
 * 名册在云端之后再读、删前再复核之外,再给「新鲜」的行一段宽限:真正的孤儿都是老行,不差这几分钟。
 */
export const PROJECTION_ORPHAN_GRACE_MS = 10 * 60_000

export interface SessionpageReapResult {
  /** 名册段:名册行还在、会话没了的 agent。 */
  reapedAgents: number
  archivedGroups: number
  /** 投影段:云端行还在、家在本机、名册里已经没有对应行的 agent。 */
  reapedOrphans: number
}

const listOwnedCloudAgentsDefault = (auth: { accessToken: string; userId: string }): Promise<ProjectionAgent[]> =>
  listOwnedCloudAgentsViaSupabase({ ownerUserId: auth.userId, accessToken: auth.accessToken })

/** 读群成员 / 读身份行用到的那一小片 supabase 查询面(测试拿替身喂)。 */
interface MembersQuery {
  from(table: 'chat_members'): {
    select(columns: 'user_id'): {
      eq(column: 'chat_id', value: string): PromiseLike<{ data: unknown; error: { message: string } | null }>
    }
  }
}
interface UsersQuery {
  from(table: 'users'): {
    select(columns: 'id, type, device_id'): {
      in(column: 'id', values: string[]): PromiseLike<{ data: unknown; error: { message: string } | null }>
    }
  }
}

/**
 * #7341 这个群里家在**别的机器**上的 agent(product spec:一台机器上的项目没了,❌ 连带把还有别的机器在用的
 * 项目群归档)。成员行 RLS 是「我也在这个群里」,群主读得到全部成员;identity.users 的 id/type/device_id 对已登录者可读。
 * 人不算(只看 type=agent);本机的 agent 不算(它们这一轮会被收掉、群座位随之腾空)。任何一步读失败都抛 ——
 * 调用方据此「不归档」,❌ 当成「没人在用」。
 */
export async function listGroupAgentsOnOtherDevices(input: {
  chat: MembersQuery
  /** 惰性:群里除了主人没别人时不必建身份查询的客户端。 */
  identity: () => UsersQuery
  chatId: string
  deviceId: string
  ownerUserId: string
}): Promise<string[]> {
  const { data: members, error } = await input.chat.from('chat_members').select('user_id').eq('chat_id', input.chatId)
  if (error) throw new Error(`read members of group ${input.chatId}: ${error.message}`)
  const ids = [...new Set(((members as Array<{ user_id?: unknown }> | null) ?? [])
    .map((row) => (typeof row.user_id === 'string' ? row.user_id : ''))
    .filter((id) => id && id !== input.ownerUserId))]
  if (!ids.length) return []
  const { data: users, error: usersError } = await input.identity().from('users').select('id, type, device_id').in('id', ids)
  if (usersError) throw new Error(`read member identities of group ${input.chatId}: ${usersError.message}`)
  return ((users as Array<{ id: string; type?: string | null; device_id?: string | null }> | null) ?? [])
    .filter((user) => user.type === 'agent' && user.device_id !== input.deviceId)
    .map((user) => user.id)
}

const listGroupAgentsElsewhereDefault = (input: { chatId: string; deviceId: string; accessToken: string; ownerUserId: string }): Promise<string[]> =>
  listGroupAgentsOnOtherDevices({
    chat: makeChatClient(input.accessToken) as unknown as MembersQuery,
    identity: () => makeIdentityClient(input.accessToken) as unknown as UsersQuery,
    chatId: input.chatId,
    deviceId: input.deviceId,
    ownerUserId: input.ownerUserId,
  })

// Serialize: several triggers can fire back-to-back (deleting a project tears down each of its tasks), and
// concurrent passes would both see the same stale rows and race on removing them.
let reapChain: Promise<unknown> = Promise.resolve()
function serialize<T>(fn: () => Promise<T>): Promise<T> {
  const next = reapChain.then(fn, fn)
  reapChain = next.catch(() => undefined)
  return next
}

/**
 * Reconcile gugu's social-side projection with the session page. Reaps every session-page agent whose
 * conversation no longer exists (deleted) or is archived, and archives the group mirroring any project that
 * no longer exists. Returns what it removed. Throws (aggregated) if any removal failed.
 */
/**
 * #3969 —— 「会话清单读空」能不能授权删除。
 *
 * 回收器 diff 花名册与会话页后端清单,不在清单里的 bound agent 会被删花名册 **并删云端身份**。
 * 空清单与「用户真的把会话全删了」在类型上完全同形,而后者才是该触发删除的那件事。
 * 同一文件上方那道 TRUSTWORTHINESS GUARD 已经因为一次真实坏读数而存在(它挡的是群组归档),
 * 当时的推理是「agent reaping 不受影响,因为它 key off conversations,而 conversations 我们读到了」——
 * **「读到了」不等于「读全了」**。后端未就绪时(本文件另一处注释记着 lazy ESM 段会让单例读到 undefined)
 * 返回的空数组同样是「读到了」。
 *
 * 判据用本仓自己的定律:**报「0」之前先证明这台仪器读得出非零。**
 * 本进程生命周期内一次都没读出过非空会话清单时,空清单不算阴性读数,不授权按缺席删除;
 * 读出过之后,空清单就是真的空,照常回收(否则用户真删光了会永远收不掉)。
 */
export function emptyInventoryCanAuthorizeReap(input: {
  liveSessionCount: number
  boundAgentCount: number
  everSawNonEmptyInventory: boolean
}): boolean {
  if (input.liveSessionCount > 0) return true
  if (input.boundAgentCount === 0) return true
  return input.everSawNonEmptyInventory
}

function reapLogger() {
  return createLogger('sessionpage/reap')
}

/** 本进程生命周期内是否读出过非空会话清单 —— 空读数的阳性对照。 */
let everSawNonEmptyInventory = false

export async function reconcileSessionpageAgents(deps: SessionpageReapDeps): Promise<SessionpageReapResult> {
  return serialize(() => reconcileLocked(deps))
}

async function reconcileLocked(deps: SessionpageReapDeps): Promise<SessionpageReapResult> {
  const env = deps.env ?? process.env
  const inventory = await deps.getInventory()
  const liveSessions = new Set(inventory.sessionIds)
  const liveProjects = new Set(inventory.projectIds)

  const roster = await listAgents(env, { includeGuests: true })
  // Only records this module provisioned (they carry the conversation binding) are ours to reap. A gugu
  // agent the user made themselves has no binding and must never be touched here.
  // #4277 停放行(别的账号正在驱动这条会话时挪到 parked 格的绑定)同样跟着会话走:会话没了一起收。
  const bound = roster
    .map((agent) => ({
      guguUserId: agent.gugu_user_id,
      name: agent.name,
      sessionId: cacheString(agent.cache, SESSION_CACHE_KEY)
        || cacheString(agent.cache, PARKED_SESSION_CACHE_KEY),
      chatId: cacheString(agent.cache, GROUP_CACHE_KEY),
      projectId: cacheString(agent.cache, PROJECT_CACHE_KEY),
      ownerUserId: cacheString(agent.cache, OWNER_CACHE_KEY),
    }))
    .filter((a) => a.sessionId)

  if (liveSessions.size > 0) everSawNonEmptyInventory = true
  const reapAuthorized = emptyInventoryCanAuthorizeReap({
    liveSessionCount: liveSessions.size,
    boundAgentCount: bound.length,
    everSawNonEmptyInventory,
  })
  if (!reapAuthorized) {
    // fail loud 而不是静默跳过:静默跳过会让「从没回收过」和「这轮没东西可收」同形,
    // 而那正是这类缺陷最难查的地方。
    reapLogger().warn(
      {
        boundAgents: bound.length,
        liveSessions: liveSessions.size,
        everSawNonEmptyInventory,
      },
      'session list came back EMPTY while bound agents exist and this process has never read a ' +
        'non-empty inventory — refusing to reap by absence this round (#3969). An empty reading from an ' +
        'instrument never proven able to read non-empty is not evidence of deletion; sessions the trigger ' +
        'named dead are still reaped.',
    )
  }

  // 被点名的死会话是阳性读数(session:archived / session:deleted 在行操作之后才发),不靠清单,
  // #3969 管不着它:新装的机器第一次归档唯一的会话时,清单读空、本进程又从没读出过非空,只按缺席判会把它的
  // agent 永远留下。
  const deadSessions = new Set((deps.deadSessionIds ?? []).filter(Boolean))
  const stale = bound.filter((a) =>
    deadSessions.has(a.sessionId) || (reapAuthorized && !liveSessions.has(a.sessionId)))

  // 归属与设备先于枚举投影:投影是「这个账号名下」的,读它要账号的令牌。开机那一刻 authProvider 往往还
  // 没建好(#5025),这一轮就只走名册段并把「投影段没跑」说出来;main.ts 在归属定下来之后再触发一轮。
  const auth = await deps.getAuth()
  const deviceId = auth?.accessToken ? await deps.resolveDeviceId() : null

  // ── 投影段:云端这个账号名下、家在本机、名册里没有对应行的身份。
  // 名册行是「会话 → 身份」的唯一指针(会话页后端不存 agent id):指针没了,这条身份任何会话都到不了,
  // 下一次 session start 只会另铸一个。判据两条:家设备 = 本机(别的设备上的 agent 归那台机器收,
  // 通讯录按设备分段正是这个归属),且名册无行(有行的走上面的会话 diff;手工建的 agent 也有名册行,
  // 不会被误伤)。删身份那一步 removeAgentCloudIdentity 会再核一次家设备。
  //
  // 「名册读空」在这里不需要 #3969 那种阳控:listAgents 只把 ENOENT 当空(= 这台机器上真的没有名册),
  // 别的读失败都抛;而「名册没了、云端行还在」正是这一段要收的那个形状。
  let orphans: ProjectionAgent[] = []
  if (auth?.accessToken && auth.userId && deviceId) {
    const projection = await (deps.listOwnedCloudAgents ?? listOwnedCloudAgentsDefault)(auth)
    // 名册在云端**之后**再读:云端那一读可能很慢,期间新铸的身份已经写进名册;拿读云端之前的名册快照
    // 比对,会把它判成孤儿(真机复现,见 PROJECTION_ORPHAN_GRACE_MS 的注释)。
    const rosterAfterCloud = await listAgents(env, { includeGuests: true })
    const rosterIds = new Set(rosterAfterCloud.map((a) => a.gugu_user_id).filter(Boolean))
    const now = (deps.now ?? Date.now)()
    const fresh = (a: ProjectionAgent): boolean => {
      const t = a.createdAt ? Date.parse(a.createdAt) : NaN
      return Number.isFinite(t) && now - t < PROJECTION_ORPHAN_GRACE_MS
    }
    orphans = projection.filter((a) => a.deviceId === deviceId && !rosterIds.has(a.agentUserId) && !fresh(a))
    const skippedFresh = projection.filter((a) => a.deviceId === deviceId && !rosterIds.has(a.agentUserId) && fresh(a))
    if (skippedFresh.length) {
      reapLogger().info(
        { agents: skippedFresh.map((a) => ({ id: a.agentUserId, name: a.displayName, createdAt: a.createdAt })) },
        'projection rows with no roster row but minted within the grace window — left alone this round (in-flight provisioning)',
      )
    }
  } else {
    reapLogger().info(
      { authenticated: Boolean(auth?.accessToken), deviceId: deviceId ?? null },
      'projection pass skipped this round — owner or device not resolved yet; re-run once the owner is decided',
    )
  }

  // Groups whose PROJECT is gone (read before reaping — the roster records carry the project→group mapping,
  // so once they're removed the mapping is gone too). A project group whose project still exists is kept
  // even when one of its conversations was deleted: only that conversation's agent leaves the group.
  //
  // TRUSTWORTHINESS GUARD: every conversation belongs to a project, so "no projects but some conversations"
  // is an inconsistent read, not the world state. Treating it as truth would archive live projects' groups —
  // which is exactly what happened in a live run (a reap fired during task teardown saw an empty project list
  // and archived the group of a project that still existed). Archiving is owner-visible, so when the read
  // cannot be trusted we skip group archiving for this round and say so out loud; agent reaping is unaffected
  // because it keys off conversations, which we did read. Genuinely deleting every project still archives: the
  // conversations cascade away too, so sessionIds is empty as well and this guard does not trip.
  const inconsistentInventory = liveProjects.size === 0 && liveSessions.size > 0
  // chatId → 没了的项目(#7341:一个群可以被这台机器上不止一个本地项目绑着,收的时候每一条映射都要忘)
  const deadProjectGroups = new Map<string, { projectIds: Set<string>; ownerUserId: string }>()
  const noteDeadGroup = (chatId: string, projectId: string, ownerUserId: string): void => {
    const entry = deadProjectGroups.get(chatId)
    if (entry) entry.projectIds.add(projectId)
    else deadProjectGroups.set(chatId, { projectIds: new Set([projectId]), ownerUserId })
  }
  // #7341 这台机器上**还在的**项目绑着的群:哪怕某个绑着它的项目没了,群照样有人用,❌ 归档。
  const liveProjectChats = new Set<string>()
  if (!inconsistentInventory) {
    for (const agent of bound) {
      if (agent.projectId && agent.chatId && !liveProjects.has(agent.projectId)) {
        noteDeadGroup(agent.chatId, agent.projectId, agent.ownerUserId)
      }
      if (agent.projectId && agent.chatId && liveProjects.has(agent.projectId)) liveProjectChats.add(agent.chatId)
    }
    // 群的投影段:「项目 → 群」映射里记着、项目却没了的群。只从名册行推的话,名册一空这些群就永远收不到。
    // 与 #3969 同一条定律:本进程从没读出过非空清单时,「项目全没了」不算读数,这一段不动。
    if (auth?.userId && (liveProjects.size > 0 || everSawNonEmptyInventory)) {
      for (const { projectId, chatId } of await listProjectGroupIds(auth.userId, env)) {
        if (!liveProjects.has(projectId)) noteDeadGroup(chatId, projectId, auth.userId)
        else liveProjectChats.add(chatId)
      }
    }
  } else {
    console.warn(
      `[sessionpage-reap] project list came back empty while ${liveSessions.size} session(s) are live — ` +
        `refusing to archive any group this round (inconsistent read, retried on the next trigger)`,
    )
  }

  // Diagnostics: the inventory sizes are the whole basis for what gets reaped, so record them whenever this
  // round intends to act. Without this a wrong decision is invisible after the fact (it was — see the guard
  // above), and a reap that removes owner-visible things must be explainable from the log alone.
  if (stale.length || deadProjectGroups.size || orphans.length) {
    console.log(
      `[sessionpage-reap] inventory: ${liveSessions.size} live session(s), ${liveProjects.size} live project(s); ` +
        `bound=${bound.length} stale=${stale.length} deadProjectGroups=${deadProjectGroups.size} projectionOrphans=${orphans.length}`,
    )
  }
  if (!stale.length && !deadProjectGroups.size && !orphans.length) {
    return { reapedAgents: 0, archivedGroups: 0, reapedOrphans: 0 }
  }

  if (!auth?.accessToken) {
    throw new Error(
      `session-page reap: owner not authenticated — ${stale.length} stale agent(s) left in place (retried on next trigger)`,
    )
  }
  const chat = makeChatClient(auth.accessToken)
  const failures: string[] = []

  let archivedGroups = 0
  const reaperUserId = auth.userId
  const reaperAccessToken = auth.accessToken
  const forgetDeadProjects = async (projectIds: Set<string>): Promise<void> => {
    for (const projectId of projectIds) await forgetProjectGroupId(projectId, reaperUserId, env)
  }
  for (const [chatId, { projectIds, ownerUserId }] of deadProjectGroups) {
    // #4277 群归账号:别家的群这个账号动不了(RLS),归档留给它的主人;老行不知道归谁的照旧试。
    if (ownerUserId && ownerUserId !== auth.userId) continue
    const projects = [...projectIds].join(', ')
    try {
      // #7341 项目群跨设备共用(product spec):这台机器上的项目没了,群未必没人用。
      //  · 这台机器上还有别的项目绑着它 ⇒ 只忘掉没了的那几条映射。
      //  · 群里还有家在别的机器上的 agent ⇒ 同上(否则那台机器下次开会话会另建一个群,一个项目裂成几个)。
      //  · 查不出来(没解析出本机设备 / 云端读失败)⇒ 这一轮不归档、映射也不动,下次触发再判 —— fail closed。
      if (liveProjectChats.has(chatId)) {
        await forgetDeadProjects(projectIds)
        reapLogger().info({ chatId, projects }, 'project is gone but another project on this machine is still bound to its group — forgot the mapping, group kept')
        continue
      }
      if (!deviceId) {
        reapLogger().info({ chatId, projects }, 'project is gone but this device is not resolved yet — cannot tell whether other machines still use its group; not archiving this round')
        continue
      }
      let elsewhere: string[]
      try {
        elsewhere = await (deps.listGroupAgentsElsewhere ?? listGroupAgentsElsewhereDefault)({
          chatId, deviceId, accessToken: reaperAccessToken, ownerUserId: reaperUserId,
        })
      } catch (err) {
        reapLogger().warn(
          { chatId, projects, error: (err as Error).message },
          'could not check whether other machines still use this project group — not archiving it (fail closed)',
        )
        throw new Error(`check other machines before archiving: ${(err as Error).message}`)
      }
      if (elsewhere.length) {
        await forgetDeadProjects(projectIds)
        reapLogger().info(
          { chatId, projects, agentsElsewhere: elsewhere },
          'project is gone here but its group still has agents on other machines — forgot the mapping, group kept',
        )
        continue
      }
      // gugu has no group hard-delete (chat.chats has no DELETE policy — owner/admin may only UPDATE), so
      // removing a group means archiving it. Honest about the real capability rather than faking a delete.
      const { error } = await chat.from('chats').update({ status: 'archived' }).eq('id', chatId)
      if (error) throw new Error(error.message)
      archivedGroups++
      // 项目没了、群已归档 → 忘掉「项目 → 群」的映射,否则同 id 项目再出现时会复用一个归档群。
      await forgetDeadProjects(projectIds)
      console.log(`[sessionpage-reap] archived group ${chatId} (session-page project ${projects} is gone)`)
    } catch (err) {
      failures.push(`archive group ${chatId}: ${(err as Error).message}`)
    }
  }

  let reapedAgents = 0
  for (const agent of stale) {
    // #4277 别家账号的行**不动**,留给主人:云端那行只有主人的令牌删得动,这里摘掉本机这行等于把指针
    // 弄丢,主人的 agent 从此成了永远的孤儿(owner 09-04 的例子:B 建的会话被 A 归档)。行留着,主人下次
    // 在这台机器登录,回收器以它的身份扫到「行在、会话没了」再删。没记 owner 的老行照旧当自己的处理。
    if (agent.ownerUserId && agent.ownerUserId !== auth.userId) {
      reapLogger().info(
        { agent: agent.guguUserId, name: agent.name, owner: agent.ownerUserId, sessionId: agent.sessionId },
        'session is gone but the agent belongs to another account — left for its owner to reap',
      )
      continue
    }
    try {
      await reapAgent(agent, { chat, deviceId, accessToken: auth.accessToken, env, deps })
      reapedAgents++
      console.log(
        `[sessionpage-reap] reaped agent ${agent.name} (${agent.guguUserId}) — session-page session ${agent.sessionId} is gone`,
      )
    } catch (err) {
      failures.push(`reap agent ${agent.guguUserId}: ${(err as Error).message}`)
    }
  }

  let reapedOrphans = 0
  if (orphans.length) {
    if (!deviceId) throw new Error('session-page reap: projection orphans computed without a device id (unreachable)')
    for (const orphan of orphans) {
      try {
        // 删前再读一次名册复核:前面那些删除各自都要走网络,这条身份可能在等待期间刚被某条会话认领。
        const rosterNow = await listAgents(env, { includeGuests: true })
        if (rosterNow.some((a) => a.gugu_user_id === orphan.agentUserId)) {
          reapLogger().info({ agent: orphan.agentUserId, name: orphan.displayName }, 'projection orphan got a roster row meanwhile — kept')
          continue
        }
        // 先删云端身份(家设备护栏在里面再核一次),再放本机脚印。这里没有名册行、也就没有 chatId 可
        // 点名 —— 群座位 / 私聊由 remove_owned_agent 自己清(#1982),不需要 cleanup_removed_group_agent。
        const outcome = await removeAgentCloudIdentityViaSupabase({
          agentUserId: orphan.agentUserId,
          accessToken: auth.accessToken,
          deviceId,
        })
        if (!outcome.removed && outcome.reason === 'error') {
          throw new Error(`remove cloud identity: ${outcome.message ?? 'unknown error'}`)
        }
        await releaseAgentLocalFootprint({
          agentUserId: orphan.agentUserId,
          name: orphan.displayName ?? '',
          identityRemoved: outcome.removed,
          // 回收不是 owner 删联系人:碑只记 agent id,别把会话钉成「此后无身份」(见 footprint 的说明)。
          tombstoneSession: false,
          env,
        })
        if (outcome.removed) {
          reapedOrphans++
          reapLogger().info(
            { agent: orphan.agentUserId, name: orphan.displayName },
            'reaped projection orphan — cloud identity homed on this device with no roster row (no conversation can reach it)',
          )
        } else {
          reapLogger().warn(
            { agent: orphan.agentUserId, name: orphan.displayName, reason: outcome.reason, message: outcome.message },
            'projection orphan not removed',
          )
        }
      } catch (err) {
        failures.push(`reap projection orphan ${orphan.agentUserId}: ${(err as Error).message}`)
      }
    }
  }

  if (failures.length) {
    throw new Error(`session-page reap had ${failures.length} failure(s): ${failures.join(' | ')}`)
  }
  return { reapedAgents, archivedGroups, reapedOrphans }
}

async function reapAgent(
  agent: {
    guguUserId: string
    name: string
    sessionId: string
    chatId: string
  },
  ctx: {
    chat: ReturnType<typeof makeChatClient>
    deviceId: string | null
    accessToken: string
    env: NodeJS.ProcessEnv
    deps: SessionpageReapDeps
  },
): Promise<void> {
  // 1. Stop routing, then tear down the runtime session. Session-direct rows live in the same
  //    conversation outbox as chat messages; removing the owner stops future reads, while pending
  //    rows remain durable until the session is recreated or the conversation is deleted.
  emdashAgentRegistry.unregister(agent.guguUserId)
  await ctx.deps.disposeSession?.(agent.sessionId)

  // 2. Remove the cloud identity so the agent leaves the contact list. Home-guarded + owner-scoped;
  //    'not-owned' = already gone (idempotent), 'not-homed' = another device owns it (leave that identity
  //    alone, but still drop OUR local record below).
  // ORDER MATTERS (learned the loud way in a live run): cleanup_removed_group_agent is a POST-deletion RPC —
  // it raises `agent % still exists` while the identity is alive, because the product calls it AFTER an agent
  // is deleted. So the identity must go first, then the group seat.
  let identityRemoved = false
  if (ctx.deviceId && agent.guguUserId) {
    const outcome = await removeAgentCloudIdentityViaSupabase({
      agentUserId: agent.guguUserId,
      accessToken: ctx.accessToken,
      deviceId: ctx.deviceId,
    })
    if (!outcome.removed && outcome.reason === 'error') {
      throw new Error(`remove cloud identity: ${outcome.message ?? 'unknown error'}`)
    }
    identityRemoved = outcome.removed
  }

  // 3. Vacate the project group seat. With the identity gone, the product's own cleanup RPC applies (it
  //    clears the member row AND that agent's per-chat state). If the identity SURVIVED ('not-homed': another
  //    device owns it), that RPC would refuse — so drop just the member row, which is what the product does
  //    when removing a still-existing agent from a group. Either way the seat goes away.
  if (agent.chatId) {
    if (identityRemoved) {
      const { error } = await ctx.chat.rpc('cleanup_removed_group_agent', {
        p_chat_id: agent.chatId,
        p_agent_user_id: agent.guguUserId,
      })
      // The group may already be gone/archived, or the seat already cleaned — benign for a reap.
      if (error && !/not found|no rows/i.test(error.message)) {
        throw new Error(`cleanup group seat ${agent.chatId}: ${error.message}`)
      }
    } else {
      const { error } = await ctx.chat
        .from('chat_members')
        .delete()
        .eq('chat_id', agent.chatId)
        .eq('user_id', agent.guguUserId)
      if (error) throw new Error(`leave group ${agent.chatId}: ${error.message}`)
    }
  }

  // 4. Drop the local footprint last — the roster record is what makes this binding discoverable, so
  //    removing it only after the cloud side is handled keeps a failed reap retryable on the next trigger.
  //    Shared with the owner-initiated delete path (#4526): both drivers release the SAME set of local
  //    things, so they run the same operation rather than two implementations that drift apart. Its own
  //    registry unregister is an idempotent no-op here — step 1 already did it, before the cloud call.
  //
  //    `identityRemoved` gates the tombstone and the local-session release exactly as before: the offline
  //    local-session target is the compatibility blocker while transport/teardown is in flight, and only a
  //    confirmed cloud identity deletion followed by successful roster removal makes the owner permanently
  //    unreachable. not-homed (the identity is alive on another device) is not a deletion — no tombstone.
  await releaseAgentLocalFootprint({
    agentUserId: agent.guguUserId,
    name: agent.name,
    identityRemoved,
    // #4277 回收(会话归档 / 删除)不是 owner 删联系人:碑只记 agent id。会话取消归档、再被驱动时要能
    // 重新开户(spec「驱动过的会话在就在」);按会话记碑会把它钉死成「此后无身份」(真机:归档的
    // 「何丽丽」换号后报「还没有咕咕身份」)。
    tombstoneSession: false,
    env: ctx.env,
  })
}
