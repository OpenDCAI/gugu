// spec session-injection「认领者是注册表,不是具名 import」:本文件拥有 live 认领者注册表与
// owner 交接编排(prepare/promote/demote/restore)。编排对认领者只讲释放契约
// (`unregisterAgent(id, onReleased?)` / `releaseAgentClaim(id)`),❌ 不按家分支、不具名 import
// 任何一家 harness 的 adapter —— 加一家原生控制通道 = 它的 adapter 自己调 registerSessionpageDeliveryTarget,
// 本文件零 diff。仅有的两个具名依赖是内核角色:`emdashAgentRegistry`(ACP 兼容 owner)与 local-session
// (耐久离线 blocker,`sessionpage/local-session-delivery.ts` 的 ownership 事实)。
import {
  emdashAgentRegistry,
  registerEmdashAgent,
  unregisterEmdashAgent,
  type EmdashAgentRegistration,
} from './emdash-agent-registry'
import {
  localSessionDeliveryTarget,
  registerOfflineLocalSessionDelivery,
  unregisterLocalSessionDeliveryForAgent,
} from './local-session-delivery'
import type { SessionpageDeliveryTarget } from './session-injection'

export type SessionpageDeliveryOwnerKind = 'emdash' | 'native' | 'none'

// ── 认领者注册表 ────────────────────────────────────────────────────────────────
// 返回的是同一份活引用:router 构造后注册进来的认领者也会被后续解析看到。
const registeredTargets: SessionpageDeliveryTarget[] = []

export function registerSessionpageDeliveryTarget(target: SessionpageDeliveryTarget): void {
  if (registeredTargets.includes(target)) {
    throw new Error(
      `session-page delivery target '${target.deliveryTargetName ?? 'unknown'}' registered twice`,
    )
  }
  registeredTargets.push(target)
}

/** router 的 targets 与 owner 交接编排消费同一份注册列表(单一属主)。 */
export function sessionpageDeliveryTargets(): readonly SessionpageDeliveryTarget[] {
  return registeredTargets
}

/** live 控制通道认领者 —— 耐久离线 blocker 是交接的底座,不参与 live 认领迭代。 */
function liveDeliveryClaimants(): SessionpageDeliveryTarget[] {
  return registeredTargets.filter((target) => target !== (localSessionDeliveryTarget as SessionpageDeliveryTarget))
}

/**
 * 处置权的完整钥匙(spec session-injection「Claim 句柄只含 `(agentUserId, conversationId)`」)。
 * 只拿 `agentUserId` 分不清「这个 agent 名下的旧属主」与「这条会话自己的属主」,而交接跑在自己
 * 身上就是把自己处置掉。
 */
// ⚠️ 不另开一份同形的类型:`EmdashAgentRegistration` 本来就是这个 claim 句柄(它的字段注释写着
// 「Delivery claimant handle」+「The conversation whose control channel this claimant owns」),
// 两份必然漂。这里只给这个概念一个名字。
export type SessionpageDeliveryClaim = EmdashAgentRegistration

/** 各家 harness 自己的原生控制通道 —— 内核的两个角色按定义是占位,交接要交的就是它们。 */
function nativeDeliveryClaimants(): SessionpageDeliveryTarget[] {
  return registeredTargets.filter((target) =>
    target !== (localSessionDeliveryTarget as SessionpageDeliveryTarget)
    && target !== (emdashAgentRegistry as SessionpageDeliveryTarget))
}

/**
 * 这条 claim 的**原生控制通道**属主此刻是不是已经 live —— 本判断的唯一产地,交接与清场都只读它。
 *
 * `liveSessionIdByAgent` 报的是产品 conversation(@@@4629 那一格订下的口径),所以它正好是这把
 * 钥匙的另一半:相等 ⇒ 认领这条 claim 的就是它自己。ACP 兼容 owner 与 local-session 离线
 * blocker 不算属主 —— 它们是等原生通道起来的占位,本来就该被交接掉。
 */
export function nativeOwnerHoldsSessionpageDeliveryClaim(claim: SessionpageDeliveryClaim): boolean {
  return nativeDeliveryClaimants()
    .some((target) => target.liveSessionIdByAgent(claim.guguAgentUserId) === claim.sessionId)
}

// 内核角色在此登记;各 harness 的原生认领者(claude rendezvous / codex app-server / 未来新家)
// 在各自模块里自注册。
registerSessionpageDeliveryTarget(emdashAgentRegistry)
registerSessionpageDeliveryTarget(localSessionDeliveryTarget)

/**
 * Restore a durable session-TUI claimant after its native control channel is released.
 *
 * The offline owner is installed first, so there is no owner=0 gap. Every live claimant with a
 * synchronous release point is then cleared; an async-release claimant (app-server 类) reaches this
 * function only as its own release callback, so its entry is already gone. Ordinary delivery
 * therefore remains pending/fail-loud and cannot fall through to gugu-native ACP; the destructive
 * reaper is the only caller that removes this claimant permanently.
 */
