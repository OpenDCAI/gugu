import { setUserLibraryOwner } from '../session/main/core/app/user-library'
import { startNativeConversationInboxHost } from '../session/main/core/sessions/native-conversation-inbox'
// @@@task-shell-port (#5012) — 网页版无头宿主的会话身份接线:浏览器交登录态 → 宿主开账号并绑到会话。
//
// 桌面版里这些活由 electron/main.ts 在十几个融合钩子里做;这里只接「会话有身份」这一层:
//   · 登录态:浏览器按次推送(setAuth),宿主只存最近一份、❌ 不自行刷新(refresh token 轮换会让两边其一失效)。
//   · 会话启动:ACP 注入点与 PTY 钩子先开账号,再接「咕咕自营模型」那一层(见下)。
//   · 壳口委托:agentCard / ensureAgentAddress 作为 rpc `sessionpageIdentity.*` 暴露给浏览器壳。
//   · 身份到位事件:按 sessionpage-identity-contract 的事件定义广播给浏览器(与桌面版同一个定义)。
//   · 自营模型(#5057):composer 下拉的目录通道 + 五个平台钩子 + agent 侧 session_list_models 的
//     目录解析器(同一份实现的两个调用方,❌ 不许只接一口)。实现在 sessionpage-platform-hooks.ts,
//     与桌面主进程共用同一份 —— ❌ 别在这里另写一份。缺了这一层的现象是**静默的**:renderer 那侧
//     catch 掉、分组直接缺席,不弹错,于是「网页版没有自营模型」查不出原因(owner 09-05 实撞)。
// ⚠️ 住在宿主树:它 import 身份供给(有模块级状态:互斥锁 + 监听表),而会话页树不许 import 宿主模块。
//    所以入口 session-host-entry.ts 也在宿主树,方向统一为「宿主 import 引擎」。
// ⚠️ 必须在 Module._load 钩子装好之后**动态** import 本模块:它经 electron/supabase.ts 静态 require('electron')。
import { createRPCController, registerRPCRouter } from '../../src/session/shared/lib/ipc/rpc'
import type { EventDefinition } from '../../src/session/shared/lib/ipc/events'
import {
  sessionpageAgentProvisionedEvent,
  type SessionpageIdentityAuth,
  type SessionpageIdentityRpc,
} from '../../src/session/shared/lib/ipc/sessionpage-identity-contract'
import { onSessionpageAgentProvisioned } from './emdash-agent-provisioning'
import { createSessionpageIdentityHost, type SessionpageIdentityAuthSnapshot } from './sessionpage-identity-host'
import { createLocalDeviceIdResolver, detectDeviceCapabilities, type DeviceCapabilities, type DeviceHeartbeatTableClient } from '@gugu/core/cloud/deviceRuntime'
import { makeIdentityClient } from '../supabase'
import { setEmdashIdentityProvisioner, setEmdashMcpInjector } from '../session/main/core/acp/emdash-mcp-injector'
import { setSessionIdentityHost } from '../session/main/core/sessions/session-identity-host'
import { setPlatformModelCatalogResolver } from '../session/main/core/agents/platform-model-catalog-hook'
import {
  notifyProjectGroupBindingChanged,
  setProjectGroupHost,
} from '../session/main/core/projects/project-group-host'
import { createSessionpageProjectGroupHost } from './sessionpage-project-group-binding'
import { onProjectGroupMappingChanged } from './sessionpage-project-groups'
import {
  setEmdashPlatformCheckpoint,
  setEmdashPlatformInjector,
  setEmdashPlatformRelease,
} from '../session/main/core/acp/emdash-platform-injector'
import {
  setEmdashPtySessionpageHook,
  setEmdashPtySessionpageTeardown,
} from '../session/main/core/sessions/impl/emdash-pty-sessionpage-hook'
import {
  applyPlatformToPtyLaunch,
  createSessionpagePlatformHooks,
} from './sessionpage-platform-hooks'
import { SESSIONPAGE_PLATFORM_CATALOG_CHANNEL } from './sessionpage-platform-catalog'
import { SESSIONPAGE_PLATFORM_RETRY_CHANNEL } from '../../src/session/shared/core/agents/platform-model'
import { clearPlatformIssueBackoff } from './sessionpage-platform-model'
import { adoptLegacyTaskNames, announceEmdashSession, emdashSessionProvisionInput, emdashProjectName, emdashSessionpageSessionFacts, emdashTakeBirthGroup, setTaskNamer, setTaskNameOwner } from '../session/main/embedded-boot'
import { sessionpageRenameAnnouncement, type SessionpageAgentNameTaken } from './sessionpage-rename-announcement'
import type { HostIpc } from '../session/main/lib/host-ipc'
import { log } from '../session/main/lib/logger'

