import { useEffect, useRef } from 'react'
import { useTranslation } from 'react-i18next'
import type { Device } from '@gugu/core/shared/types/chat'
import { platform } from '@/platform'
import { useAuth } from '@/store/auth'
import { claimBackgroundWatch } from '../backgroundWatchClaims'
import { agentStatusText } from '@/lib/agentStatusText'
import {
  diffAlerts,
  statusMapOf,
  type AgentWatchAlert,
  type AgentWatchStatusMap,
} from './agent-watch-alerts'
import * as sessionpageRpc from './sessionpage-rpc'
import { startSessionListSync } from '@/session/shared/remote-sessions/session-list-sync'
import { registerDeviceSessionsRetry, retainDeviceSessions, updateDeviceSessions } from '@/session/shared/remote-sessions/session-directory'
import { workspaceDevices } from './machine-list'

/**
 * 「agent 做完了 / 在等你」的提醒 —— 挂在看管入口的**根**上，不是挂在某一条会话的时间线页上。
 *
 * 原来的实现只在你**已经盯着那条会话**时才弹，恰好是最不需要提醒的场景：在机器列表、
 * 在会话列表、或者刚切走，全都不响。spec product spec 一期边界那条要的是
 * 「App 在前台或刚切走时提醒」。
 *
 * 两种到达方式，按屏幕在不在人眼前分：
 *   · 页面可见 → 应用内提示条。
 *   · 刚切走（页面还活着但不可见）→ 浏览器本地通知。
 * ❌ 不接系统级推送（spec 一期明写不做）：这条通知由这张页自己发，App 被杀掉就没有了。
 *
 * 权限只在**用户动作之后**要一次（点开一条会话 = 他确实要看管它），且只要一次：
 * 一进 App 就弹权限框是最招人烦的那种，多数人会直接拒掉，然后这个功能永远用不了。
 * ⚠️ 要权限是**另一件事**，由 AgentWatchPage 在「点开一条会话」时单独触发
 * （requestAlertPermissionOnce）。❌ 别拿它去关订阅 —— 这里原来收一个 armed 参数，
 * 调用方传的是 `route.name !== 'machines'`，于是停在机器列表那一屏时整套订阅压根没建，
 * agent 干完了一声不响。owner 2026-09-15 实测撞上：桌面跑完一轮，手机停在「机器与会话」，
 * 通知栏空的。订阅的寿命 = App 登录着的寿命(挂在移动壳根上的 AgentWatchRoot),与你停在哪个 tab、哪一层无关。
 */
/** 人此刻正盯着的那条会话:它的「做完了 / 在等你」页头已经写着,再弹提示条就是同一件事报两遍。 */

export type AgentWatchFocus = { deviceId: string; sessionId: string } | null

let watchFocus: AgentWatchFocus = null

export function useAgentWatchFocus(focus: AgentWatchFocus): void {
  const deviceId = focus?.deviceId
  const sessionId = focus?.sessionId
  useEffect(() => {
    watchFocus = deviceId && sessionId ? { deviceId, sessionId } : null
    return () => { watchFocus = null }
  }, [deviceId, sessionId])
}