export function restoreSessionpageOfflineDeliveryOwner(
  blocker: EmdashAgentRegistration,
  providerId: string,
): void {
  registerOfflineLocalSessionDelivery(blocker.guguAgentUserId, {
    sessionId: blocker.sessionId,
    providerId,
  })
  // A previous compatibility/native claimant must not remain alongside the offline owner: the
  // router treats that as ambiguous. The offline registration is installed first, so the swap
  // happens inside one synchronous turn — no observable owner=0 window.
  for (const target of liveDeliveryClaimants()) {
    target.releaseAgentClaim?.(blocker.guguAgentUserId)
  }
}

/**
 * Put an addressable identity behind a fail-loud owner before an async native adapter starts. The ACP
 * (`emdashAgentRegistry`) registration is also the final owner for ACP cells; for native cells it is an offline transition blocker.
 */
export async function prepareSessionpageDeliveryOwner(
  ownerKind: SessionpageDeliveryOwnerKind,
  blocker: EmdashAgentRegistration,
  options: { providerId?: string } = {},
): Promise<void> {
  // 交接只在**属主的种类要变**的时候才发生。这条 claim 的原生控制通道已经 live,而这一趟要装的
  // 又正是原生属主(`native`)、或只是个离线占位(`none`)⇒ 什么都不变,整趟不发生:
  // 先装离线 blocker 再清 live 认领者,跑在自己身上就是把自己那条会话处置掉
  // (#5415:聊天页 `ensureAgentAddress` 重入开户,把正在等首轮投递的 codex app-server 会话
  // dispose 了,报 `closed before first injected turn`)。
  //
  // 这与 spec agent-provisioning 的「幂等」是同一句话:同一会话重开命中缓存就复用现有身份,
  // **绝不二次开户** —— 投递归属也在「不二次」的范围里,否则幂等只幂到身份、不幂到属主。
  // ⚠️ 判据是**属主的种类**,❌ 不是「它是不是正在等首轮」那种时序补丁。
  //
  // ⚠️ `emdash` 不在此列:那是**真的换种类**(编程腿 → 通用腿)。`switchSessionRuntime` 走的
  // `dehydrateSession` 只 detach、按契约**不处置** app-server(留着重开复用),所以到这里时
  // 原生属主还活着 —— 那一支必须照旧把它降级,并把兼容 owner 装在它自己的释放点上。
  if (ownerKind !== 'emdash' && nativeOwnerHoldsSessionpageDeliveryClaim(blocker)) return
  if (ownerKind === 'none') {
    if (options.providerId) {
      // Reserve local-session ownership before the PTY roster binding exists. The live PTY registration
      // promotes this entry atomically; until then bridge delivery remains pending instead of falling
      // through to a native engine.
      registerOfflineLocalSessionDelivery(blocker.guguAgentUserId, {
        sessionId: blocker.sessionId,
        providerId: options.providerId,
      })
    }
    // The blocker is installed before this await. Any old ACP/native owner is then removed without
    // exposing an owner=0 window; a transient duplicate is rejected by router cardinality checks.
    await releaseSessionpageDeliveryClaimsExcept(blocker)
    return
  }
  if (ownerKind === 'native') {
    if (!options.providerId) {
      throw new Error(
        `[sessionpage] native session-page owner ${blocker.guguAgentUserId} has no provider id for offline blocker`,
      )
    }
    // Native startup has not registered its control channel yet. Reserve the durable local-session owner
    // before disposing any stale native/ACP claimant; if capability materialization or PTY spawn fails,
    // the same blocker remains in place and delivery cannot fall through to a gugu-native engine.
    registerOfflineLocalSessionDelivery(blocker.guguAgentUserId, {
      sessionId: blocker.sessionId,
      providerId: options.providerId,
    })
    await releaseSessionpageDeliveryClaimsExcept(blocker)
    return
  }
  // ownerKind === 'emdash':把 ACP 兼容 owner 装到旧认领者的**同步释放点**上。
  const agentUserId = blocker.guguAgentUserId
  let replaced = false
  const installCompatibilityOwner = () => {
    if (replaced) return
    replaced = true
    registerEmdashAgent(blocker)
    // Clearing the other claimants inside the same synchronous turn keeps the identity claimed
    // throughout: no owner=0 window, and any transient duplicate stays un-awaited (unobservable).
    for (const target of liveDeliveryClaimants()) {
      if (target === (emdashAgentRegistry as SessionpageDeliveryTarget)) continue
      target.releaseAgentClaim?.(agentUserId)
    }
    unregisterLocalSessionDeliveryForAgent(agentUserId)
  }
  // 替换只能装在**实际持有者**的释放点上:装早了,异步处置未完成的旧 owner 会与新 owner 形成
  // 跨 await 的双主窗口(router 基数检查会把它当结构歧义拒掉)。没有异步持有者就立即装。
  const asyncClaimants = liveDeliveryClaimants().filter(
    (target) =>
      target !== (emdashAgentRegistry as SessionpageDeliveryTarget)
      && !target.releaseAgentClaim
      && target.unregisterAgent,
  )
  const holder = asyncClaimants.find((target) => target.liveSessionIdByAgent(agentUserId) !== null) ?? null
  if (!holder) installCompatibilityOwner()
  await Promise.all(asyncClaimants.map((target) =>
    target.unregisterAgent!(agentUserId, target === holder ? installCompatibilityOwner : undefined),
  ))
}

