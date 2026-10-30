import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type {
  RecordCursor,
  SettlementResponse,
  SessionpageSessionRespondRequest,
  SessionpageSessionRespondResult,
  TimelineAfterResult,
  TimelineOlderResult,
  TimelineSnapshot,
} from '@gugu/session-core/session-record/contract'
import type { ToolImage } from '@gugu/session-core/acp/client'
import {
  applyLocalSettlement,
  applySnapshot,
  applyTimelineResult,
  emptyAgentWatchTimeline,
  prependOlder,
  withToolImage,
  type AgentWatchTimeline,
} from './agent-watch-store'
import { settlePendingSends, userMessageIds, type PendingSend } from './pending-sends'
import { loadRetryDelay, TRANSIENT_LOAD_CODES } from './record-wait'
import { hydrateCachedTimeline, readCachedTimeline, writeCachedTimeline } from './timeline-cache'

/** 读写**另一台机器**上一条会话所需的那几问(手机用 sessionpage-rpc.ts 那一组;单测换成假的)。 */
export type SessionpageTimelineClient = {
  fetchSnapshot(deviceId: string, sessionId: string, limit?: number): Promise<TimelineSnapshot>
  fetchAfter(deviceId: string, sessionId: string, cursor: RecordCursor): Promise<TimelineAfterResult>
  fetchOlder(deviceId: string, sessionId: string, beforeTurnId: string, limit?: number): Promise<TimelineOlderResult>
  /** 一张工具交回来的图(时间线里只有它的字数,见 transport-trim)。 */
  fetchToolImage(deviceId: string, sessionId: string, itemId: string, index: number): Promise<ToolImage>
  subscribeSession(deviceId: string, sessionId: string, subscriptionId: string, cursor: RecordCursor | null): Promise<unknown>
  unsubscribeSession(deviceId: string, subscriptionId: string): Promise<unknown>
  subscribeSessionEvents(deviceId: string, subscriptionId: string, onResult: (result: TimelineAfterResult) => void): () => void
  /** A transport that reads incrementally itself can expose a precise read failure. */
  subscribeSessionErrors?(deviceId: string, subscriptionId: string, onError: (error: unknown) => void): () => void
  /** 到那台机器的窗口断了 / 又通了。又通 = 那边已拆了这条窗口上的订阅,要重订。 */
  onLinkChange(deviceId: string, cb: (open: boolean) => void): () => void
  sendSessionText(
    deviceId: string,
    sessionId: string,
    text: string,
  ): Promise<unknown>
  cancelSessionTurn(deviceId: string, sessionId: string): Promise<{ cancelled: boolean }>
  respondToSettlement(deviceId: string, input: SessionpageSessionRespondRequest): Promise<SessionpageSessionRespondResult>
  /** 运行时说还在跑的后台命令(`null` = 没报、不筛);老版本电脑没有这条路由会抛。 */
  fetchBackgroundTasks?(deviceId: string, sessionId: string): Promise<{ runningCommandTaskIds: string[] | null }>
  /** 停一个后台任务(命令给 asyncTaskId,子智能体给派它的 tool_use id)。 */
  stopBackgroundTask?(deviceId: string, sessionId: string, stopId: string): Promise<{ stopped: true }>
}

/** 设备接口报的错带 code(跨 bundle 时 instanceof 不可靠,按形状认)。 */
function rpcErrorCode(err: unknown): string | null {
  if (err && typeof err === 'object' && typeof (err as { code?: unknown }).code === 'string') {
    return (err as { code: string }).code
  }
  return null
}

export type AgentWatchPhase = 'loading' | 'ready' | 'error'

/**
 * 和那台机器的链路。
 *  · connecting —— 正在(重新)快照 + 订阅;
 *  · ok —— 订阅上了,窗口通着;
 *  · lost —— 读不出来 / 补缺口失败 / 窗口断了。
 */
export type TimelineLink = 'connecting' | 'ok' | 'lost'