export function useAgentWatchAlerts(devices: readonly Device[]): void {
  const { t } = useTranslation('main')
  const ownerId = useAuth().user?.id ?? null
  const statusRef = useRef<Record<string, AgentWatchStatusMap>>({})
  const tRef = useRef(t)
  tRef.current = t
  /**
   * App 此刻在不在前台 —— 只用来压掉「人正盯着的那条会话」的重复提醒。
   * ⚠️ ❌ 不要退回 `document.visibilityState` 了事:「后台守着」开着时前台服务会让页面在后台
   * 仍自称 visible,于是切到后台反而被当成「在眼前」而漏报 —— 那正是这个功能要解决的场景。
   * 宿主答不上来(浏览器、桌面)才退回 visibilityState:那些宿主没有前台服务,不会被骗。
   */
  const appActiveRef = useRef(true)
  useEffect(() => {
    if (platform.subscribeAppActive) {
      return platform.subscribeAppActive((active) => { appActiveRef.current = active })
    }
    const sync = (): void => { appActiveRef.current = document.visibilityState === 'visible' }
    sync()
    document.addEventListener('visibilitychange', sync)
    return () => document.removeEventListener('visibilitychange', sync)
  }, [])
  // 只订有 workspace 的在线机器；手机摘要由独立同步器写入同一目录，不开这条 pipe。
  const onlineIds = workspaceDevices(devices).filter((device) => device.is_online).map((device) => device.device_id)
  // 设备列表按 last_seen_at 倒序:两台在线机器轮流心跳,顺序十几秒就换一次。key ❌ 带顺序,
  // 否则每换一次整套订阅拆掉重来 —— 旧写法里那正是一次次重赌「第一次列表别超时」(#6738)。
  const key = [...onlineIds].sort().join(',')
  const retryScope = useRef({ ownerId, onlineIds })
  retryScope.current = { ownerId, onlineIds }
  const retainedKey = devices.filter((device) => device.is_online || device.capabilities.host_kind === 'phone').map((device) => device.device_id).sort().join(',')

  useEffect(() => {
    statusRef.current = {}
    return () => retainDeviceSessions([])
  }, [ownerId])

  useEffect(() => {
    retainDeviceSessions(retainedKey ? retainedKey.split(',') : [])
  }, [retainedKey])

  useEffect(() => {
    if (onlineIds.length === 0) return
    const stops: Array<() => void> = []

    /*
     * 「后台守着」——(product spec)。没有它,这一整套订阅在 App 切到后台之后就是聋的:
     * 实测(安卓 16)按 HOME 五秒后,页面里每一次请求都在 5～24 毫秒内被系统当场拒掉(不是超时),
     * 再过约 55 秒连定时器也停;agent 干完那一刻的推送根本到不了手机。
     * 代价是一条常驻通知 —— 安卓拿它换一条不被掐的连接,没有第二条路。
     * 谁开谁关:它跟着这套订阅的寿命走,没有在线机器或退出登录就关掉,❌ 不留一条没人要的常驻通知在通知栏。
     */
    // 与 #7199 手机当设备共用这一条常驻通知:各自登记,最后一个放手才关(backgroundWatchClaims)。起不来的错在那里照实记。
    if (platform.capabilities.backgroundWatch) {
      stops.push(claimBackgroundWatch('agentWatch', tRef.current('agentWatch.backgroundWatch', { count: onlineIds.length })))
    }

    const deliver = (deviceId: string, alerts: readonly AgentWatchAlert[]): void => {
      for (const alert of alerts) {
        const text = tRef.current('agentWatch.notify.status', { name: alert.title, status: agentStatusText(alert.label) })
        // 正看着这条会话:页头状态词已经在说这件事,再报一遍就是同一件事说两遍(#3566 审计)。
        const current = watchFocus
        if (appActiveRef.current
          && current && current.deviceId === deviceId && current.sessionId === alert.sessionId) continue
        void announce(text)
      }
    }

    /**
     * 每台在线机器一条会话列表同步 —— 与会话列表页**同一份** `startSessionListSync`:列一次 → 订阅推送 → 保活;
     * 列不出来退避重试、机器不认这条订阅就整个重来、漏收推送当场重列、频道重订上重列。
     * ⚠️ 这里原先手写了一份「列 → 订 → 保活」,唯独少了重试:第一次列表恰好超时(机器一时没应答),catch 吞掉,
     * 这台机器此后既没有订阅也没有 live 行,时间线页头一直停在进页那一帧的快照上 —— 整轮在跑,页头说「做完了」,
     * 停止键却是红的(#6738)。❌ 再手写第二份:两份拷贝漂掉的就是这种只有一份有的东西。
     *
     * 每一份列表都与上一份比:第一份没有「上一份」,`diffAlerts` 对第一次见到的会话不报,它就是基线;
     * 断线重连 / 重订之后那一份比的是断开前后两个端点,断开期间落定的终态照样补报,每条会话最多一条。
     */
    const syncs = onlineIds.map((deviceId) => {
      const sync = startSessionListSync(sessionpageRpc, deviceId, {
        onList: (result) => {
          if (retryScope.current.ownerId !== ownerId) return
          updateDeviceSessions(deviceId, { projects: result.projects, sessions: result.sessions, cached: false, connected: true })
          deliver(deviceId, diffAlerts(statusRef.current[deviceId] ?? {}, result.sessions))
          statusRef.current[deviceId] = statusMapOf(result.sessions)
        },
        onLoading: (loading) => { if (retryScope.current.ownerId === ownerId) updateDeviceSessions(deviceId, { loading }) },
        onLink: (connected) => { if (retryScope.current.ownerId === ownerId) updateDeviceSessions(deviceId, { connected }) },
        onError: (error) => { if (retryScope.current.ownerId === ownerId) updateDeviceSessions(deviceId, { error, ...(error ? { connected: false } : {}) }) },
      })
      if (ownerId) stops.push(registerDeviceSessionsRetry(ownerId, deviceId, () => {
        if (retryScope.current.ownerId !== ownerId || !retryScope.current.onlineIds.includes(deviceId)) throw new Error('账号或设备连接已改变，请重新打开项目列表。')
        sync.reconnect()
      }))
      return sync
    })
    for (const sync of syncs) stops.push(() => sync.stop())

    /*
     * 回到前台:每台机器整个重来一遍(新订阅号、重新列,补报照常)。后台里定时器会停,保活断了 90 秒,
     * 机器就把这条订阅清掉;只重列一次的话,要等下一次保活(最长 25 秒)才发现订阅没了,这期间的变化推不过来。
     * 两条来路都要听:网页宿主只有 visibilitychange;安卓上「后台守着」会让页面一直自称可见
     * (见上面 appActiveRef 的说明),那一边 visibilitychange 根本不响,只能靠 App 的 resume。
     * 同一次回到前台两条来路可能都响;reconnect 本来就先停后起,响两声也只留下后一轮。
     */
    const reconnectAll = (): void => { for (const sync of syncs) sync.reconnect() }
    const onVisible = (): void => { if (document.visibilityState === 'visible') reconnectAll() }
    document.addEventListener('visibilitychange', onVisible)
    stops.push(() => document.removeEventListener('visibilitychange', onVisible))
    stops.push(platform.subscribeAppForeground(reconnectAll, () => undefined))

    return () => {
      for (const stop of stops) stop()
    }
    // onlineIds 是每次渲染新建的数组，进依赖会让这个 effect 每帧重挂；key 是它的稳定投影。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, ownerId])
}

/**
 * 「agent 干完了 / 在等你」怎么送到人眼前 —— **只有一个通道:系统横幅**,不分 App 在不在前台。
 *
 * owner 2026-09-15:「其实你就统一一下,都用系统横幅不行吗?没必要搞什么 App 内的提示条,
 * 尤其是在手机端,我觉得完全没必要。……总之就是,你把话搞复杂了」。
 * ⇒ ❌ 不要再给提醒加第二个通道(App 内提示条、列表红点、未读角标)。这个功能有几个通道,
 * 判据就是几:超过一个就是设计复杂了。
 *
 * 安卓 App 走原生通知(WebView 没有网页 `Notification` 接口,MDN browser-compat-data:
 * webview_android 未实现);浏览器宿主走网页 Notification。两条都是同一个东西的不同实现,
 * 不是两个通道。发不出去(用户没给通知权限)就没有提醒 —— 那正是「我的 → 权限」那一页要解决的事。
 */
async function announce(text: string): Promise<void> {
  if (platform.systemPermissions.includes('notifications')) {
    void platform.showNotification({ title: text, chatId: null }).catch(() => undefined)
    return
  }
  if (typeof Notification === 'undefined' || Notification.permission !== 'granted') return
  try {
    new Notification(text)
  } catch {
    // 通知发不出去不该把看管页拖垮（部分浏览器在非安全上下文里直接抛）。
  }
}

let nativeAlertPermissionAsked = false

/** 用户已经做了动作（点进一台机器）之后要一次权限，且只要一次。 */
export function requestAlertPermissionOnce(): void {
  if (platform.systemPermissions.includes('notifications')) {
    // 「只要一次」按本次启动算：拒过一次、系统还肯再弹的，下次启动再进机器时再问；
    // 系统已经不肯弹的（blocked）就不问了，去「我的 → 权限」开（product spec）。
    if (nativeAlertPermissionAsked) return
    nativeAlertPermissionAsked = true
    void platform.checkSystemPermission('notifications')
      .then((state) => (state === 'prompt' ? platform.requestSystemPermission('notifications') : state))
      .catch(() => undefined)
    return
  }
  if (typeof Notification === 'undefined') return
  if (Notification.permission !== 'default') return
  void Notification.requestPermission().catch(() => undefined)
}
