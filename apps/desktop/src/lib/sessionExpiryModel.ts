// @@@3898 「手上这个会话现在还能不能写」—— 纯判定,便于单测,也便于说清它**不是**什么。
//
// 它不是「用户有没有登录」(那是 user 是否为空),也不是「refresh 有没有永久失败」
// (那是 SessionCoordinator 的 'expired',会清掉 user 并落到登录页 —— 那条路本来就响亮)。
// 它是中间那一格:**会话还在、user 还在、界面照常渲染,但令牌已经过期**。
// SessionCoordinator 在 refresh 失败且错误不是永久性时进入 'degraded' 并无限重试
// (scheduleRetry),此时 user 保留 ⇒ App.tsx 走的是完全正常的授权分支。
// owner 实测(#3898):expires_at 已过、REST 一路 401,而会话列表、composer、「新建 Agent」
// 全部照常可用可点,屏幕上一个字都不说。产品是 local-first 的,恰恰是缓存把症状盖住了 ——
// 那正是铁律里「❌ 护栏盖症状」的形状。
//
// 判据取**会话自身的到期时间**,❌ 不取「某条请求 401」:单条 RPC 的授权边界同样会 401
// (例如对不可见 agent 的 presence 查询),把那个当成登录失效会把用户从一个完全正常的会话里赶出去。

/**
 * 过期之后再宽限这么久才算数。会话协调器在到期前 REFRESH_EARLY_MS 续期,
 * 不留宽限的话,一次正常的续期窗口就会闪一条「登录已失效」——那是另一个方向的假话。
 */
export const SESSION_WRITE_BLOCKED_GRACE_MS = 60_000

export function isSessionPastExpiry(
  session: { expires_at?: number | null } | null | undefined,
  nowMs: number,
  graceMs: number = SESSION_WRITE_BLOCKED_GRACE_MS,
): boolean {
  // expires_at 缺失 = 这份会话没说过它什么时候到期。「不知道」不是「已过期」,
  // 不能凭空给用户一条「登录已失效」。
  if (!session || typeof session.expires_at !== 'number') return false
  return nowMs >= session.expires_at * 1000 + graceMs
}

// @@@4395 「该不该出声」的纯判定。owner 拍板:**可恢复期不出声,失效才出声**
// —— 可恢复时很快就恢复,突然在顶部出现横栏反而打扰。
//
// 关键在计时基准:安静窗口从**产品真正有机会重试的那一刻**起算,❌ 不从令牌到期起算。
// 合盖一夜、离线一小时,这些时间里一次重试机会都没有;把它们算进「一直救不回来」,
// 结果就是一开盖立刻弹一条下一秒就要自己消失的告警 —— 那正是 owner 撞到的形状。

/** 可恢复期的安静窗口。实测:网络恢复后 90s 内自愈完成,退避重试最长一轮 30s。 */
export const SESSION_RECOVERY_QUIET_MS = 60_000
/** 两次求值间隔明显超过一次轮询 = 进程被挂起过(休眠);那段没有重试机会,不计入。 */
export const SESSION_SUSPEND_GAP_MS = 30_000

export type WriteBlockedMemo = { strugglingSince: number | null; lastSeenAt: number }

/**
 * @param pastExpiry 会话是否已过有效期(含 supabase 自己的续期窗口宽限)
 * @returns 新的记忆与「此刻是否该出声」
 */
export function nextWriteBlockedState(
  memo: WriteBlockedMemo,
  pastExpiry: boolean,
  nowMs: number,
  quietMs: number = SESSION_RECOVERY_QUIET_MS,
  suspendGapMs: number = SESSION_SUSPEND_GAP_MS,
): { memo: WriteBlockedMemo; blocked: boolean } {
  // 挂起过 → 之前那段「救不回来」不算数,重新开始给机会。
  const suspended = nowMs - memo.lastSeenAt > suspendGapMs
  let strugglingSince = suspended ? null : memo.strugglingSince
  if (!pastExpiry) return { memo: { strugglingSince: null, lastSeenAt: nowMs }, blocked: false }
  if (strugglingSince === null) strugglingSince = nowMs
  return { memo: { strugglingSince, lastSeenAt: nowMs }, blocked: nowMs - strugglingSince >= quietMs }
}
