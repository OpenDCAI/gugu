/**
 * starterContinuation — operation → starter → group 的 owner-scoped 续跑指针。
 *
 * 预设团队带一条**可编辑的开场任务**(starter)。它此前只活在向导的内存 AgentTeam 里:群一建成就被塞进该群
 * 草稿槽。于是「operation 已开始、群还没建成」这段窗口里关掉/崩掉 app,用户编辑过的开场任务就永久丢了
 * ——恢复后的 operation 会建出一个空草稿的群,没有任何地方还记得他写过什么。这个模块就补这段持久性。
 *
 * starter **绝不进 blueprint**:blueprint 是 DB 派生幂等哈希(payload_hash)的输入,塞进去会让「同 operation
 * 幂等续跑」失效。所以关联另存在这里,只存三件事 —— 哪条 operation、用户写了什么、最终建成了哪个群。
 *
 * 纪律与 resume record 同源(见 agentProvision 的 defaultResumeStore):owner-scoped key、owner 前置校验先于
 * 任何使用、损坏即 fail loud 且**保留原始 bytes**、❌ 不静默丢弃或覆盖。清理**只在 operation 终态**
 * (starter 已落草稿 / 已取消),❌ 不在中途丢弃 —— 中途丢 = 崩溃重启后丢掉用户已编辑的开场任务。
 *
 * ❌ 不负责发送:saga 永不自动发群消息,发送必须由用户亲自触发。草稿里存的是用户编辑的原样文本,
 * 发送时的规范化(composer 的 trim)是 composer 自己的全局契约,不属于这一层。
 */

import { getProvisionOperation } from './agentProvision'
import { getRendererSession } from './sessionPublication'
import { getCurrentAuthUserId } from './supabase'
import type { AgentProvisionOperation } from '@gugu/core/shared/types/agentProvision'

export interface StarterContinuationRecord {
  version: 1
  ownerUserId: string
  operationId: string
  /** 用户在预览里编辑后的原样文本(不 trim:这是发送前的草稿载体)。 */
  starter: string
  /** finalize 建成群后回填;未建成时不存在(指针存在的意义就在这段窗口)。 */
  groupChatId?: string
}

/** 只有两种终态理由可以清理指针 —— 类型上不存在「中途丢弃」这条路。 */
export type StarterClearReason = 'draft-landed' | 'cancelled'

const STARTER_STORE_PREFIX = 'gugu:agent-provision:starter:'
const starterStoreKey = (ownerUserId: string): string => `${STARTER_STORE_PREFIX}${ownerUserId}`

function isRecord(x: unknown): x is StarterContinuationRecord {
  if (!x || typeof x !== 'object') return false
  const r = x as Record<string, unknown>
  if (r.version !== 1) return false
  if (typeof r.ownerUserId !== 'string' || r.ownerUserId.length === 0) return false
  if (typeof r.operationId !== 'string' || r.operationId.length === 0) return false
  // `undefined` means no starter intent; an empty/whitespace string is an intentional edit that must survive.
  if (typeof r.starter !== 'string') return false
  if (r.groupChatId !== undefined && (typeof r.groupChatId !== 'string' || r.groupChatId.length === 0)) return false
  return true
}

export interface StarterContinuationStore {
  /** 在第一条 RPC 之前落盘(与 resume record 同一时点)。写不进去就 throw:不允许带着丢失的 starter 继续创建。 */
  remember(record: StarterContinuationRecord): void
  /** finalize 后回填群 id。一条 operation 只对应一个群,换群即 fail loud。 */
  bindGroup(ownerUserId: string, operationId: string, groupChatId: string): void
  /** 终态清理。`draft-landed` 必须已绑定群(没群就不可能落过草稿)。未知 operation 是幂等 no-op。 */
  clear(ownerUserId: string, operationId: string, reason: StarterClearReason): void
  find(ownerUserId: string, operationId: string): StarterContinuationRecord | undefined
  list(ownerUserId: string): StarterContinuationRecord[]
}

