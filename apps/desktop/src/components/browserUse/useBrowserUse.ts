import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  CloudBrowserCallError,
  CloudBrowserLink,
  fetchCloudBrowserSnapshot,
  fetchCloudBrowserStatus,
  type CloudBrowserLinkState,
} from '@/lib/browserUseLink'
import { rendererLogger } from '@/lib/log'
import { cloudHostSuspended } from '@/lib/cloudHostSuspended'
import { useSessionHostAsk } from '@/session/renderer/features/extensions/use-session-host-ask'
import { rpcOn } from '@/session/renderer/lib/ipc'
import { machineRegistry } from '@/session/renderer/lib/machine-routing'
import type {
  CloudBrowserClientMessage,
  CloudBrowserAssistance,
  CloudBrowserServerMessage,
  CloudBrowserState,
  CloudBrowserStatus,
} from '@/session/shared/cloud-browser'

const log = rendererLogger('browser-use')

/** 页签开着时多久问一次那台 server「浏览器怎样了」。连着实时画面时状态由 websocket 推,问得更疏。 */
const STATUS_POLL_MS = 4_000
const STATUS_POLL_LIVE_MS = 20_000
/** 没有直连的路时,小图多久刷一张。 */
const SNAPSHOT_POLL_MS = 2_000

export type CloudBrowserFrame = {
  tabId: string
  seq: number | null
  data: string
  width: number
  height: number
  viewportWidth: number
  viewportHeight: number
}

export type BrowserUseNeed = { framesEnabled: boolean; tabId: string | null }

export type BrowserUseView = {
  /** 这个任务此刻等着人的那一步(登录 / 接手),读自它自己的时间线;❌ 别的任务的。 */
  assistance: CloudBrowserAssistance | null
  /** 能实时看、能接管(Electron 桌面且有直连的路);否则只看小图。 */
  live: boolean
  /** 那台机器上的咕咕太旧,没有 cloudBrowser.* 这条通道。 */
  unsupported: boolean
  status: CloudBrowserStatus | null
  state: CloudBrowserState | null
  linkState: CloudBrowserLinkState | null
  frame: CloudBrowserFrame | null
  send: (message: CloudBrowserClientMessage) => boolean
  ack: (seq: number) => void
  /** 答这个任务等着的那一问(「完成」= 那一问的 allow 选项):人接管、自己在页面上做完时用。答成 = true。 */
  finishAssistance: () => Promise<boolean>
  reconnect: () => void
  onServerMessage: (listener: (message: CloudBrowserServerMessage) => void) => () => void
}

function isUnsupported(error: unknown): boolean {
  // 老版本的 server 没有 cloudBrowser.* 这个动词:宿主答「没有这条通道」。之后不再问它。
  return error instanceof CloudBrowserCallError && /not.?found|unknown|no handler|invalid_channel|unsupported/i.test(`${error.code} ${error.message}`)
}

/**
 * 一个任务所在那台咕咕 server 上的浏览器:问状态、连实时画面(有直连的路)或刷小图。
 * `deviceId` = 那台 server;null = 不问。`live` 由调用方定(这台是桌面、到那台有直连的路)。
 *
 * 等人的那一步只读这个任务的时间线(`useSessionHostAsk`,同会话页的其他宿主提问):读不到只进日志,
 * ❌ 当成浏览器的错说给人看(时间线那条线的 record_not_found 不是浏览器坏了)。
 */
