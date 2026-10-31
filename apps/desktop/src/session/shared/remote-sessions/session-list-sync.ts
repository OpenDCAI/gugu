import type {
  SessionpageProjectSummary,
  SessionpageSessionSummary,
  SessionpageSessionsEvent,
  SessionpageSessionsListResult,
} from '@gugu/session-core/session-record/contract'
import { applySessionListEvent } from '@gugu/session-core/session-record/session-list-delta'
import type { DeviceSessionSummary } from '@gugu/core/shared/types/chat'
import { reconnectDelayMs } from '@/session/shared/remote-reconnect'

/** 让「一台机器上有哪些会话」这张表**活着**所需的那几问(手机用 sessionpage-rpc.ts 那一组;单测换成假的)。 */
export type SessionpageSessionListClient = {
  subscribeSessionsList(deviceId: string, subscriptionId: string): Promise<unknown>
  unsubscribeSessionsList(deviceId: string, subscriptionId: string): Promise<unknown>
  subscribeSessionsListEvents(deviceId: string, subscriptionId: string, onEvent: (event: SessionpageSessionsEvent) => void): () => void
  /** 到那台机器的窗口断了 / 又通了。又通 = 那边已拆了这条窗口上的订阅,要重订。 */
  onLinkChange(deviceId: string, cb: (open: boolean) => void): () => void
}

export type SessionListSyncHandlers = {
  /** 拿到那台机器此刻的一份(首列、推送、补列都走这里)。没读到之前画什么见 deviceSessionsOf(它上报过的那份)。 */
  onList: (result: SessionpageSessionsListResult) => void
  onLoading?: (loading: boolean) => void
  onError?: (message: string | null) => void
  onLink?: (open: boolean) => void
}

export type SessionListSync = {
  /** 「重新连接」:不等退避,整个重来一遍(新订阅号、重新列)。 */
  reconnect: () => void
  stop: () => void
}

/**
 * 一条到那台机器的窗口通过一次之后:断了报 false,又通了报 true。又通 = 那台机器已经拆了上一条窗口上的订阅
 * (订阅跟着窗口生灭),调用方要重订、补齐。第一次就接通不报 —— 那时调用方正在订;开线失败过(落回 closed)
 * 再接通要报:调用方那时发的问已随失败的那次落空,❌ 让它等自己的退避(冷启动实撞:晚 5 s)。手机与桌面同一份。
 */
export function linkChangesOf(
  client: { state(): string; onStateChange(cb: (state: string) => void): () => void },
  cb: (open: boolean) => void,
): () => void {
  let open = client.state() === 'open'
  let seen = open
  return client.onStateChange((state) => {
    if (state === 'closed') seen = true
    const now = state === 'open'
    if (now === open) return
    open = now
    if (seen) cb(now)
    seen ||= now
  })
}

function newSubscriptionId(): string {
  const randomUUID = globalThis.crypto?.randomUUID
  if (typeof randomUUID !== 'function') {
    throw new Error('crypto.randomUUID is required to mint a sessionpage subscription id')
  }
  return randomUUID.call(globalThis.crypto)
}

/**
 * 一台**在线**机器的会话列表:订阅(订上那一刻宿主推一份整的,之后只推变了的行,在这里合);
 * 到那台机器的窗口断过再通(订阅随旧窗口拆了,丢了推送也走这条)就整个重来。
 */
