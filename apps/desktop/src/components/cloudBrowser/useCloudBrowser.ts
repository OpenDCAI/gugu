import { useMobileShell } from '@/hooks/useMobileShell'
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
/** 手机上的小图多久刷一张。 */
const SNAPSHOT_POLL_MS = 2_000
/** agent 这么久没碰浏览器、也没人接管 / 没在等人 = 小窗收起(人再关心就去问它)。 */
const QUIET_HIDE_MS = 30 * 60_000

export type CloudBrowserFrame = {
  tabId: string
  seq: number | null
  data: string
  width: number
  height: number
  viewportWidth: number
  viewportHeight: number
}

export type CloudBrowserSize = 'small' | 'medium' | 'large'

export type CloudBrowserNeed = { framesEnabled: boolean; large: boolean; tabId: string | null }

export type CloudBrowserView = {
  assistance: CloudBrowserAssistance | null
  error: string | null
  /** 能实时看、能接管(Electron 桌面);否则只看小图。 */
  live: boolean
  status: CloudBrowserStatus | null
  state: CloudBrowserState | null
  linkState: CloudBrowserLinkState | null
  frame: CloudBrowserFrame | null
  /** 小窗该不该出现。 */
  shown: boolean
  send: (message: CloudBrowserClientMessage) => boolean
  ack: (seq: number) => void
  reconnect: () => void
  dismiss: () => void
  onServerMessage: (listener: (message: CloudBrowserServerMessage) => void) => () => void
}

function isUnsupported(error: unknown): boolean {
  // 老版本的 server 没有 cloudBrowser.* 这个动词:宿主答「没有这条通道」。之后不再问它。
  return error instanceof CloudBrowserCallError && /not.?found|unknown|no handler|invalid_channel|unsupported/i.test(`${error.code} ${error.message}`)
}

/**
 * 一位 agent 所在那台云电脑上的浏览器:问状态、决定出不出小窗、连实时画面(桌面)或刷小图(手机)。
 * `deviceId` = agent 所在的那台 server;null = 不是 server 上的 agent,什么都不做。
 */
export function useCloudBrowser(deviceId: string | null, need: CloudBrowserNeed, sessionId: string | null): CloudBrowserView {
  const timeline = useTimelineSession(assistantTimelineClient(false), useMobileShell() ? 'mobile' : 'desktop', deviceId, sessionId, !!deviceId && !!sessionId)
  const pending = timeline.timeline.settlements.find(item => item.state === 'pending' && item.origin?.source === 'browser-assistance')
  const assistance = pending ? { ...(pending.origin?.payload as Omit<CloudBrowserAssistance, 'requestId'>), requestId: pending.itemId } : null
  const live = canOpenLiveBrowser()
  const [status, setStatus] = useState<CloudBrowserStatus | null>(null)
  const [state, setState] = useState<CloudBrowserState | null>(null)
  const [linkState, setLinkState] = useState<CloudBrowserLinkState | null>(null)
  const [frame, setFrame] = useState<CloudBrowserFrame | null>(null)
  const [dismissedAt, setDismissedAt] = useState<string | null>(null)
  const [unsupported, setUnsupported] = useState(false)
  const linkRef = useRef<CloudBrowserLink | null>(null)
  const listeners = useRef(new Set<(message: CloudBrowserServerMessage) => void>())
  const statusRef = useRef<CloudBrowserStatus | null>(null)
  statusRef.current = status
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

  const shown = useMemo(() => {
    if (!deviceId || unsupported || !status?.available) return false
    if (!status.running && !state?.running) return false
    if ((state?.tabs ?? status.tabs).length === 0) return false
    // 停着的任务也算:「允许 Agent 继续」只在这张卡上,收起来就没人能放行了。
    const stopped = (state?.automation ?? status.automation) === 'stopped'
    const pressing = stopped || status.controlled || !!assistance || state?.control === 'granted' || state?.control === 'pending'
    const lastActivity = status.lastActivityAt ? Date.parse(status.lastActivityAt) : 0
    if (!pressing && (!lastActivity || Date.now() - lastActivity > QUIET_HIDE_MS)) return false
    // 人关掉了小窗:agent 之后再动浏览器 / 又来求助才重新出现。
    if (dismissedAt && !pressing && status.lastActivityAt && status.lastActivityAt <= dismissedAt) return false
    return true
  }, [deviceId, unsupported, status, state, dismissedAt, assistance])

  // ── 实时连接(桌面)──
  const wantLink = live && shown && !!deviceId && need.framesEnabled
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
      // 关小窗 / 离开聊天时还拿着控制权 = 交还(大窗关掉、页面隐藏时也自动交还)。
      link.send({ type: 'control_release' })
      link.dispose()
      if (linkRef.current === link) linkRef.current = null
      setLinkState(null)
      setState(null)
    }
  }, [wantLink, deviceId])

  // 要多大、多快的画面:小窗 2 fps 640×360,放大 10 fps 1280×800。
  useEffect(() => {
    linkRef.current?.send({
      type: 'config',
      framesEnabled: need.framesEnabled,
      maxFps: need.large ? 10 : 2,
      maxWidth: need.large ? 1280 : 640,
      maxHeight: need.large ? 800 : 400,
      tabId: need.tabId,
    })
  }, [need.framesEnabled, need.large, need.tabId, linkState])

  // ── 小图(手机、网页版)──
  useEffect(() => {
    if (live || !shown || !deviceId || !need.framesEnabled) return
    let cancelled = false
    let timer: ReturnType<typeof setTimeout> | null = null
    const tick = async () => {
      try {
        const shot = await fetchCloudBrowserSnapshot(deviceId, need.tabId, need.large ? 960 : 480)
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
  }, [live, shown, deviceId, need.framesEnabled, need.large, need.tabId])

  const send = useCallback((message: CloudBrowserClientMessage) => linkRef.current?.send(message) ?? false, [])
  const ack = useCallback((seq: number) => {
    linkRef.current?.send({ type: 'ack', seq })
  }, [])
  const reconnect = useCallback(() => linkRef.current?.reconnect(), [])
  const dismiss = useCallback(() => setDismissedAt(statusRef.current?.lastActivityAt ?? new Date().toISOString()), [])
  const onServerMessage = useCallback((listener: (message: CloudBrowserServerMessage) => void) => {
    listeners.current.add(listener)
    return () => {
      listeners.current.delete(listener)
    }
  }, [])

  return { live, status, state, linkState, frame, shown, send, ack, reconnect, dismiss, onServerMessage, assistance, error: timeline.error ?? timeline.actionError }
}