export type AgentWatchSession = {
  timeline: AgentWatchTimeline
  phase: AgentWatchPhase
  /** 打不开时的原因原文(fail loud,❌ 改写成「失败」)。 */
  /** 读时间线失败。整页级:时间线可能压根没有。 */
  error: string | null
  /** 动作(发消息/回答)失败。时间线是好的,❌ 别说成「打不开时间线」。 */
  actionError: string | null
  /** 还在 loading,且是在等那台机器写下记录的第一行(新会话的常态),不是普通的「正在读取」。 */
  waitingForRecord: boolean
  dismissActionError: () => void
  reload: () => void
  /** 往前翻更早的轮（懒加载）。手里一轮都没有时是空操作。 */
  loadOlder: () => Promise<void>
  /** 去机器上取一张工具图、写回那条条目(取不到原样抛出:图格画成取不到)。 */
  loadToolImage: (itemId: string, index: number) => Promise<void>
  send: (text: string) => Promise<void>
  /** 已按发送、记录里还没回来的那几句(见 pending-sends.ts),按发送先后。回显到了就不在这里了。 */
  pendingSends: readonly PendingSend[]
  respond: (input: SettlementResponse) => Promise<SessionpageSessionRespondResult>
  sending: boolean
  respondingItemId: string | null
  /** 停掉正在飞的一轮(桌面端同一条取消口)。受理即返回;是否真停了看时间线结算。 */
  cancel: () => Promise<void>
  cancelling: boolean
  link: TimelineLink
  /** 最近一次读失败的错误码(太旧 / 会话没了这类要换说法);传输层失败是 null。 */
  errorCode: string | null
}

/**
 * 等本地库最多这么久。
 *
 * 它只是为了不白拉一次整份快照，所以宁可等一小会儿；但本地库卡住（配额、被禁、
 * 另一个标签页占着升级）❌ 不能把「打开会话」拖死 —— 超时就当没有存过，照旧整份拉。
 */
const HYDRATE_BUDGET_MS = 400

const NO_SENDS: readonly PendingSend[] = []

function newLocalId(): string {
  const randomUUID = globalThis.crypto?.randomUUID
  if (typeof randomUUID !== 'function') {
    throw new Error('crypto.randomUUID is required to mint a sessionpage subscription / pending-send id')
  }
  return randomUUID.call(globalThis.crypto)
}

function describe(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err)
  const code = rpcErrorCode(err)
  return code ? `${message} (${code})` : message
}

/**
 * 打开一台**在线**机器上的一条会话:先快照、再订阅、断线只补缺口。
 *
 * 三条路都汇进同一个 reducer(见 agent-watch-store):
 *   ① 进入时的整份快照
 *   ② 订阅推来的增量
 *   ③ 重连 / 回前台后拿 cursor 调 after 补的那一段
 * ❌ 不为「重连」另写一套合并逻辑 —— 两套合并必然分叉,而分叉的症状是消息重复或缺一段。
 */