export const starterContinuationStore: StarterContinuationStore = {
  remember(record) {
    // id 在类型收窄之前取:非法入参(含 null/undefined)也要能在错误里点名是哪条 operation。
    const attempted = (record as StarterContinuationRecord | null | undefined)?.operationId ?? '<unknown>'
    if (!isRecord(record)) {
      throw new Error(`starter continuation: refusing to remember a malformed record (starter must be a string) for operation ${attempted}`)
    }
    // 经 list() 读:store 损坏时 throw 会传出去,故 remember 永不覆盖损坏的 bytes(与 resume store 同规矩)。
    const rest = starterContinuationStore.list(record.ownerUserId).filter((r) => r.operationId !== record.operationId)
    const prior = starterContinuationStore.list(record.ownerUserId).find((r) => r.operationId === record.operationId)
    // 用户重编辑同一条 operation 的 starter = 原地更新;已绑定的群 id 不能因重编辑而丢。
    const next: StarterContinuationRecord = prior?.groupChatId ? { ...record, groupChatId: prior.groupChatId } : record
    window.localStorage.setItem(starterStoreKey(record.ownerUserId), JSON.stringify([...rest, next]))
  },

  bindGroup(ownerUserId, operationId, groupChatId) {
    if (!groupChatId) throw new Error(`starter continuation: refusing to bind an empty group id to operation ${operationId}`)
    const all = starterContinuationStore.list(ownerUserId)
    const found = all.find((r) => r.operationId === operationId)
    if (!found) {
      throw new Error(`starter continuation: no pointer for operation ${operationId} — refusing to invent one at bind time`)
    }
    if (found.groupChatId && found.groupChatId !== groupChatId) {
      // 一条 operation 最多产出一个群(DB 侧不变量)。换群是分歧意图,不是重放。
      throw new Error(`starter continuation: operation ${operationId} is already bound to group ${found.groupChatId} — refusing to rebind to ${groupChatId}`)
    }
    if (found.groupChatId === groupChatId) return   // 幂等重放(ack 丢了再绑一次)
    const rest = all.filter((r) => r.operationId !== operationId)
    window.localStorage.setItem(starterStoreKey(ownerUserId), JSON.stringify([...rest, { ...found, groupChatId }]))
  },

  clear(ownerUserId, operationId, reason) {
    if (reason !== 'draft-landed' && reason !== 'cancelled') {
      throw new Error(`starter continuation: '${String(reason)}' is not a terminal reason — the pointer is cleared only after the starter landed in the draft or the operation was cancelled`)
    }
    // list() 会在损坏时 throw —— clear 不吞:吞了既藏损坏又可能覆盖被保留的 bytes。
    const all = starterContinuationStore.list(ownerUserId)
    const found = all.find((r) => r.operationId === operationId)
    if (!found) return   // 幂等终态清理
    if (reason === 'draft-landed' && !found.groupChatId) {
      throw new Error(`starter continuation: operation ${operationId} has no bound group — a draft cannot have landed, refusing to discard the user's edited starter`)
    }
    const rest = all.filter((r) => r.operationId !== operationId)
    const key = starterStoreKey(ownerUserId)
    if (rest.length) window.localStorage.setItem(key, JSON.stringify(rest))
    else window.localStorage.removeItem(key)
  },

  find(ownerUserId, operationId) {
    return starterContinuationStore.list(ownerUserId).find((r) => r.operationId === operationId)
  },

  list(ownerUserId) {
    const raw = window.localStorage.getItem(starterStoreKey(ownerUserId))
    if (!raw) return []
    let arr: unknown
    try {
      arr = JSON.parse(raw)
    } catch (err) {
      throw new Error(`starter continuation store for ${ownerUserId} is corrupt (unparseable JSON) — refusing to read/overwrite (preserve + explicit repair required): ${err instanceof Error ? err.message : String(err)}`)
    }
    if (!Array.isArray(arr)) {
      throw new Error(`starter continuation store for ${ownerUserId} is corrupt (not an array) — refusing to read/overwrite (preserve + explicit repair required)`)
    }
    const malformed = arr.filter((r) => !isRecord(r)).length
    if (malformed > 0) {
      // ❌ 不静默丢:丢掉的可能正是某条 operation 里用户已编辑的开场任务(库里没有第二份)。
      throw new Error(`starter continuation store for ${ownerUserId} has ${malformed} malformed record(s) — refusing to silently drop (preserve + explicit repair required)`)
    }
    const crossOwner = (arr as StarterContinuationRecord[]).filter((r) => r.ownerUserId !== ownerUserId).length
    if (crossOwner > 0) {
      throw new Error(`starter continuation store for ${ownerUserId} has ${crossOwner} record(s) whose ownerUserId != the storage-key owner — refusing to read (cross-owner; preserve + explicit repair required)`)
    }
    return arr as StarterContinuationRecord[]
  },
}

/**
 * owner 前置校验 —— 必须在**使用**一条指针(把 starter 落进某个群的草稿)之前执行。账号切换后,上一个账号的
 * starter 绝不能被写进当前账号的草稿槽。
 */
export async function assertStarterRecordOwner(
  record: StarterContinuationRecord,
  getOwnerUserId: () => Promise<string>,
): Promise<void> {
  const current = await getOwnerUserId()
  if (!current || current !== record.ownerUserId) {
    throw new Error(`starter continuation: record owner ${record.ownerUserId} does not match current auth owner — refusing to use another account's starter`)
  }
}

// ── owner 解析好的产品侧入口(store 本身保持纯:owner 由调用方给) ─────────────────────────────────────

/** 在第一条 RPC 之前记住这条 operation 的 starter；显式空串也是必须保留的用户意图。 */
export async function rememberStarterForOperation(
  operationId: string,
  starter: string,
  getOwnerUserId: () => Promise<string> = getCurrentAuthUserId,
): Promise<void> {
  const ownerUserId = await getOwnerUserId()
  if (!ownerUserId) throw new Error('starter continuation: no current auth owner — refusing to persist a starter')
  starterContinuationStore.remember({ version: 1, ownerUserId, operationId, starter })
}

