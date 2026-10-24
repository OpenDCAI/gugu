import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { Device } from '@gugu/core/shared/types/chat'
import { isPhoneDevice } from '@gugu/core/cloud/devices'
import { useToast } from '@/components/toastContext'
import { useAuth } from '@/store/auth'
import { rendererLogger } from '@/lib/log'
import type { SessionpageSessionSummary } from '@gugu/session-core/session-record/contract'
import type { AppShowSessionDetail } from '@/session/shared/extensions/app-runtime-protocol'
import { useDevicesStore } from '@/store/devicesContext'
import { useBackLayer } from '@/components/ui/sheetStack'
import { navigateMobile } from '../navigateMobile'
import { requestAlertPermissionOnce, useAgentWatchAlerts, useAgentWatchFocus } from './useAgentWatchAlerts'
import { agentOfSession, rowOpens, useAgentNames, useLiveDeviceSessions } from '@/session/shared/remote-sessions/session-directory'
import { MachinesPage } from './MachinesPage'
import { ProjectsPage } from './ProjectsPage'
import { SessionTimelinePage } from './SessionTimelinePage'
import { CreateSessionPage } from './CreateSessionPage'
import './agent-watch.css'
import './phone-conversation.css'
import { usePhoneAgentDirectory } from '../local-agent/usePhoneAgentDirectory'
import { PhoneAgentGrants } from '../local-agent/PhoneAgentGrants'
import { PhoneAgentActions } from '../local-agent/PhoneAgentActions'
import '@/i18n/registerMobileWorkspaceCatalog'

const log = rendererLogger('mobile/agent-watch')

/**
 * 手机「项目」tab:项目页(根)→ 时间线,一条两层的栈;新建会话是从根页 + 推进去的两步。
 *
 * 它自己管标题与返回,所以在「我的」里是**顶掉** detail 那层壳来渲染的,
 * 不是套在 SettingsPanel 的 PaneHeader 之下 —— 套着会出现两个返回箭头,
 * 而其中一个会把人一路弹回「我的」,和这张页里的层级不是一回事。
 */
export type AgentWatchRoute =
  /**
   * 根:账号名下所有机器上的项目与会话,一页(机器是项目分区的属性,#7199)。
   * `reveal` = 点名定位:一条打不开的行被 App 点名(gugu.showSession),落在它所在的分区、滚到它。
   */
  | { name: 'projects'; reveal?: { deviceId: string; sessionId: string } | { projectId: string } }
  /** `deviceId` = 会话所在的机器(跨机器的子会话在它自己那台上打开)。 */
  | { name: 'timeline'; deviceId: string; session: SessionpageSessionSummary; firstPrompt?: string; appKind?: string }
  /**
   * 新建会话的两步(owner 2026-09-06:「新建任务应该是先选择设备再新建任务」):
   * 根页的 + → `pick-machine`(「在哪台机器上」,离线的点不动)→ `create`。
   */
  | { name: 'pick-machine' }
  | { name: 'create'; deviceId: string }

/** 看管订阅与「后台守着」常驻通知:挂在移动壳根上,切 tab 不拆。 */
export function AgentWatchRoot() {
  const { devices, phones = [] } = useDevicesStore()
  const all = [...devices, ...phones]
  useAgentWatchAlerts(all)
  usePhoneAgentDirectory(all)
  return <><PhoneAgentGrants /><PhoneAgentActions /></>
}

