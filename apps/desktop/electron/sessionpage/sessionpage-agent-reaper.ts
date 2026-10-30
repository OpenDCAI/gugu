import { releaseAgentLocalFootprint } from './agent-local-footprint'
import { createGroupAdmin } from '@gugu/core/cloud/groupAdmin'
// Reconcile missing local tasks by archival. Missing inventory never authorizes
// deleting cloud identities or group membership. Existing project-group archival
// still respects other machines and the original inventory trust checks.
import { listAgents } from '@gugu/core'
import { agentsForOwner } from '@gugu/core/local/state/agentOwner'
import { makeChatClient, makeIdentityClient } from '../supabase'
import {
  SESSION_CACHE_KEY,
  GROUP_CACHE_KEY,
  OWNER_CACHE_KEY,
  PARKED_SESSION_CACHE_KEY,
  PROJECT_CACHE_KEY,
  cacheString,
} from './emdash-agent-provisioning'
import { emdashAgentRegistry } from './emdash-agent-registry'
import { createLogger } from '../lib/logger'
import { forgetProjectGroupId, listProjectGroupIds } from './sessionpage-project-groups'

/** The existence inventory includes archived conversations and their retained identities. */
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
   * #7341 归档项目群之前问一句:群里还有没有别的机器上的 agent(`identity.users.device_id` ≠ 本机)。
   * 返回那些 agent 的 id;缺席 ⇒ 走 supabase(listGroupAgentsOnOtherDevices)。测试注入用。
   */
  listGroupAgentsElsewhere?: (input: { chatId: string; deviceId: string; accessToken: string; ownerUserId: string }) => Promise<string[]>
  env?: NodeJS.ProcessEnv
}

export interface SessionpageReapResult {
  /** 名册段:名册行还在、会话没了的 agent。 */
  reapedAgents: number
  archivedGroups: number
}

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
 * 人不算(只看 type=agent);本机的 agent 不算(它们的本机运行态会归档,群成员保留)。任何一步读失败都抛 ——
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
 * conversation no longer exists (deleted), and archives the group mirroring any project that
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
  const bound = agentsForOwner(roster, null)
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
        'instrument never proven able to read non-empty is not evidence for archival.',
    )
  }

  const stale = bound.filter((a) => reapAuthorized && !liveSessions.has(a.sessionId))

  // 开机那一刻 authProvider 往往还没建好(#5025):这一轮读不到令牌,归档留给 main.ts 在归属定下来之后那一轮。
  const auth = await deps.getAuth()
  const deviceId = auth?.accessToken ? await deps.resolveDeviceId() : null

  // Read project→group mappings before marking stale local bindings; identities and group seats stay intact.
  // A project group whose project still exists is kept even when a task is missing.
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
  if (stale.length || deadProjectGroups.size) {
    console.log(
      `[sessionpage-reap] inventory: ${liveSessions.size} live session(s), ${liveProjects.size} live project(s); ` +
        `bound=${bound.length} stale=${stale.length} deadProjectGroups=${deadProjectGroups.size}`,
    )
  }
  if (!stale.length && !deadProjectGroups.size) {
    return { reapedAgents: 0, archivedGroups: 0 }
  }

  if (!auth?.accessToken) {
    throw new Error(
      `session-page reap: owner not authenticated — ${stale.length} stale agent(s) left in place (retried on next trigger)`,
    )
  }
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
      await createGroupAdmin(makeChatClient(reaperAccessToken), reaperUserId).archive(chatId)
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
    // Foreign-owner rows stay untouched; their owner reconciles them through the same archival path.
    if (agent.ownerUserId && agent.ownerUserId !== auth.userId) {
      reapLogger().info(
        { agent: agent.guguUserId, name: agent.name, owner: agent.ownerUserId, sessionId: agent.sessionId },
        'session is gone but the agent belongs to another account — left for its owner to reap',
      )
      continue
    }
    try {
      await reapAgent(agent, { env, deps })
      reapedAgents++
      console.log(
        `[sessionpage-reap] reaped agent ${agent.name} (${agent.guguUserId}) — session-page session ${agent.sessionId} is gone`,
      )
    } catch (err) {
      failures.push(`reap agent ${agent.guguUserId}: ${(err as Error).message}`)
    }
  }

  if (failures.length) {
    throw new Error(`session-page reap had ${failures.length} failure(s): ${failures.join(' | ')}`)
  }
  return { reapedAgents, archivedGroups }
}

async function reapAgent(
  agent: {
    guguUserId: string
    name: string
    sessionId: string
    chatId: string
  },
  ctx: {
    env: NodeJS.ProcessEnv
    deps: SessionpageReapDeps
  },
): Promise<void> {
  // 1. Stop routing, then tear down the runtime session. Session-direct rows live in the same
  //    conversation outbox as chat messages; removing the owner stops future reads, while pending
  //    rows remain durable with the retained task history.
  emdashAgentRegistry.unregister(agent.guguUserId)
  await ctx.deps.disposeSession?.(agent.sessionId)

  // Missing task rows never authorize deleting identities, messages or group seats.
  await releaseAgentLocalFootprint({ agentUserId: agent.guguUserId, identityRemoved: false, env: ctx.env })
}