/** 浏览器推送的登录态,最近一份即真相。 */
export function createSessionpageIdentityAuthStore() {
  let current: SessionpageIdentityAuthSnapshot | null = null
  return {
    set(auth: SessionpageIdentityAuth | null): void {
      if (!auth) {
        current = null
        return
      }
      if (!auth.accessToken || !auth.userId) throw new Error('session-page identity auth requires accessToken and userId')
      current = { accessToken: auth.accessToken, refreshToken: auth.refreshToken ?? '', userId: auth.userId }
    },
    get: async (): Promise<SessionpageIdentityAuthSnapshot | null> => current,
  }
}

export function wireHeadlessSessionpageIdentity(hostIpc: HostIpc): { dispose(): void } {
  const auth = createSessionpageIdentityAuthStore()
  let capabilities: Promise<DeviceCapabilities> | null = null
  const identity = createSessionpageIdentityHost({
    getAuth: auth.get,
    // 与桌面主进程同一个解析(按 owner 记一次、首次登记心跳);这里没有设备运行时可等。
    resolveDeviceId: createLocalDeviceIdResolver({
      getAuth: auth.get,
      heartbeatClient: (accessToken) => makeIdentityClient(accessToken) as unknown as DeviceHeartbeatTableClient,
      capabilities: () => (capabilities ??= detectDeviceCapabilities()),
      warn: (message) => log.warn(`[session-host] session-page ${message}`),
    }),
    resolveProjectName: (projectId) => emdashProjectName(projectId),
    takeBirthGroup: (sessionId) => emdashTakeBirthGroup(sessionId),
    sessionFacts: (target, options) => emdashSessionProvisionInput(target, options),
    listSessionFacts: () => emdashSessionpageSessionFacts(),
  })
  setSessionIdentityHost(identity)
  setTaskNamer({
    defaultName: (provider, taken) => identity.defaultTaskName(provider, taken),
    renameBound: (sessionId, agentUserId, name) => identity.renameBound(sessionId, agentUserId, name),
  })
  const nativeInbox = startNativeConversationInboxHost({
    open: async target => (await identity.ensureAgentAddress(target)).chatId,
    failed: error => log.warn('Personal conversation address remains pending', error),
  })
  // 自营模型这一套:与桌面主进程共用的实现,只喂它这个宿主的三样(登录态 / 身份供给 / 文案)。
  // 无头宿主没有 locale store(那是窗口壳的东西),用回退 locale 的目录 —— 这三条话术只在响亮失败时出现。
  // 无头宿主的登录态是浏览器推过来的一份快照,`auth.get` 本来就是现读 —— 这里包成常量口,
  // 与桌面壳共用同一个「取数口」契约(#5092)。
  const headlessAuthProvider = { getAuth: auth.get }
  const platform = createSessionpagePlatformHooks({
    authProvider: () => headlessAuthProvider,
    provisionDeps: identity.provisionDeps,
  })

  // 会话启动即开账号。两处都只落身份、不改启动参数:ACP 不注入 MCP(返回空表),PTY 不接管命令(返回 null)。
  // 供给失败按 fail-loud 抛出 —— 一条没有身份的会话在网页版就是一条坏会话(owner 定的产品预期:每个会话都是一个 agent)。
  setEmdashIdentityProvisioner(request => identity.provisionSessionStart({ ...request, surface: 'acp' }))
  setEmdashMcpInjector(async () => ({ mcpServers: [] }))
  setEmdashPtySessionpageHook(async (info) => {
    await identity.provisionSessionStart({
      sessionId: info.sessionId,
      sourceSessionId: info.sourceSessionId,
      providerId: info.providerId,
      surface: 'tui',
      cwd: info.cwd,
      projectId: info.projectId,
      displayName: info.agentDisplayName,
      lifecycle: info.isResuming ? 'resume' : info.forkFromProviderSessionId ? 'fork' : 'fresh',
    })
    // 选了咕咕自营模型 ⇒ 把中转声明叠到启动参数上;没选 ⇒ 返回 null,启动参数与从前逐字相同。
    // 这里没有桌面壳那个 provider hook(sidecar/投递登记那一层),所以走「无 override」的那条分支。
    const { platform: resolved } = await platform.ptyPlatform(info)
    return applyPlatformToPtyLaunch(info, resolved)
  })
  setEmdashPtySessionpageTeardown(async (sessionId) => {
    // 会话真的结束 ⇒ 结清这条会话握着的平台令牌。不撤销就一直在网关上占额度,而且续期定时器会把
    // 「一个 TTL 之后自愈的泄漏」续成永久泄漏。
    await platform.release(sessionId)
  })
  setEmdashPlatformInjector((info) => platform.acpInjector(info))
  setEmdashPlatformRelease((sessionId, expectedAccessSessionId, intent) =>
    platform.release(sessionId, expectedAccessSessionId, intent))
  setEmdashPlatformCheckpoint((sessionId) => platform.checkpoint(sessionId))
  // @@@4972 agent 自己用 `session_list_models` 查到的那一组。装进去的**就是**下面 composer 那条
  // 通道调的同一份实现 —— 只接下拉不接这一口,会让「用户看得到、agent 查不到」在网页版变成常态。
  setPlatformModelCatalogResolver((query) => platform.listModels(query))

  // #6396 名字登记时已被占用 ⇒ 在这条会话的对话里画一行告知(与桌面主进程同一份,见 sessionpage-rename-announcement.ts)。
  // 名字不在 agent 的上下文里(要知道就调 profile_whoami,#6490);owner 改名同理,不需要另行告知。
  const announceRename = (rename: SessionpageAgentNameTaken): void => {
    void announceEmdashSession(sessionpageRenameAnnouncement(rename))
      .then(({ delivered }) => log.info(`[session-host] #6396 agent rename announced (delivered=${delivered})`))
      .catch((error: unknown) => log.warn('[session-host] #6396 agent rename could not be announced: ' + String(error)))
  }
  const broadcast = <T>(definition: EventDefinition<T>, data: T): void => {
    hostIpc.broadcast(definition.name, data)
  }
  // #7341 第二步 项目跨设备:`projects.*` 的项目群四件事与桌面主进程同一份实现,只喂它这个宿主的登录态。
  setUserLibraryOwner(async () => (await auth.get())?.userId ?? null)
  setProjectGroupHost(createSessionpageProjectGroupHost({ getAuth: auth.get }))
  const unsubscribeGroupMapping = onProjectGroupMappingChanged(({ projectId }) => notifyProjectGroupBindingChanged(projectId))
  const unsubscribeProvisioned = onSessionpageAgentProvisioned((event) => {
    // 浏览器那头按事件定义认领(键叫 conversationId),❌ 原样转主进程这份事件(它叫 sessionId)。
    broadcast(sessionpageAgentProvisionedEvent, {
      conversationId: event.sessionId,
      agentUserId: event.agentUserId,
      displayName: event.displayName,
    })
    if (event.renamedFrom) announceRename({ ...event, previousName: event.renamedFrom })
  })

  const controller = createRPCController<SessionpageIdentityRpc>({
    setAuth: async (next) => {
      auth.set(next)
      await setTaskNameOwner(next?.userId ?? null)
      // The browser pushes auth when it reconnects: names renamed meanwhile are published now.
      if (next) await identity.publishPendingNames()
      if (next) await identity.adoptCloudNames()
      // Once, after the cloud names: a legacy task's old title names its default-named identity (0043).
      if (next) await adoptLegacyTaskNames()
      log.info('[session-host] identity auth ' + (next ? `set for ${next.userId}` : 'cleared'))
    },
    agentCard: (sessionId) => identity.agentCard(sessionId),
    agentNames: () => identity.agentNames(),
    sessionPeers: (...args) => identity.sessionPeers(...args),
    ensureAgentAddress: (input) => identity.ensureAgentAddress(input),
  })
  registerRPCRouter({ sessionpageIdentity: controller }, hostIpc.ipcMain)
  // #7103 人点的重试(经别的设备来也一样):这条会话下一次签咕咕额度真去问一次。
  hostIpc.ipcMain.handle(SESSIONPAGE_PLATFORM_RETRY_CHANNEL, (_event: unknown, sessionId: unknown) => {
    if (typeof sessionId !== 'string' || !sessionId.trim()) throw new Error('session id is required for a platform retry')
    clearPlatformIssueBackoff(sessionId.trim())
  })
  // composer 下拉「咕咕提供的模型」那一组的数据源。渲染层走通用 invoke,所以这里按同名通道注册。
  hostIpc.ipcMain.handle(SESSIONPAGE_PLATFORM_CATALOG_CHANNEL, async (_event: unknown, input: unknown) => {
    const row = (input ?? {}) as { providerId?: unknown; surface?: unknown; sessionId?: unknown }
    if (typeof row.providerId !== 'string') throw new Error('providerId must be a string')
    if (row.surface !== 'acp' && row.surface !== 'tui') {
      throw new Error('surface must be acp or tui')
    }
    return platform.catalog({
      providerId: row.providerId,
      surface: row.surface,
      sessionId: typeof row.sessionId === 'string' ? row.sessionId : null,
    })
  })

  return {
    dispose() {
      nativeInbox.dispose()
      setTaskNamer(null)
      unsubscribeProvisioned()
      unsubscribeGroupMapping()
      setUserLibraryOwner(null)
      setProjectGroupHost(null)
      setSessionIdentityHost(null)
      setEmdashMcpInjector(null)
      setEmdashIdentityProvisioner(null)
      setEmdashPtySessionpageHook(null)
      setEmdashPtySessionpageTeardown(null)
      setEmdashPlatformInjector(null)
      setEmdashPlatformRelease(null)
      setEmdashPlatformCheckpoint(null)
      setPlatformModelCatalogResolver(null)
    },
  }
}