export function AgentWatchPage({
  active,
  onExit,
  onRouteChange,
  createRequest,
  createInGroup = null,
  openRequest,
  onOpenAgentChat,
  onOpenGroupChat,
}: {
  /** 「项目」tab 是不是当前 tab。手机壳里这张页常驻在横滑分页器里,切走时也挂着。 */
  active: boolean
  onExit: () => void
  /** 报出当前在哪一层,好让外壳决定要不要收起底部 tab 栏(时间线页与新建页要把整屏让给输入框)。 */
  onRouteChange?: (name: AgentWatchRoute['name']) => void
  /** 每变一次 = 外面要建 agent(联系人页的「新建 Agent」):直接进「在哪台机器上」,与根页的 + 同一步。 */
  createRequest?: number
  /** 随 createRequest 一起来:群成员里点的「新建 Agent」带的群(建出来就进群、建完回到群)。null = 不进群。 */
  createInGroup?: { chatId: string; name: string } | null
  /** 每来一个新的 = 一个 App 点名了这条会话(`gugu.showSession`,useAppShowSession):进它的时间线,与在列表里点那一行同一步。 */
  openRequest?: AppShowSessionDetail | null
  /** 去这个 agent 的私聊:会话页模式按钮的「聊天」(#7197),与通讯录「发消息」同一条。 */
  onOpenAgentChat?: (agentUserId: string) => void
  /** 从群里建的 agent 建好了:回到那个群。 */
  onOpenGroupChat?: (chatId: string) => void
}) {
  const { t: tWorkspace } = useTranslation('mobileWorkspace')
  const ownerId = useAuth().user?.id ?? null
  const { devices: hosts, phones } = useDevicesStore()
  const devices = useMemo(() => [...new Map([...hosts, ...(phones ?? [])].map((one) => [one.device_id, one])).values()], [hosts, phones])
  const { toast } = useToast()
  const [route, setRouteState] = useState<AgentWatchRoute>({ name: 'projects' })
  // ❌ 不在渲染里回调:那是渲染期副作用。所有跳转都走这一个口子。
  const setRoute = useCallback((next: AgentWatchRoute) => {
    const depth = (page: AgentWatchRoute) => page.name === 'projects' ? 0 : page.name === 'create' ? 2 : 1
    const update = () => { setRouteState(next); onRouteChange?.(next.name) }
    if (active) navigateMobile(update, depth(next) < depth(route) ? 'pop' : 'push')
    else update()
  }, [active, route, onRouteChange])
  // 项目页的滚动位置:进时间线再回来页面是重新挂的,滚回离开时的地方。
  const projectsScroll = useRef(0)

  // 订阅在 AgentWatchRoot;这里只读会话目录,并报正盯着的那条(它不弹横幅:页头状态词已经在说这件事)。
  const live = useLiveDeviceSessions()
  const agentNames = useAgentNames()

  // 路由只存 deviceId,机器行每次从 store 现查:在线状态会实时翻转,
  // 存下 Device 快照就会停在进页那一帧(离线机器上线了,页面还说它离线)。
  const device: Device | undefined =
    'deviceId' in route ? devices.find((d) => d.device_id === route.deviceId) : undefined
  useAgentWatchFocus(active && device && route.name === 'timeline' ? { deviceId: route.deviceId, sessionId: route.session.conversationId } : null)
  // The fallback root must also restore the shell's bottom navigation and back stack.
  useEffect(() => {
    if ('deviceId' in route && !device) setRoute({ name: 'projects' })
  }, [route, device, setRoute])

  // 「项目」tab 是手机壳返回栈里的一层(ui/sheetStack.ts):先在这张页的层级里往回退,退到根才离开这个 tab。
  useBackLayer(() => {
    if (route.name === 'timeline' || route.name === 'pick-machine') setRoute({ name: 'projects' })
    else if (route.name === 'create') setRoute({ name: 'pick-machine' })
    else onExit()
  }, active)

  // 切走「项目」tab ⇒ 回到根页:相邻 tab 横滑过来看到的是这个 tab 的根(#6730),
  // 会话列表同步、时间线订阅与「正盯着」也不在屏外接着跑。
  useEffect(() => {
    if (!active && route.name !== 'projects') setRoute({ name: 'projects' })
  }, [active, route.name, setRoute])

  // 只认「变了」:重挂时带着旧计数不能自己跳进去。
  const seenCreateRequest = useRef(createRequest)
  // 这一次新建生在哪个群里:只跟着外面那次请求来,退回机器页就清掉(机器页的 + 是不进群的新建)。
  const [birthGroup, setBirthGroup] = useState<{ chatId: string; name: string } | null>(null)
  useEffect(() => {
    if (createRequest === seenCreateRequest.current) return
    seenCreateRequest.current = createRequest
    setBirthGroup(createInGroup)
    setRoute({ name: 'pick-machine' })
    // eslint-disable-next-line react-hooks/exhaustive-deps -- 群只在请求变的那一刻读
  }, [createRequest, setRoute])
  useEffect(() => {
    if (route.name === 'projects') setBirthGroup(null)
  }, [route.name])

  const seenOpenRequest = useRef(openRequest)
  useEffect(() => {
    if (!openRequest || openRequest === seenOpenRequest.current) return
    seenOpenRequest.current = openRequest
    // A row that does not open (an offline machine's, from its heartbeat): the person lands where it is listed, as a tap leaves them.
    if ('projectId' in openRequest) { setRoute({ name: 'projects', reveal: openRequest }); return }
    const { deviceId, session, tabKind } = openRequest
    setRoute(rowOpens(session)
      ? { name: 'timeline', deviceId, session, ...(tabKind ? { appKind: tabKind } : {}) }
      : { name: 'projects', reveal: { deviceId, sessionId: session.conversationId } })
  }, [openRequest, setRoute])

  // 机器在名下消失了(被删 / 换账号)⇒ 退回列表。派生而不是在渲染里 setState:
  // 后者会先画出一帧指向不存在机器的页。
  if (route.name === 'timeline' && device) {
    // 路由里那份是点进来那一刻的快照;页头状态要跟着机器推来的那份走(与列表、提醒同一份读数)。
    const here = live[device.device_id]
    const liveSession = here?.cached ? undefined : here?.sessions.find((s) => s.conversationId === route.session.conversationId)
    return (
      <SessionTimelinePage
        key={`${device.device_id}:${route.session.conversationId}:${route.appKind ?? ''}`}
        device={device}
        initialAppKind={route.appKind}
        session={liveSession ?? route.session}
        agent={agentOfSession(liveSession ?? route.session, agentNames)}
        firstPrompt={route.firstPrompt}
        onBack={() => setRoute({ name: 'projects' })}
        onOpenChat={onOpenAgentChat}
      />
    )
  }

  if (route.name === 'create' && device) {
    return (
      <CreateSessionPage
        key={`${ownerId}:${device.device_id}`}
        device={device}
        birthGroup={birthGroup}
        onClearBirthGroup={() => setBirthGroup(null)}
        onBack={() => setRoute({ name: 'pick-machine' })}
        // 从群里新建的会话回到那个群;其余打开新会话,返回时回到项目页。
        onCreated={(session, firstPrompt, result) => {
          const phone = isPhoneDevice(device)
          if (phone && result?.birthGroup?.status === 'failed') {
            log.warn({ deviceId: device.device_id, sessionId: session.conversationId, chatId: result.birthGroup.chatId, reason: result.birthGroup.error ?? null }, 'phone agent created but group join failed')
            toast(tWorkspace('groupJoinFailed'), 'error')
          }
          const groupId = phone ? result?.birthGroup?.chatId : birthGroup?.chatId
          if (groupId && onOpenGroupChat && (!phone || result?.birthGroup?.status === 'joined' || result?.birthGroup?.status === 'pending_approval')) {
            if (phone && result?.birthGroup?.status === 'pending_approval') toast(tWorkspace('groupJoinPending'), 'success')
            setRoute({ name: 'projects' })
            onOpenGroupChat(groupId)
            return
          }
          setRoute({ name: 'timeline', deviceId: device.device_id, session, firstPrompt })
        }}
      />
    )
  }

  if (route.name === 'pick-machine') {
    return (
      <MachinesPage
        onBack={() => setRoute({ name: 'projects' })}
        onOpenDevice={(picked) => setRoute({ name: 'create', deviceId: picked.device_id })}
      />
    )
  }

  return (
    <ProjectsPage
      scrollMemo={projectsScroll}
      reveal={route.name === 'projects' ? route.reveal : undefined}
      onCreate={() => { setBirthGroup(null); setRoute({ name: 'pick-machine' }) }}
      onOpenSession={(deviceId, session) => {
        // 权限在**用户动作之后**要:点开一条会话 = 他确实要看管它。一进 App 就弹权限框
        // 多数人会直接拒掉,然后这个功能永远用不了。
        requestAlertPermissionOnce()
        setRoute({ name: 'timeline', deviceId, session })
      }}
    />
  )
}