/** Native registration and blocker removal share one synchronous turn, so no delivery can observe zero owners. */
export function promoteSessionpageDeliveryOwner(
  guguAgentUserId: string,
  registerNativeOwner: () => void,
): void {
  registerNativeOwner()
  // A persisted native identity may have an offline blocker from boot. Register the real target first,
  // then remove both blockers in this same synchronous turn so no delivery can observe an unowned gap.
  // ⚠️ 只清这两个内核角色 —— ❌ 不迭代 live 认领者:刚注册的原生 owner 也在那张表里。
  unregisterLocalSessionDeliveryForAgent(guguAgentUserId)
  unregisterEmdashAgent(guguAgentUserId)
}

/** The native adapter invokes replacement at the exact point its map entry is removed. */
export async function demoteSessionpageDeliveryOwner(
  blocker: EmdashAgentRegistration,
  providerId: string,
  unregisterNativeOwner: (replaceAfterRelease: () => void) => Promise<void>,
): Promise<void> {
  await unregisterNativeOwner(() => restoreSessionpageOfflineDeliveryOwner(blocker, providerId))
}

/** A native registry that owns the registration can return it at the exact synchronous release point. */
export function demoteSessionpageDeliveryOwnerFromRegistration(
  unregisterNativeOwner: (
    replaceAfterRelease: (blocker: EmdashAgentRegistration) => void,
  ) => void,
  providerId: string,
): void {
  unregisterNativeOwner((blocker) => restoreSessionpageOfflineDeliveryOwner(blocker, providerId))
}

export async function runSessionpagePtyTeardownSteps({
  stopTransport,
  settlePlatform,
  restoreCompatibilityOwner,
}: {
  stopTransport: () => Promise<void>
  settlePlatform: () => Promise<void>
  restoreCompatibilityOwner: () => void
}): Promise<void> {
  const errors: unknown[] = []
  try {
    restoreCompatibilityOwner()
  } catch (error) {
    errors.push(error)
  }
  try {
    await stopTransport()
  } catch (error) {
    errors.push(error)
  }
  try {
    await settlePlatform()
  } catch (error) {
    errors.push(error)
  }
  if (errors.length === 1) throw errors[0]
  if (errors.length > 1) {
    throw new AggregateError(errors, 'Session-page PTY teardown failed in multiple lifecycle steps')
  }
}

/**
 * 交接前清场:释放这条 claim **之外**的 live 认领者。
 *
 * 带上 `conversationId` 才有资格处置 —— 这就是 claim 句柄要完整的理由:少了它,「清掉这个 agent 的
 * 旧属主」与「清掉这条会话自己的属主」在调用点上完全同形(#5415 就是后者)。这条 claim 自己的原生
 * 属主不在释放面里;要连它一起清,那是删身份,走下面那个具名的破坏性边界。
 */
export async function releaseSessionpageDeliveryClaimsExcept(claim: SessionpageDeliveryClaim): Promise<void> {
  // 保住的只有「认领这条 claim 的原生通道」那一个 —— ACP 兼容 owner 即使记着同一条 conversation
  // 也照清:它是占位,交接要交的就是它。
  const ownersOfThisClaim = new Set(
    nativeDeliveryClaimants()
      .filter((target) => target.liveSessionIdByAgent(claim.guguAgentUserId) === claim.sessionId),
  )
  const pending: Array<void | Promise<void>> = []
  for (const target of liveDeliveryClaimants()) {
    if (ownersOfThisClaim.has(target)) continue
    // 同步释放点先清完,异步处置(app-server 类)再一起等 —— 与释放契约同序,不留跨 await 的旧认领。
    if (target.releaseAgentClaim) target.releaseAgentClaim(claim.guguAgentUserId)
    else if (target.unregisterAgent) pending.push(target.unregisterAgent(claim.guguAgentUserId))
  }
  await Promise.all(pending)
}

/** Destructive identity/roster deletion boundary: clear every ordinary-message claimant, including TUI. */
export async function unregisterSessionpageDeliveryOwners(guguAgentUserId: string): Promise<void> {
  unregisterLocalSessionDeliveryForAgent(guguAgentUserId)
  // 身份正在被删除 ⇒ 这个 agent 名下**每一条** conversation 的认领都要摘,所以这里不带 claim:
  // 没有「要保住的那一条」。这是唯一一个不按 claim 句柄收窄的出口,它的名字就是它的授权。
  const pending: Array<void | Promise<void>> = []
  for (const target of liveDeliveryClaimants()) {
    if (target.releaseAgentClaim) target.releaseAgentClaim(guguAgentUserId)
    else if (target.unregisterAgent) pending.push(target.unregisterAgent(guguAgentUserId))
  }
  await Promise.all(pending)
}