export function useTimelineSession(
  client: SessionpageTimelineClient,
  /** 回答者标识,进 `Settlement.resolvedBy`,只用于显示「已在某端回答」(哪一端答的,不是设备 id)。 */
  responderId: string,
  deviceId: string | null,
  sessionId: string | null,
  enabled: boolean,
  /** 刚建的会话:建它时带的那句,机器已受理。挂载时就是一句在路上的发送,记录里那一行到了照常让位。 */
  firstPrompt?: string,
): AgentWatchSession {
  /*
   * 内存里有上次看到的那一份就拿它当**初值**:第一帧就是完整的时间线。❌ 先画一帧空线程、再在下面的 effect 里换上 ——
   * 那一帧(真机几百 ms)里写的是「Nothing in this task yet」,随后整段历史从透明淡入、再跳到底:
   * owner 10-12「进运行中的任务页,一进去就颤两下」。下面 effect 里那次读照旧,换会话时靠它。
   */
  const [timeline, setTimeline] = useState<AgentWatchTimeline>(() =>
    (enabled && deviceId && sessionId ? readCachedTimeline({ deviceId, sessionId }) : null) ?? emptyAgentWatchTimeline())
  const [phase, setPhase] = useState<AgentWatchPhase>(() => (timeline.cursor ? 'ready' : 'loading'))
  const [error, setError] = useState<string | null>(null)
  const [link, setLink] = useState<TimelineLink>('connecting')
  const [errorCode, setErrorCode] = useState<string | null>(null)
  const [waitingForRecord, setWaitingForRecord] = useState(false)
  // 动作失败与读失败分开存:两者的标题、位置、能做的补救都不是一回事 ——
  // 发送失败时时间线好端端在那儿,套上「打不开时间线 + 重新读取」是在骗人。
  const [actionError, setActionError] = useState<string | null>(null)
  const [sending, setSending] = useState(false)
  // 乐观发送按会话存(`key`):换了会话,上一条会话的那几句在渲染时就不认,❌ 靠 effect 事后清 —— 那样会在新会话里闪一帧。
  const [pendingState, setPendingState] = useState<{ key: string; sends: readonly PendingSend[] }>(() => (firstPrompt
    ? { key: `${deviceId ?? ''}/${sessionId ?? ''}`, sends: [{ id: `pending:${newLocalId()}`, text: firstPrompt, baseline: new Set(), accepted: true }] }
    : { key: '', sends: NO_SENDS }))
  const [respondingItemId, setRespondingItemId] = useState<string | null>(null)
  const [reloadNonce, setReloadNonce] = useState(0)

  // cursor 走 ref:补缺口发生在事件回调/定时器里,读 state 会读到挂载那一刻的旧值。
  const cursorRef = useRef<RecordCursor | null>(null)
  // 快照落地前不收增量:此时手里还没有可续的那一份,收了只会得到一段悬空的尾巴。
  const readyRef = useRef(false)
  // 手里这份**已经和那台机器对过一次账**(整份快照落地,或本地底稿补完差量;记录还没写出来也算 —— 那时确实是空的)。
  // 乐观发送靠「发送那一刻已有哪些行」认回显,底稿还没对账时这份清单不全:之后补进来的整段都会被当成新行。
  const syncedRef = useRef(false)
  // 翻页要读「此刻最早那一轮」,而 loadOlder 被界面按钮以闭包形式握着 ——
  // 依赖 timeline 会让每次时间线更新都换一个新函数,读 ref 才拿得到当下那份。
  const timelineRef = useRef(timeline)
  timelineRef.current = timeline

  const applyResult = useCallback((result: TimelineAfterResult) => {
    setTimeline((current) => {
      const next = applyTimelineResult(current, result)
      cursorRef.current = next.cursor
      return next
    })
  }, [])

  const reload = useCallback(() => setReloadNonce((n) => n + 1), [])

  useEffect(() => {
    if (!enabled || !deviceId || !sessionId) return
    let cancelled = false
    const subscriptionId = newLocalId()
    const cacheKey = { deviceId, sessionId }
    readyRef.current = false
    syncedRef.current = false
    cursorRef.current = null
    setError(null)
    setLink('connecting')

    /*
     * 先把**上次看到的那一份**画出来(本地底稿),再去对账。
     * owner 2026-09-08 拍板要这一层:以前每次进页都得等机器把整份快照送过来才有东西看,
     * 于是首屏永远是「正在读取时间线…」。底稿不是事实源 —— 它只活到下面第一次对账为止。
     */
    const cached = readCachedTimeline(cacheKey)
    if (cached) {
      setTimeline(cached)
      cursorRef.current = cached.cursor
      readyRef.current = true
      setPhase('ready')
    } else {
      setPhase('loading')
    }

    /*
     * 补缺口失败不清空已有的那一份:屏幕上那段仍然是真的,只是没有更新。会自己好的那类(与首读同一张
     * `TRANSIENT_LOAD_CODES`)只把链路标成断开,❌ 报红(#6738);窗口重开、回前台都会再补。
     * 机器明确拒绝的才如实报原文,补上了就收回这一条 —— 别的路报的错(比如订阅没订上)不归这里管。
     * 补上一次就算和那台机器对过账了(syncedRef)。
     */
    let catchUpReported = false
    const catchUp = () => {
      const cursor = cursorRef.current
      if (!readyRef.current || !cursor) return
      void client.fetchAfter(deviceId, sessionId, cursor)
        .then((result) => {
          if (cancelled) return
          setLink('ok')
          if (catchUpReported) {
            catchUpReported = false
            setError(null)
            setErrorCode(null)
          }
          applyResult(result)
          syncedRef.current = true
        })
        .catch((err) => {
          if (cancelled) return
          setLink('lost')
          const code = rpcErrorCode(err)
          if (code === null || TRANSIENT_LOAD_CODES.has(code)) return
          catchUpReported = true
          setError(describe(err))
          setErrorCode(code)
        })
    }

    /*
     * 内存里没有 ⇒ 这是**冷启动后第一次**进这条会话，去本地库里捞上次那份。
     *
     * 下面的 `loadSnapshot` 会先等这一步：装上了就只订阅 + 补差量，一次整份快照都不用拉。
     * ❌ 不能不等就先拉快照 —— 那样"存了一份在本地"就只省下第一帧的空白，
     * 该请求的照样请求了一遍，而 owner 要的正是**不要每次都重新去请求**。
     * ⚠️ 但也不能无限等：本地库卡住（配额、被禁、另一个标签页占着升级）不该把打开会话拖死，
     * 所以给它一个上限，超时就当没有存档，照旧整份拉。
     */
    const hydrated: Promise<void> = cached
      ? Promise.resolve()
      : Promise.race([
          hydrateCachedTimeline(cacheKey),
          new Promise<null>((resolve) => setTimeout(() => resolve(null), HYDRATE_BUDGET_MS)),
        ]).then((stored) => {
          if (cancelled || readyRef.current || !stored) return
          setTimeline(stored)
          cursorRef.current = stored.cursor
          readyRef.current = true
          setPhase('ready')
        })

    // 先挂监听再发 subscribe:反过来的话,宿主在应答与挂监听之间推的那一批没人收。
    const stopEvents = client.subscribeSessionEvents(deviceId, subscriptionId, (result) => {
      if (cancelled || !readyRef.current) return
      applyResult(result)
    })
    const stopErrors = client.subscribeSessionErrors?.(deviceId, subscriptionId, (err) => {
      if (cancelled) return
      setLink('lost')
      const code = rpcErrorCode(err)
      if (code === null || TRANSIENT_LOAD_CODES.has(code)) return
      setError(describe(err))
      setErrorCode(code)
    })
    // 窗口断了:标断开;又通了:那台机器已经拆了这条订阅(订阅跟着窗口生灭),整个重来 —— 手里有游标就只重订 + 补差量。
    const stopLink = client.onLinkChange(deviceId, (open) => {
      if (cancelled) return
      if (open) reload()
      else setLink('lost')
    })

    const onVisible = () => {
      if (document.visibilityState === 'visible') catchUp()
    }
    document.addEventListener('visibilitychange', onVisible)

    const startedAt = Date.now()
    let retryTimer: ReturnType<typeof setTimeout> | null = null
    let attempt = 0
    setWaitingForRecord(false)

    const loadSnapshot = async (): Promise<void> => {
      try {
        // 先给本地那份一个装上的机会,再决定要不要整份拉(重试时它早已完成,await 是白拿的)。
        await hydrated
        if (cancelled) return
        // 手里已经有本地那份 ⇒ 只订阅 + 补差量,❌ 不再整份拉一次快照(那正是「加载很久」的来处)。
        // 世代对不上时机器会在订阅的第一推里直接回一份新快照,由 reducer 认出来。
        if (readyRef.current && cursorRef.current) {
          await client.subscribeSession(deviceId, sessionId, subscriptionId, cursorRef.current)
          if (cancelled) return
          setWaitingForRecord(false)
          setError(null)
          setErrorCode(null)
          setLink('ok')
          attempt = 0
          catchUp()
          return
        }
        const snapshot = await client.fetchSnapshot(deviceId, sessionId)
        if (cancelled) return
        setWaitingForRecord(false)
        setError(null)
        attempt = 0
        setTimeline((current) => applySnapshot(current, snapshot))
        cursorRef.current = snapshot.cursor
        readyRef.current = true
        syncedRef.current = true
        setPhase('ready')
        await client.subscribeSession(deviceId, sessionId, subscriptionId, snapshot.cursor)
        if (cancelled) return
        setErrorCode(null)
        setLink('ok')
      } catch (err) {
        if (cancelled) return
        const code = rpcErrorCode(err)
        attempt += 1
        /*
         * ⚠️ 会自己好的失败**自己再试一次**,期间界面停在普通加载态 ——
         * owner 2026-09-08:「不应该是先报一个红色的报错、等我刷新之后才显示出来」。
         * 判据在 record-wait.ts(纯函数),三类各有一条会红的用例。
         */
        const delay = loadRetryDelay({ code, attempt, elapsedMs: Date.now() - startedAt })
        if (delay !== null) {
          // 记录还没写出来:留在 loading,过一会儿再读;❌ 不报红。
          setWaitingForRecord(code === 'record_not_found')
          if (code === 'record_not_found') syncedRef.current = true
          retryTimer = setTimeout(() => { void loadSnapshot() }, delay)
          return
        }
        setWaitingForRecord(false)
        setError(describe(err))
        setErrorCode(code)
        setLink('lost')
        setPhase(readyRef.current ? 'ready' : 'error')
      }
    }
    void loadSnapshot()

    return () => {
      cancelled = true
      if (retryTimer) clearTimeout(retryTimer)
      stopLink()
      readyRef.current = false
      document.removeEventListener('visibilitychange', onVisible)
      stopEvents()
      stopErrors?.()
      // 走之前把手里这份存下来:下次进来第一帧就有东西。
      const current = timelineRef.current
      if (current.cursor && current.turns.length > 0) writeCachedTimeline(cacheKey, current)
      // 退订是尽力而为:页面已经走了,退订失败只会让宿主多推一会儿给没人听的 subscriptionId。
      void client.unsubscribeSession(deviceId, subscriptionId).catch(() => undefined)
    }
  }, [client, deviceId, sessionId, enabled, reloadNonce, applyResult, reload])

  // 世代变了 ⇒ 手里那份接不上,重新走一遍「快照 + 订阅」。
  useEffect(() => {
    if (timeline.needsSnapshot) reload()
  }, [timeline.needsSnapshot, reload])

  /*
   * 边看边存。**防抖**:一条流式消息每秒推好几次,每次都整份序列化 + 写库
   * 会把这点开销叠成卡顿 —— 那正是这一批要消灭的那种卡。
   * 页面走掉时的最后一次存在上面那个 cleanup 里(不依赖这个定时器还没烧完)。
   */
  useEffect(() => {
    if (!deviceId || !sessionId) return
    if (!timeline.cursor || timeline.turns.length === 0) return
    const timer = setTimeout(() => {
      writeCachedTimeline({ deviceId, sessionId }, timeline)
    }, 1_500)
    return () => clearTimeout(timer)
  }, [deviceId, sessionId, timeline])

  /**
   * 懒加载更早的轮。基准是手里**最早那一轮的 id**（❌ 不是下标：两次请求之间那一轮可能
   * 被分叉掉，下标会指到另一轮上去）。翻不动了由宿主报 hasOlder=false，界面据此收起入口。
   */
  const loadOlder = useCallback(async () => {
    if (!deviceId || !sessionId) return
    const oldest = timelineRef.current.turns[0]
    if (!oldest || !timelineRef.current.hasOlder) return
    try {
      const older = await client.fetchOlder(deviceId, sessionId, oldest.id)
      setTimeline((current) => prependOlder(current, older))
    } catch (err) {
      // 翻页失败不动手里那份：屏幕上那段仍然是真的。
      setActionError(describe(err))
    }
  }, [client, deviceId, sessionId])

  /**
   * 一张工具图去机器上取一次:取到的写回条目,和时间线一起存在手机上(timeline-cache),重开不重取。
   * 要不要取由图格看时间线定(共享转录的工具图格,和时间线同一次提交);这里只记**正在取的那一问**,
   * 同一张的问合成一问。这一问活到答复被用掉:写回的 updater 里放手 —— 写进去了,图格在同一次提交里就看到它;
   * 写不进去(取的途中条目离开了手里这份:换了会话、换代快照没带那一轮),答复作废,条目回来时那一格再取。
   * ❌ 回包一到就放手:写回还排在下一次渲染里的那一小段,图格照旧没有它,会再问一遍(2026-10-15 mac1 实测每阶段
   * 4–7 张)。❌ 写不进去还留着:条目回来时会被当成正在取,那几格就一直空着(复核·二代 10-16:回来以后问 0 次)。
   * 取不到当场放手,点一下再取。
   */
  const toolImageLoads = useRef(new Map<string, Promise<void>>())
  const loadToolImage = useCallback((itemId: string, index: number): Promise<void> => {
    if (!deviceId || !sessionId) return Promise.reject(new Error('no session to fetch a picture from'))
    const key = `${deviceId}\n${sessionId}\n${itemId}\n${index}`
    const known = toolImageLoads.current.get(key)
    if (known) return known
    const loading = client.fetchToolImage(deviceId, sessionId, itemId, index).then(
      (image) => {
        setTimeline((current) => {
          toolImageLoads.current.delete(key)
          return withToolImage(current, itemId, index, image)
        })
      },
      (err: unknown) => {
        toolImageLoads.current.delete(key)
        throw err
      },
    )
    toolImageLoads.current.set(key, loading)
    return loading
  }, [client, deviceId, sessionId])

  /*
   * 回显到了的那几句在**渲染时**就让位(派生,❌ 等下面那个 effect:那样记录里那一行与乐观那一行
   * 会同屏一帧);effect 只负责把 state 收成同一份,免得已认领的留在 state 里被后来的记录再认一次。
   */
  const pendingKey = `${deviceId ?? ''}/${sessionId ?? ''}`
  const ownSends = pendingState.key === pendingKey ? pendingState.sends : NO_SENDS
  const pendingSends = useMemo(
    () => settlePendingSends(ownSends, timeline.turns, timeline.queuedPrompts),
    [ownSends, timeline.turns, timeline.queuedPrompts],
  )
  useEffect(() => {
    // 函数式、且只在 state 还是算它的那一份时才收:这一帧与 effect 之间又按了一次发送的话,
    // 直接写回会把新加的那一句一起抹掉。
    if (pendingSends === ownSends) return
    setPendingState((current) => (current.key === pendingKey && current.sends === ownSends ? { key: pendingKey, sends: pendingSends } : current))
  }, [pendingKey, pendingSends, ownSends])

  const send = useCallback(async (text: string) => {
    if (!deviceId || !sessionId) return
    const body = text.trim()
    if (!body) return
    // 按下发送就画出来(pending-sends.ts 说了为什么):那台机器上的 agent 没在跑时,这次往返要先等它起来。
    // 还没和机器对过账就不画(syncedRef 那条注释):认不准回显的乐观行宁可不要,退回等记录回来。
    const key = `${deviceId}/${sessionId}`
    const pendingId = syncedRef.current ? `pending:${newLocalId()}` : null
    // 受理/失败回来时人可能已经换到别的会话、在那边又发了一句:只动还是这条会话的那一份,❌ 把别人的清掉。
    const update = (next: (sends: readonly PendingSend[]) => readonly PendingSend[]) =>
      setPendingState((current) => (current.key === key ? { key, sends: next(current.sends) } : current))
    if (pendingId) {
      const added: PendingSend = { id: pendingId, text: body, baseline: userMessageIds(timelineRef.current.turns, timelineRef.current.queuedPrompts), accepted: false }
      setPendingState((current) => ({ key, sends: [...(current.key === key ? current.sends : NO_SENDS), added] }))
    }
    setSending(true)
    setActionError(null)
    try {
      await client.sendSessionText(deviceId, sessionId, body)
      if (pendingId) update((sends) => sends.map((p) => (p.id === pendingId ? { ...p, accepted: true } : p)))
    } catch (err) {
      // ❌ 不排队假装已发出(product spec):发不出去就说发不出去 —— 乐观那一行一起撤掉。
      // 记在 actionError 上 —— 这是**发送**失败,时间线没坏。
      if (pendingId) update((sends) => sends.filter((p) => p.id !== pendingId))
      setActionError(describe(err))
      throw err
    } finally {
      setSending(false)
    }
  }, [client, deviceId, sessionId])

  const [cancelling, setCancelling] = useState(false)
  const cancel = useCallback(async () => {
    if (!deviceId || !sessionId) return
    setCancelling(true)
    setActionError(null)
    try {
      await client.cancelSessionTurn(deviceId, sessionId)
    } catch (err) {
      // 停不下来就说停不下来,❌ 把按钮按灰当作已停:是否真停了以时间线结算为准。
      setActionError(describe(err))
    } finally {
      setCancelling(false)
    }
  }, [client, deviceId, sessionId])

  const respond = useCallback(async (input: SettlementResponse) => {
    if (!deviceId || !sessionId) throw new Error('No session is available to answer this question')
    setRespondingItemId(input.itemId)
    setActionError(null)
    try {
      const result = await client.respondToSettlement(deviceId, { ...input, conversationId: sessionId, by: responderId })
      // 抢跑成功与失败都带回**那条权威结算**:失败时它是别人先答下的那条,
      // 端上据此显示「已在某端回答」。所以这里不分支,直接并进去。
      setTimeline((current) => applyLocalSettlement(current, result.settlement))
      return result
    } catch (err) {
      setActionError(describe(err))
      throw err
    } finally {
      setRespondingItemId(null)
    }
  }, [client, responderId, deviceId, sessionId])

  const dismissActionError = useCallback(() => setActionError(null), [])
  return {
    timeline, phase, error, actionError, dismissActionError, waitingForRecord,
    reload, loadOlder, loadToolImage, send, pendingSends, respond, sending, respondingItemId, cancel, cancelling,
    link, errorCode,
  }
}
