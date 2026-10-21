/**
 * 纯函数单独一份:挂在 hook 文件里的话,单测一 import 就把 deviceRpc/supabase 那片图拖进 node,
 * 在 mac1 上直接 collect 失败 —— 判据连跑都没跑。
 *
 * 刚建的会话,记录文件要等 agent 写下第一行才存在 —— 真机实测:手机 2.9s 落进时间线,
 * claude 的记录 18s 后才落盘,中间读快照一律 `record_not_found`。这段时间**不是故障**,
 * 是新会话的常态;在这里报红要人手点「重新读取」,等于把一次正常的等待做成了一次事故。
 * 所以 `record_not_found` 在一个有限窗口内自动重试,过了窗口才当真报错(它可能真的没了)。
 *
 * 纯函数,好让「窗口内重试、窗口外报错、别的错误码不重试」三条各有一条会红的判据。
 * @returns 下一次重试要等多久;null = 不重试,按错误处理。
 */
export const RECORD_WAIT_WINDOW_MS = 45_000
export const RECORD_WAIT_RETRY_MS = 2_000
export function recordWaitDelay(code: string | null, elapsedMs: number): number | null {
  if (code !== 'record_not_found') return null
  if (elapsedMs >= RECORD_WAIT_WINDOW_MS) return null
  return RECORD_WAIT_RETRY_MS
}

/**
 * 「这次读失败了,要不要自己再试一次?」—— 读时间线**唯一**的重试判据。
 *
 * owner 2026-09-08:「如果是要加载消息,正常加载就好了,不应该是先报一个红色的报错、
 * 等我刷新之后才显示出来,这个问题蛮严重的。」他撞见的正是这条路以前的行为:除了
 * `record_not_found` 之外**任何**一次失败都当场画红框 + 一个「重新读取」按钮 ——
 * 而那些失败里最常见的一类(广播频道刚开、机器一时没应答)按一下按钮就好了。
 * 把这一下按钮留给人,等于把一件机械活派给用户。
 *
 * 三类分开:
 *   ① `record_not_found` —— 新会话还没写下第一行,窗口内慢慢等(上面那条,窗口 45s)。
 *   ② **会自己好的**:传输层失败(超时、频道没连上 ⇒ 没有业务错误码,`code` 为 null)、
 *      记录一时读不动(正在被写)。退避重试有限几次,期间界面停在**普通加载态**。
 *   ③ **不会自己好的**:这台机器上没这条会话、这种记录不支持、载荷不合法 ——
 *      立刻报红。重试它只是把同一句错话说四遍。
 *
 * ⚠️ 重试次数有限:无限重试会把「打不开」变成一个永远转圈的界面,那比红框更糟 ——
 * 人不知道该等还是该走。退避走完仍失败,就如实报出原文。
 *
 * @param attempt 这是第几次失败(第一次失败传 1)。
 * @returns 下次重试等多久;null = 别重试了,按错误处理。
 */
export const TRANSIENT_LOAD_CODES = new Set(['record_unreadable', 'timeline_failed', 'empty_reply'])
export const LOAD_RETRY_DELAYS_MS = [600, 1_500, 3_000]

export function loadRetryDelay(input: {
  code: string | null
  attempt: number
  elapsedMs: number
}): number | null {
  if (input.code === 'record_not_found') return recordWaitDelay(input.code, input.elapsedMs)
  // code 为 null = 没有业务错误码 = 这次失败发生在传输层(超时/频道没开起来),那一类会自己好。
  const transient = input.code === null || TRANSIENT_LOAD_CODES.has(input.code)
  if (!transient) return null
  return LOAD_RETRY_DELAYS_MS[input.attempt - 1] ?? null
}