export function startSessionListSync(
  client: SessionpageSessionListClient,
  deviceId: string,
  handlers: SessionListSyncHandlers,
): SessionListSync {
  let stopped = false
  let stopRound: (() => void) | null = null
  /** 连着列不出来几次了(决定下一次等多久:5、5、10…30 秒,与桌面断线重连同一份节奏)。 */
  let failures = 0
  let retryTimer: ReturnType<typeof setTimeout> | null = null

  const take = (result: SessionpageSessionsListResult) => {
    if (!stopped) handlers.onList(result)
  }

  const startRound = () => {
    let cancelled = false
    const subscriptionId = newSubscriptionId()
    handlers.onLoading?.(true)
    // 上一轮的错误留到这一轮真列出来再清:每轮重试开头就清的话,连不上的机器会在「出错」与「读取中」之间来回闪,
    // 界面上看就是永远停在「正在读取」。
    // 先挂监听再订阅:反过来的话,宿主订上那一刻推的整份没人收。合并的底只认这一轮的整份。
    let current: SessionpageSessionsListResult | null = null
    /*
     * 这一轮没成(订不上、整份之前来了增量 = 约定破了):报错,自己再试(机器刚上线频道还没开、一时没应答都会自己好),
     * ❌ 停在一个空列表上等人刷新,也 ❌ 不等退避就连着重订。那台机器不认这个接口(太旧)不会自己好,不重试;
     * 那台机器此刻够不着(unreachable,离线)也不重试 —— 线开了(onLinkChange)再重来。
     */
    const failRound = (err: unknown) => {
      handlers.onError?.(err instanceof Error ? err.message : String(err))
      const code = err && typeof err === 'object' ? (err as { code?: unknown }).code : undefined
      if (code === 'server_outdated' || code === 'client_outdated' || code === 'unreachable' || stopped || retryTimer) return
      failures += 1
      retryTimer = setTimeout(() => {
        retryTimer = null
        if (stopped) return
        stopRound?.()
        stopRound = startRound()
      }, reconnectDelayMs(failures + 1))
    }
    const stopEvents = client.subscribeSessionsListEvents(deviceId, subscriptionId, (event) => {
      if (cancelled) return
      try {
        current = applySessionListEvent(current, event)
      } catch (err) {
        cancelled = true
        failRound(err)
        return
      }
      take(current)
      handlers.onError?.(null)
    })

    void (async () => {
      try {
        await client.subscribeSessionsList(deviceId, subscriptionId)
        if (cancelled) return
        failures = 0
      } catch (err) {
        if (cancelled) return
        failRound(err)
      } finally {
        if (!cancelled) handlers.onLoading?.(false)
      }
    })()

    return () => {
      cancelled = true
      stopEvents()
      void client.unsubscribeSessionsList(deviceId, subscriptionId).catch(() => undefined)
    }
  }

  stopRound = startRound()
  // 窗口断过再通:那台机器已经拆了旧窗口上的订阅,整个重来(新订阅号、重新列)。
  const stopLink = client.onLinkChange(deviceId, (open) => {
    if (!stopped) handlers.onLink?.(open)
    if (!open || stopped) return
    // 窗口通了就重来,在等的退避作废:那一轮是因为窗口没通才失败的。
    if (retryTimer) clearTimeout(retryTimer)
    retryTimer = null
    stopRound?.()
    stopRound = startRound()
  })
  return {
    reconnect: () => {
      if (stopped) return
      if (retryTimer) clearTimeout(retryTimer)
      retryTimer = null
      failures = 0
      stopRound?.()
      stopRound = startRound()
    },
    stop: () => {
      if (stopped) return
      handlers.onLink?.(false)
      stopped = true
      stopLink()
      if (retryTimer) clearTimeout(retryTimer)
      retryTimer = null
      stopRound?.()
      stopRound = null
    },
  }
}

/**
 * 没读到那台机器此刻的列表时,退回**心跳带上来的那份摘要**(Device.session_digest)。
 *
 * 机器离线:每条都标成 supported=false,时间线本来就打不开,❌ 不留一行点得动、点进去只会等超时的会话。
 * 原因不逐行写 —— 离线是整台机器的事。机器在线(还在读 / 一时连不上):照那台机器自己报的,点进去由会话页接着连。
 */
export function sessionListFromDigest(digest: readonly DeviceSessionSummary[] | null | undefined, online = false): SessionpageSessionsListResult {
  const byId = new Map<string, SessionpageProjectSummary>()
  const sessions: SessionpageSessionSummary[] = []
  for (const entry of digest ?? []) {
    // 摘要里没名字的不是项目(任务工作区 #590、#609 起每个 workspace):它的会话读方列进「任务」,❌ 画成一格没名字的项目。
    if (entry.projectId && entry.projectName && !byId.has(entry.projectId)) {
      byId.set(entry.projectId, { id: entry.projectId, name: entry.projectName, path: '' })
    }
    sessions.push({
      ...(entry.nativeInputVersion === 1 ? { nativeInputVersion: 1 as const } : {}),
      ...(entry.nativeUnreadCount !== undefined ? { nativeUnreadCount: entry.nativeUnreadCount } : {}),
      conversationId: entry.conversationId,
      projectId: entry.projectId,
      title: entry.title,
      harness: entry.harness,
      runtime: entry.runtime ?? 'unknown',
      agentStatus: entry.agentStatus,
      // 新宿主在摘要里另带读数(基础态 + 附属态);老宿主只有旧词,读方(watch-status 的 sessionReading)退回它。
      ...(entry.status !== undefined ? { status: entry.status } : {}),
      lastInteractedAt: entry.lastInteractedAt,
      supported: online && entry.supported,
      ...(entry.isPinned !== undefined ? { isPinned: entry.isPinned } : {}),
      ...(entry.unseen !== undefined ? { unseen: entry.unseen } : {}),
      ...(entry.parentConversationId !== undefined ? { parentConversationId: entry.parentConversationId } : {}),
      ...(entry.agentUserId !== undefined ? { agent: entry.agentUserId ? { userId: entry.agentUserId } : null } : {}),
    })
  }
  return { projects: [...byId.values()], sessions }
}
