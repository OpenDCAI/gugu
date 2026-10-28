import type { Device } from '@gugu/core/shared/types/chat'

/**
 * 上次那份机器列表。
 *
 * 为什么要存：机器列表是手机端进 App 看到的**第一页**，而它原先每次冷启动都从空白 + 转圈开始，
 * 要等一次网络往返才有东西（owner 2026-09-09：「手机上有些东西不需要每次都重新去请求」）。
 *
 * 为什么这一格用 `localStorage` 而不是 IndexedDB（看会话那半刚换过去）：判据是**大小与写频**，
 * 不是"哪个更高级"。机器列表就几条、几 KB，且只在变更时写；而首帧要的恰恰是**同步**读到 ——
 * 异步读会把第一帧推到下一个宏任务，白白闪一下空列表。IndexedDB 的价值在于装得下大数据、
 * 写大不阻塞主线程，那是消息历史的形状，不是这张表的形状。
 *
 * ⚠️ 存的是**上次已知**的状态，不是此刻的事实：在线与否会变。所以它只活到第一次 `refresh`
 * 返回为止；点进一台其实已经离线的机器，会话页有现成的离线提示接着，❌ 不会走成一条死路。
 *
 * ⚠️⚠️ **❌ 不要在「当前没有登录用户」时清这份缓存。** 真机上连撞两次：
 *   · 冷启动的头一瞬，会话还没从本地恢复出来；
 *   · `DevicesProvider active={effectsActive}`，界面不活跃时它自己就把 user 置空；
 *   · 断网时 token 刷不动，看起来也像「登出了」。
 * 三种都不是登出，而清一次就把刚要用上的那份删干净 —— 缓存还在、界面照样空白，
 * 这种错**看不出来**。所以换账号那件事靠**记住这份属于谁**来解决，不靠清：
 * 登录的人对不上就当没有缓存。
 */
const CACHE_KEY = 'gugu.devices.v1'
const listeners = new Set<() => void>()

/** 原始设备读数变更(心跳上线/离线)；与控制面的休眠状态一起决定是否开线。 */
export function subscribeCachedDevices(listener: () => void): () => void {
  listeners.add(listener)
  return () => { listeners.delete(listener) }
}

type CachedDevices = { accountId: string | null; rows: readonly Device[] }

function readRaw(): CachedDevices {
  try {
    const raw = localStorage.getItem(CACHE_KEY)
    const parsed: unknown = raw ? JSON.parse(raw) : null
    if (!parsed || typeof parsed !== 'object' || !Array.isArray((parsed as CachedDevices).rows)) {
      return { accountId: null, rows: [] }
    }
    const one = parsed as CachedDevices
    // 形状不对的行逐行丢:这份是可再生的,❌ 不为它做迁移,也 ❌ 不让它把启动带崩。
    return {
      accountId: typeof one.accountId === 'string' ? one.accountId : null,
      rows: one.rows.filter((row): row is Device => !!row && typeof (row as Device).device_id === 'string')
    }
  } catch {
    return { accountId: null, rows: [] }
  }
}

/** 第一帧用的那份。此刻还不知道登录的是谁，所以先照 `accountId` 记着，等认出人来再对。 */
export function readCachedDevices(): Device[] {
  return [...readRaw().rows]
}

/** 这份缓存属于谁。null = 没有缓存，或者是旧版本存的（那就当没有）。 */
export function cachedDevicesAccount(): string | null {
  return readRaw().accountId
}

export function writeCachedDevices(accountId: string | null, rows: readonly Device[]): void {
  try {
    localStorage.setItem(CACHE_KEY, JSON.stringify({ accountId, rows } satisfies CachedDevices))
  } catch {
    /* 存不下(配额满/隐私模式)只是回到「每次都等一次往返」,不影响这一次已经拿到的列表。 */
  }
  for (const listener of listeners) listener()
}

/**
 * 认出登录的人之后，该拿这份缓存怎么办。
 *
 * 单拎成纯函数，是因为**它错过两次，而且两次都看不出来**：第一版把「user 为空」
 * 当成登出去清缓存 —— 可 user 为空还有三种别的来由（会话没恢复完、界面不活跃时
 * `active=false`、断网刷不动 token），每一种清一次，缓存就没了，而界面看上去
 * 只是「又在读取」。所以现在**一律不清**，换账号靠对名字解决。
 */
export type DeviceCacheAction = 'refresh' | 'hold' | 'drop-foreign'

export function deviceCacheAction(input: {
  user: { id: string } | null
  authLoading: boolean
  cachedAccountId: string | null
}): DeviceCacheAction {
  if (!input.user) return 'hold'
  // 认出人了，而缓存写着别人的名字 ⇒ 那份不是他的，丢掉重来。
  if (input.cachedAccountId !== null && input.cachedAccountId !== input.user.id) return 'drop-foreign'
  return 'refresh'
}