export function useBrowserUse(deviceId: string | null, sessionId: string | null, live: boolean, need: BrowserUseNeed): BrowserUseView {
  const pending = useSessionHostAsk(deviceId ? sessionId : null, 'browser-assistance', { rereadMs: STATUS_POLL_MS })
  const [status, setStatus] = useState<CloudBrowserStatus | null>(null)
  // 协议 12 的 server 还把求助放在浏览器状态里(13 起是会话上的 Ask):新端照旧读得到(向下兼容一档)。
  const legacyAssistance = status?.assistance ?? null
  const assistance = useMemo(
    () => pending ? { ...(pending.origin?.payload as Omit<CloudBrowserAssistance, 'requestId'>), requestId: pending.itemId } : legacyAssistance,
    [pending, legacyAssistance],
  )
  const [state, setState] = useState<CloudBrowserState | null>(null)
  const [linkState, setLinkState] = useState<CloudBrowserLinkState | null>(null)
  const [frame, setFrame] = useState<CloudBrowserFrame | null>(null)
  const [unsupported, setUnsupported] = useState(false)
  const linkRef = useRef<CloudBrowserLink | null>(null)
  const listeners = useRef(new Set<(message: CloudBrowserServerMessage) => void>())
  const linkStateRef = useRef<CloudBrowserLinkState | null>(null)
  linkStateRef.current = linkState

  // ── 状态轮询(页签在屏上才问)──
  // 换了一台机器:上一台的一切作废。
  useEffect(() => {
    setStatus(null)
    setState(null)
    setFrame(null)
    setUnsupported(false)
  }, [deviceId])
  const polling = !!deviceId && need.framesEnabled
  useEffect(() => {
    if (!deviceId || !polling) return
    let cancelled = false
    let timer: ReturnType<typeof setTimeout> | null = null
    const tick = async () => {
      // Local state only: a browser page must not attach to a sleeping host.
      if (cloudHostSuspended(deviceId)) {
        if (!cancelled) timer = setTimeout(() => void tick(), STATUS_POLL_MS)
        return
      }
      try {
        const next = await fetchCloudBrowserStatus(deviceId)
        if (cancelled) return
        setUnsupported(false)
        setStatus(next)
      } catch (error) {
        if (cancelled) return
        if (isUnsupported(error)) {
          setUnsupported(true)
          return
        }
        log.debug({ deviceId, error: String(error) }, 'browser status failed')
      }
      // 连着实时画面时状态由 websocket 推,问得更疏;节奏读当下的连接态,❌ 每次连接态变化重起轮询。
      if (!cancelled) timer = setTimeout(() => void tick(), linkStateRef.current === 'open' ? STATUS_POLL_LIVE_MS : STATUS_POLL_MS)
    }
    void tick()
    return () => {
      cancelled = true
      if (timer) clearTimeout(timer)
    }
  }, [deviceId, polling])

  const running = !!status?.available && (status.running || !!state?.running)

  // ── 实时连接 ──
  const wantLink = live && running && !!deviceId && need.framesEnabled
  useEffect(() => {
    if (!wantLink || !deviceId) return
    const link = new CloudBrowserLink(
      deviceId,
      async () => {
        const current = await fetchCloudBrowserStatus(deviceId)
        setStatus(current)
        return current.live
      },
      {
        onState: (next) => setLinkState(next),
        onMessage: (message) => {
          if (message.type === 'state') setState(message)
          else if (message.type === 'frame') {
            setFrame({
              tabId: message.tabId,
              seq: message.seq,
              data: message.data,
              width: message.width,
              height: message.height,
              viewportWidth: message.viewportWidth,
              viewportHeight: message.viewportHeight,
            })
          }
          for (const listener of [...listeners.current]) listener(message)
        },
      },
    )
    linkRef.current = link
    link.start()
    return () => {
      // 离开页签(切走 / 关掉 / 页面隐藏)时还拿着控制权 = 交还。
      link.send({ type: 'control_release' })
      link.dispose()
      if (linkRef.current === link) linkRef.current = null
      setLinkState(null)
      setState(null)
    }
  }, [wantLink, deviceId])

  // 画面填满页签:10 fps,最大 1280×800。
  useEffect(() => {
    linkRef.current?.send({ type: 'config', framesEnabled: need.framesEnabled, maxFps: 10, maxWidth: 1280, maxHeight: 800, tabId: need.tabId })
  }, [need.framesEnabled, need.tabId, linkState])

  // ── 小图(没有直连的路)──
  useEffect(() => {
    if (live || !running || !deviceId || !need.framesEnabled) return
    let cancelled = false
    let timer: ReturnType<typeof setTimeout> | null = null
    const tick = async () => {
      try {
        const shot = await fetchCloudBrowserSnapshot(deviceId, need.tabId, 960)
        if (!cancelled && shot) setFrame({ ...shot, seq: null })
      } catch (error) {
        log.debug({ deviceId, error: String(error) }, 'browser snapshot failed')
      }
      if (!cancelled) timer = setTimeout(() => void tick(), SNAPSHOT_POLL_MS)
    }
    void tick()
    return () => {
      cancelled = true
      if (timer) clearTimeout(timer)
    }
  }, [live, running, deviceId, need.framesEnabled, need.tabId])

  const send = useCallback((message: CloudBrowserClientMessage) => linkRef.current?.send(message) ?? false, [])
  const ack = useCallback((seq: number) => {
    linkRef.current?.send({ type: 'ack', seq })
  }, [])
  const reconnect = useCallback(() => linkRef.current?.reconnect(), [])
  const finishAssistance = useCallback(async () => {
    const done = pending?.options?.find((option) => option.kind?.startsWith('allow'))
    if (!sessionId || !pending || !done) return false
    try {
      const result = await rpcOn(machineRegistry.machineOf(sessionId)).sessionTimeline.sessionRespond({
        conversationId: sessionId,
        itemId: pending.itemId,
        kind: 'permission',
        optionId: done.optionId,
        by: 'desktop',
      })
      return result.ok
    } catch (error) {
      log.warn({ sessionId, error: String(error) }, 'browser ask answer failed')
      return false
    }
  }, [pending, sessionId])
  const onServerMessage = useCallback((listener: (message: CloudBrowserServerMessage) => void) => {
    listeners.current.add(listener)
    return () => {
      listeners.current.delete(listener)
    }
  }, [])

  return { live, unsupported, status, state, linkState, frame, send, ack, finishAssistance, reconnect, onServerMessage, assistance }
}