/**
 * finalize 建成群后回填群 id。**这条 operation 没有 starter 指针时是 no-op** —— 不是所有团队都带开场任务;
 * store 自身仍拒绝为无指针的 operation 凭空造一条(那才是要防的)。
 */
export async function bindStarterGroup(
  operationId: string,
  groupChatId: string,
  getOwnerUserId: () => Promise<string> = getCurrentAuthUserId,
): Promise<void> {
  const ownerUserId = await getOwnerUserId()
  if (!ownerUserId) throw new Error('starter continuation: no current auth owner — refusing to bind a group')
  if (!starterContinuationStore.find(ownerUserId, operationId)) return   // 本次创建没带 starter
  starterContinuationStore.bindGroup(ownerUserId, operationId, groupChatId)
}

/** starter 已落进该群草稿后的终态清理(happy path:创建成功当场落草稿)。未知 operation 是幂等 no-op。 */
export async function clearLandedStarter(
  operationId: string,
  getOwnerUserId: () => Promise<string> = getCurrentAuthUserId,
): Promise<void> {
  const ownerUserId = await getOwnerUserId()
  if (!ownerUserId) throw new Error('starter continuation: no current auth owner — refusing to clear a starter')
  starterContinuationStore.clear(ownerUserId, operationId, 'draft-landed')
}

/** operation 被显式取消后的终态清理:群从未建成,故 `cancelled` 不要求已绑定群。未知 operation 是幂等 no-op。 */
export async function clearCancelledStarter(
  operationId: string,
  getOwnerUserId: () => Promise<string> = getCurrentAuthUserId,
): Promise<void> {
  const ownerUserId = await getOwnerUserId()
  if (!ownerUserId) throw new Error('starter continuation: no current auth owner — refusing to clear a starter')
  starterContinuationStore.clear(ownerUserId, operationId, 'cancelled')
}

/**
 * 重启后的补落:把**已绑定群**的指针逐条落进该群草稿槽,落成功才清理。返回落了几条。
 *
 * 未绑定群的指针**原样留着** —— 那正是它存在的意义(群还没建成,operation 可续跑)。`writeDraft` 抛错时**不清理**:
 * 草稿没真落下去就当成落了,等于丢掉用户编辑的开场任务。❌ 永不代用户发送。
 *
 * #7175 「现在是谁」读已发布的渲染层会话,还没有就是 ''(启动降级、登出途中):下面那句「未登录就跳过」才真的起作用,
 * 指针原样留着、不报错。此前默认取 getCurrentAuthUserId,它没有会话就抛 `Not authenticated`,于是外壳一以降级态挂上,
 * 没有任何开场任务也弹「Could not restore the opening task」。
 */
export async function landPendingStarters(
  writeDraft: (chatId: string, text: string) => void,
  getOwnerUserId: () => Promise<string> = async () => getRendererSession()?.user.id ?? '',
  getOperation: (operationId: string) => Promise<AgentProvisionOperation | null> = getProvisionOperation,
  isCurrent: () => boolean = () => true,
): Promise<number> {
  const ownerUserId = await getOwnerUserId()
  if (!isCurrent()) return 0
  if (!ownerUserId) return 0   // 未登录:没有可解析的 owner,也没有任何可落的草稿
  let landed = 0
  for (const record of starterContinuationStore.list(ownerUserId)) {
    await assertStarterRecordOwner(record, getOwnerUserId)   // 使用前的 owner 前置校验
    if (!isCurrent()) return landed
    let groupChatId = record.groupChatId
    if (!groupChatId) {
      // Narrow durable reconciliation, not a second provision state machine. This closes the crash window where
      // finalize committed but the caller died before bindStarterGroup/finishTeam returned.
      const operation = await getOperation(record.operationId)
      if (!isCurrent()) return landed
      if (!operation) {
        throw new Error(`starter continuation: operation ${record.operationId} is missing/not found — refusing to discard the unbound starter`)
      }
      if (operation.phase === 'completed') {
        if (typeof operation.group_chat_id !== 'string' || operation.group_chat_id.length === 0) {
          throw new Error(`starter continuation: completed operation ${record.operationId} has no group id (corrupt durable state)`)
        }
        starterContinuationStore.bindGroup(ownerUserId, record.operationId, operation.group_chat_id)
        groupChatId = operation.group_chat_id
      } else if (operation.phase === 'cancelled') {
        starterContinuationStore.clear(ownerUserId, record.operationId, 'cancelled')
        continue
      } else if (
        operation.phase === 'provisioning_members'
        || operation.phase === 'failed'
        || operation.phase === 'cleaning_up'
      ) {
        continue
      } else {
        throw new Error(`starter continuation: operation ${record.operationId} has unknown/corrupt phase ${String(operation.phase)}`)
      }
    }
    if (!isCurrent()) return landed
    writeDraft(groupChatId, record.starter)                    // 原样文本,❌ 不 trim
    if (!isCurrent()) return landed
    starterContinuationStore.clear(ownerUserId, record.operationId, 'draft-landed')
    landed += 1
  }
  return landed
}
