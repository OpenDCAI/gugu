import { useTimelineSession } from '@/mobile/agent-watch/use-timeline-session'
import { assistantTimelineClient } from '../assistant/assistantTimelineClient'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  canOpenLiveBrowser,
  CloudBrowserCallError,
  CloudBrowserLink,
  fetchCloudBrowserSnapshot,
  fetchCloudBrowserStatus,
  type CloudBrowserLinkState,
} from '@/lib/cloudBrowser'
import { rendererLogger } from '@/lib/log'
import { cloudHostSuspended } from '@/lib/cloudHostSuspended'
import type {
  CloudBrowserClientMessage,
  CloudBrowserAssistance,
  CloudBrowserServerMessage,
  CloudBrowserState,
  CloudBrowserStatus,
} from '@/session/shared/cloud-browser'

const log = rendererLogger('cloud-browser')

/** 聊天开着时多久问一次云电脑「浏览器怎样了」。连着实时画面时状态由 websocket 推,问得更疏。 */
const STATUS_POLL_MS = 4_000
const STATUS_POLL_LIVE_MS = 20_000
/** 没有实时连接(网页版)时小图多久刷一张。 */
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

export type CloudBrowserNeed = { framesEnabled: boolean; tabId: string | null }

export type CloudBrowserView = {
  assistance: CloudBrowserAssistance | null
  error: string | null
  /** 能实时看、能接管(Electron 桌面);否则只看小图。 */
  live: boolean
  status: CloudBrowserStatus | null
  state: CloudBrowserState | null
  linkState: CloudBrowserLinkState | null
  frame: CloudBrowserFrame | null
  /** 浏览器开着、有页签(否则页签里是空状态)。 */
  open: boolean
  send: (message: CloudBrowserClientMessage) => boolean
  ack: (seq: number) => void
  reconnect: () => void
  onServerMessage: (listener: (message: CloudBrowserServerMessage) => void) => () => void
}

function isUnsupported(error: unknown): boolean {
  // 老版本的 server 没有 cloudBrowser.* 这个动词:宿主答「没有这条通道」。之后不再问它。
  return error instanceof CloudBrowserCallError && /not.?found|unknown|no handler|invalid_channel|unsupported/i.test(`${error.code} ${error.message}`)
}

/**
 * 一位 agent 所在那台云电脑上的浏览器:问状态、连实时画面(桌面)或刷小图(没有实时连接时)。
 * `deviceId` = agent 所在的那台 server;null = 不是 server 上的 agent,什么都不做。
 */
export function useCloudBrowser(deviceId: string | null, need: CloudBrowserNeed, sessionId: string | null): CloudBrowserView {
  const timeline = useTimelineSession(assistantTimelineClient(false), 'desktop', deviceId, sessionId, !!deviceId && !!sessionId)
  const pending = Object.values(timeline.timeline.settlements).find(item => item.state === 'pending' && item.origin?.source === 'browser-assistance')
  const assistance = useMemo(() => pending ? { ...(pending.origin?.payload as Omit<CloudBrowserAssistance, 'requestId'>), requestId: pending.itemId } : null, [pending])
  const live = canOpenLiveBrowser()
  const [status, setStatus] = useState<CloudBrowserStatus | null>(null)
  const [state, setState] = useState<CloudBrowserState | null>(null)
  const [linkState, setLinkState] = useState<CloudBrowserLinkState | null>(null)
  const [frame, setFrame] = useState<CloudBrowserFrame | null>(null)
  const [unsupported, setUnsupported] = useState(false)
  const linkRef = useRef<CloudBrowserLink | null>(null)
  const listeners = useRef(new Set<(message: CloudBrowserServerMessage) => void>())
  const linkStateRef = useRef<CloudBrowserLinkState | null>(null)
  linkStateRef.current = linkState

  // ── 状态轮询 ──
  useEffect(() => {
    setStatus(null)
    setState(null)
    setFrame(null)
    setUnsupported(false)
    if (!deviceId) return
    let cancelled = false
    let timer: ReturnType<typeof setTimeout> | null = null
    const tick = async () => {
      // Local state only: a background browser preview must not attach to a sleeping host.
      if (cloudHostSuspended(deviceId)) {
        if (!cancelled) timer = setTimeout(() => void tick(), STATUS_POLL_MS)
        return
      }
      try {
        const next = await fetchCloudBrowserStatus(deviceId)
        if (cancelled) return
        setStatus(next)
      } catch (error) {
        if (cancelled) return
        if (isUnsupported(error)) {
          setUnsupported(true)
          return
        }
        log.debug({ deviceId, error: String(error) }, 'cloud browser status failed')
      }
      // 连着实时画面时状态由 websocket 推,问得更疏;节奏读当下的连接态,❌ 每次连接态变化重起轮询。
      if (!cancelled) timer = setTimeout(() => void tick(), linkStateRef.current === 'open' ? STATUS_POLL_LIVE_MS : STATUS_POLL_MS)
    }
    void tick()
    return () => {
      cancelled = true
      if (timer) clearTimeout(timer)
    }
  }, [deviceId])

  const open = !!deviceId && !unsupported && !!status?.available && (status.running || !!state?.running) && (state?.tabs ?? status.tabs).length > 0

  // ── 实时连接(桌面)──
  const wantLink = live && open && !!deviceId && need.framesEnabled
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
      // 离开页签 / 关掉任务页时还拿着控制权 = 交还(页面隐藏时也自动交还)。
      link.send({ type: 'control_release' })
      link.dispose()
      if (linkRef.current === link) linkRef.current = null
      setLinkState(null)
      setState(null)
    }
  }, [wantLink, deviceId])

  // 页签里是整块画面:10 fps 1280×800。
  useEffect(() => {
    linkRef.current?.send({
      type: 'config',
      framesEnabled: need.framesEnabled,
      maxFps: 10,
      maxWidth: 1280,
      maxHeight: 800,
      tabId: need.tabId,
    })
  }, [need.framesEnabled, need.tabId, linkState])

  // ── 小图(没有实时连接时)──
  useEffect(() => {
    if (live || !open || !deviceId || !need.framesEnabled) return
    let cancelled = false
    let timer: ReturnType<typeof setTimeout> | null = null
    const tick = async () => {
      try {
        const shot = await fetchCloudBrowserSnapshot(deviceId, need.tabId, 960)
        if (!cancelled && shot) setFrame({ ...shot, seq: null })
      } catch (error) {
        log.debug({ deviceId, error: String(error) }, 'cloud browser snapshot failed')
      }
      if (!cancelled) timer = setTimeout(() => void tick(), SNAPSHOT_POLL_MS)
    }
    void tick()
    return () => {
      cancelled = true
      if (timer) clearTimeout(timer)
    }
  }, [live, open, deviceId, need.framesEnabled, need.tabId])

  const send = useCallback((message: CloudBrowserClientMessage) => linkRef.current?.send(message) ?? false, [])
  const ack = useCallback((seq: number) => {
    linkRef.current?.send({ type: 'ack', seq })
  }, [])
  const reconnect = useCallback(() => linkRef.current?.reconnect(), [])
  const onServerMessage = useCallback((listener: (message: CloudBrowserServerMessage) => void) => {
    listeners.current.add(listener)
    return () => {
      listeners.current.delete(listener)
    }
  }, [])

  return { live, status, state, linkState, frame, open, send, ack, reconnect, onServerMessage, assistance, error: timeline.error ?? timeline.actionError }
}
