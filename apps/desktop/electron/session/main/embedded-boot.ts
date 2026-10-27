// @@@sessionpage — the session backend's EMBEDDED-MODULE entry. The session backend is a cohesive
// submodule (owner #43), NOT a set of gugu subsystems: it exposes exactly ONE boot entry here, and gugu
// (the host) invokes it + bridges IPC — the host never reaches into the session backend's DB / pty /
// services individually. `bootEmdashModule` runs the session backend's [SUBSYSTEM] init sequence inside
// the host's already-ready electron-28 main, then registers the complete rpcRouter on the host ipcMain.
//
// Every [APP-BOOTSTRAP] / [SHARED-CONFLICT] step is deliberately NOT imported and NOT called — the host
// owns them:  app-identity/userData repoint · app:// protocol scheme · application menu · main window ·
//   auto-updater · quit handler / single-instance / second-instance / dock · process-error logging ·
//   macOS microphone prompt · PATH hydration (the host's hydrateLoginShellPath() does it once —
//   one implementation, no drift).
//
// This lives on the session backend's side so the MODULE owns its own boot. The thin host-side entry
// apps/desktop/electron/sessionpage/emdash-main-bridge.ts merely re-exports it; the
// gugu-bundle-emdash-taskpage esbuild plugin bundles the pair → dist-electron/taskpage/
// emdash-main-bridge.cjs with electron + native addons (better-sqlite3, node-pty, @parcel/watcher)
// externalized (required at runtime).
import type { BirthGroup } from '@shared/core/sessions/create-session';
export { readCurrentActivityInput,readCurrentAssistantWorkInput } from './core/sessions/session-activity-source'
import { installActivityCollector } from '@main/core/activity/collector'
import { openLink } from './core/extensions/gugu-links'
import type { LinkOpenOutcome } from '@shared/extensions/open-link'
import * as path from 'node:path'
import { appSourcesRoot, extensionDataRoot, extensionsService } from './core/extensions/extensions-root'
import { appKey } from '@shared/extensions/app-identity'
import { ensurePreinstalledApps } from './core/extensions/preinstalled-apps'
import { firstRunAtBoot } from './core/extensions/first-run-apps'
import { autoUpdateAtBoot } from './core/extensions/auto-update-apps'
import { EXTENSION_DATA_DIR_NAME } from './core/extensions/extension-data'
import { extensionPrograms, stopAllExtensionPrograms, type ExtensionPrograms } from './core/extensions/extension-programs'
import type { ExtensionManifest, ExtensionMcpServerContribution } from '@shared/extensions/manifest'
import {
  bundleContentDigest,
  ensureSessionSnapshot,
  pruneExtensionData,
  pruneSessionSnapshots,
  sessionSnapshotDir,
} from './core/extensions/extension-session-snapshot'
// 装完之后重新读登录 shell PATH 的注入口 —— 实现(hydrateLoginShellPath)住宿主,理由见
// utils/userEnv.ts 的 setLoginShellPathRehydrator 注释:那个模块有模块级状态,跨 bundle
// import 只会拿到复制品。
import { encryptedAppSecretsStore } from '@main/core/secrets/encrypted-app-secrets-store'
import { interruptTuiTurn } from '@main/core/sessions/interrupt-tui-turn'
import { resolveSystemProxy } from '@main/utils/systemProxyEnv'
export { setLoginShellPathRehydrator } from './utils/userEnv'
// #5873 同一个属主的另一半:整份登录 shell 环境的快照。PATH 早就在补,而 key / 代理
// 一直没人送 —— 终端腿靠 `-il` 自己 source 到,TUI 腿(`zsh -c`)与聊天腿(裸 spawn)读不到。
export { setLoginShellEnvProvider } from './utils/userEnv'
// #6264 这条终端会话是不是跑在咕咕平台模型上:平台令牌的持有表住宿主,由宿主注入(同上,❌ 相对 import)。
export { setPlatformCredentialsProbe } from './core/agent-config/auth-expiry-from-turns'
// @@@5301 会话页 agent 系统通知的正文注入口。会话页 ❌ 不 import 宿主的语言 store
// (它有模块级状态,跨界只会拿到复制品) —— 由宿主把当下语言的两句文案推进来。
export { setSessionAgentNotificationCopy } from './core/agent-hooks/notification-copy'
export type { SessionAgentNotificationCopy } from './core/agent-hooks/notification-copy'
// 宿主的界面语言(App 名字等由会话页这侧拼给人看的字按它挑语言),同上由宿主注入。
export { setSessionHostLocale } from './core/host-locale'
import { createHash, randomUUID } from 'node:crypto'
import { performance } from 'node:perf_hooks'
import { app, BrowserWindow, MessageChannelMain, session as electronSession, type IpcMain } from 'electron'
import { installDevicePaneRelay } from './host-ws/device-pane-relay'
import { installDeviceSessionHost } from './host-ws/device-session-host'
import {
  composeHostIpc,
  createElectronHostIpc,
  setHostIpc,
  type HostIpc,
} from '@main/lib/host-ipc'
import type { SessionSummary } from '@gugu/session-core/acp'
import { formatSessionTitleForDisplay } from '@shared/core/sessions/session-title-utils'
import { sessionViewOfRuntime, type SessionView } from '@shared/core/sessions/sessions'

import { registerRPCRouter } from '@shared/lib/ipc/rpc'
// The host owns the recovery coordinator, but the session-page RPC router lives in
// this separately bundled module graph. Re-export the setter so the host can
// install the same gate in this bundle instead of mutating a duplicate module.
export { setPlatformRecoveryReadyGate } from './core/sessions/platform-recovery-gate'
export { setSessionAdmissionPreparation } from './core/sessions/session-admission-preparation'
export { assistantPanelLocal } from './core/app/assistant-panel-local'
import { registerWebviewAttachPolicy } from '@main/app/webview-policy'
import { setupPreviewProtocol } from '@main/core/files/preview-protocol'
import {
  installExtensionBridgeRelay,
  requestExtensionInstallConsent,
} from '@main/core/extensions/extension-bridge-relay'
import {
  notifyExtensionAgentsChanged,
  registerExtensionBridge,
} from '@main/core/extensions/extension-bridge'
import { runExtensionAgentAction } from '@main/core/extensions/extension-agent-actions'
import { heardAgentEvent } from '@main/core/extensions/extension-agents'
import { askInstallInSession } from '@main/core/extensions/consent-in-session'
import { agentIdsBySession, localAgentForSession } from '@main/core/sessionpage/sessionpage-session-agent'
import { checkExtensionSurface, closeCheckPages } from '@main/core/extensions/extension-check'
import { lookGalleryPicture } from '@main/core/extensions/extension-look-picture'
import type { ExtensionPicture } from '@shared/extensions/extension-check'
import {
  stopAllExtensionBackgrounds,
  syncExtensionBackgrounds,
} from '@main/core/extensions/extension-background'
import { rpcRouter } from '@main/rpc' // ← the complete router, every controller
import { initializeDatabase } from '@main/db/initialize'
import { closeDatabase, db, sqlite } from '@main/db/client'
import { resolveDatabasePath } from '@main/db/path'
import { backupBeforeTaskToSession, runTaskToSessionOnce } from '../../migrations/task-to-session'
import { backupBeforeSessionNaming, runSessionNamingOnce } from '../../migrations/session-naming'
import { tmuxBackendStartupSweepSettled } from '../../sessionpage/tmux-backend'
import { sessions, workspaces as workspacesTable } from '@main/db/schema'
import { eq } from 'drizzle-orm'
import { agentStatusWriter } from '@main/core/agent-status/agent-status-writer'
import {
  closeInterruptedRunIntervals,
  installRunIntervalRecorder,
} from '@main/core/usage/run-interval-recorder'
import { installIdleReclaim } from '@main/core/sessions/install-idle-reclaim'
import {
  claimDataDir,
  dataDirHeldByAnotherHost,
  releaseDataDir,
} from '@main/core/data-dir-occupancy'
import {
  claimInterruptedDispatches,
} from '@main/core/sessions/sendMessage'
import { claimInterruptedDeferredMessages, installDeferredMessageDelivery } from '@main/core/sessions/session-deferred-messages'
import { hydrateSession } from '@main/core/sessions/hydrateSession'
import { recordLiveModelSwitch } from '@main/core/sessions/live-model-switch'
import { readSessionOptions, SessionOptionsError } from '@main/core/session-timeline/live-options'
import { platformModelIdFromRuntimeOption, runtimeOptionForPlatformModelId } from '@shared/platform-model-id'
import { searchService } from '@main/core/search/search-service'
import { workspaceFileIndexService } from '@main/core/search/workspace-file-index-service'
import { editorBufferService } from '@main/core/editor/editor-buffer-service'
import {
  cleanupLegacyBrowserPartitions,
  migrateLegacyBrowserPartitionDirs,
} from '@main/core/browser/browser-partition-cleanup'
import { sweepOrphanSessionAttachmentDirectories } from '@main/core/sessions/attachments/session-attachment-store'
import { projectSettingsService } from '@main/core/projects/settings/project-settings-service'
import { getProjectById, getProjects } from '@main/core/projects/operations/getProjects'
import { resolveAgentSessionProject } from '@main/core/projects/operations/resolve-agent-session-project'
import { resolveSession, resolveWorkspace } from '@main/core/projects/utils'
import { deleteSession } from '@main/core/sessions/deleteSession'
import { getSessions } from '@main/core/sessions/getSessions'
import { mcpLibraryService, planLibraryMcpDelivery } from '@main/core/mcp-library/service'
import { mcpService } from '@main/core/mcp/services/McpService'
import type { LibraryMcpServer } from '@shared/mcp-library'
import type { SessionLibraryMcpFact } from '@shared/core/sessions/session-config'
import { setSessionLibraryMcp } from '@main/core/sessions/set-session-mcp-servers'
import { sessionMcpDeliveryOn } from '@gugu/session-core/agents/plugins'
import { clearProviderSessionId, setProviderSessionId } from '@main/core/sessions/set-session-id'
import {
  type SessionPlatformModel,
  sessionPlatformModel,
  forgetSessionPlatformModel,
  recordSessionPlatformModel,
} from '@main/core/sessions/platform-model-selection'
import { recordUnstartedSessionChoice } from '@main/core/sessions/record-unstarted-session-choice'
import { projectEvents } from '@main/core/projects/project-events'
import { installClearDataPolyfill } from '@main/app/session-clear-data-polyfill'
import { sessionService } from '@main/core/sessions/session-service'
import { attachAgentToSession } from '@main/core/sessions/attach-agent-to-session'
import { assertNoDeliveryEnvelopeInPersistedText } from '@main/core/sessions/build-session-row'
import {
  isGuguPermissionMode,
  resolveSessionPermissionMode,
  type GuguPermissionMode,
} from '@gugu/session-core/acp'
import { agentSupportsPermissionMode } from '@shared/core/agents/agent-payload'
import { UNATTENDED_SESSION_PERMISSION_MODE } from '@main/core/sessions/unattended-session-autonomy'
import { getPlugin, listPlugins, toAgentProviderId } from '@main/core/agents/plugin-registry'
import { recordChildHarnessDefault } from '@main/core/sessions/child-harness-default'
import { providerConsumesStartupPrompt } from '@gugu/session-core/agents/plugins'
import { pluginRegistry, type AgentProviderId } from '@gugu/session-plugins/agents'
import {
  localSessionIds,
  resolveCreateModelChoice,
  runRemoteSessionAction,
  runSessionAction,
  sessionCallerFacts,
  setRemotePaneOpener,
  stopExactSessionpageSession,
  type SessionAction,
  type SessionCallerContext,
} from '@main/core/sessions/session-orchestration'
import { sharedRemotePaneRoute } from '@main/core/session-timeline/remote-pane'
import { releaseSubscriptionsOf } from '@main/core/session-timeline/controller'
import { setSessionAcpSessionStopper, sessionWorkspaceManager } from '@main/core/sessions/session-workspace-manager'
import { prSyncScheduler } from '@main/core/pull-requests/pr-sync-scheduler'
import { disposeLocalPtySessions } from '@main/core/pty/local-pty'
import { listTmuxSessionNames } from '@main/core/pty/tmux-session-name'
import { LocalExecutionContext } from '@main/core/execution-context/local-execution-context'
import { automationsService } from '@main/core/automations/automations-service'
import { appService } from '@main/core/app/service'
import { appSettingsService } from '@main/core/settings/settings-service'
import { settleTerminalEnabled } from '@main/core/settings/terminal-visibility'
import { browserWebContentsRegistry } from '@main/core/browser/browser-webcontents-registry'
import { setBrowserCorsRelaxationSettings } from '@main/core/browser/browser-profile-session'
import { promptLibraryService } from '@main/core/prompt-library/service'
import { agentHookService } from '@main/core/agent-hooks/agent-hook-service'
import { isAppFocused } from '@main/core/agent-hooks/app-focus'
import {
  disposeAcpRuntimeProcess,
  getAcpRuntimeClient,
  initializeAcpRuntimeProcess,
  peekAcpRuntimeClient,
  type AcpAnnounceSessionInput,
} from '@main/core/acp/controller'
import {
  disposeAgentConfigRuntimeProcess,
  initializeAgentConfigRuntimeProcess,
} from '@main/core/agent-config/controller'
import { acpAgentStatusBridge } from '@main/core/acp/agent-status-bridge'
import {
  listSessionStates,
  setConnectionConfigRootResolver,
  setSessionStatusFeed,
} from '@main/core/session-timeline/service'
import { connectionConfigRoot } from '@main/core/agents/harness-connections'
import { acpSessionLive, setSessionCancel, setSessionWake } from '@main/core/session-timeline/write-bridge'
import { setOtherMachines } from '@main/core/sessions/session-family'
import { setAgentSessionHost } from '@main/core/sessions/agent-session-controller'
import { answerAppMessage } from '@main/core/extensions/extension-send'
import { answerAppReadFile } from '@main/core/extensions/app-files-elsewhere'
import { answerAppCall } from '@main/core/extensions/app-programs-elsewhere'
export { spawnAgentForExtension } from '@main/core/extensions/extension-agents'
export { answerAppMessage, answerAppReadFile, answerAppCall, setAgentSessionHost }
import { readAcpSessionSummaries } from '@main/core/acp/session-summary-reader'
import { flushLogWrites, setLogFileOwner } from '@main/lib/file-logger'
import { setSessionMessageOutboxReady } from '@main/core/sessions/session-message-router'
import { sessionProcess } from '@main/core/sessions/session-process'
export { sessionProcess }
export { setUserLibraryOwner } from '@main/core/app/user-library'
// #7341 第二步 项目跨设备:`projects.*` 的项目群四件事由宿主接上实现(对照 / 登录态 / 云端都在宿主那边);
// 宿主那份对照的唯一写口每写一次就经这里让渲染层重读。
export {
  notifyProjectGroupBindingChanged,
  setProjectGroupHost,
  type ProjectGroupHost,
  type ProjectGroupSubject,
} from '@main/core/projects/project-group-host'
export {
  localSessionIds,
  setOtherMachines,
  runRemoteSessionAction,
  runSessionAction,
  sessionCallerFacts,
  type SessionAction,
  type SessionCallerContext,
}
import { checkpointEmdashPlatformSession } from '@main/core/acp/emdash-platform-injector'
// 模型目录第二遍探测的占位中转凭据 —— 实现住在宿主 bundle(要用 engine-injection-contract 与
// capability-bundle),会话页这边只留注入口。不注册 = 第二遍与第一遍完全一样,目录退回「未登录」。
export {
  setProbePlatformEnvResolver,
  type ProbePlatformEnvResolver,
} from '@main/core/agents/harness-model-catalog'
// @@@4972 「咕咕提供的模型」那一组的读取口 —— 会话发现工具(session_list_models)与 composer 下拉
// 必须给出同一份,而算它要账号态与引擎协议映射,两样都住宿主 bundle。不注册 = 那一组缺席,
// session_list_models 只剩 harness 自家模型(与改动前逐字节相同)。
export {
  setPlatformModelCatalogResolver,
  type PlatformCatalogModel,
  type PlatformModelCatalogQuery,
  type PlatformModelCatalogResolver,
  type PlatformModelCatalogSnapshot,
} from '@main/core/agents/platform-model-catalog-hook'
// @@@sessionpage TASKPAGE-FUSION — re-export the MCP-injector setter on the module boundary so the gugu
// host can give session-page codex sessions the gugu MCP send tool + gugu identity at session start.
export {
  setEmdashMcpInjector,
  type EmdashMcpInjector,
  type EmdashSessionStartInfo,
} from '@main/core/acp/emdash-mcp-injector'
// @@@2503 同一个边界上再开一个钩子:让咕咕宿主给走平台额度的 Chat UI 会话按会话签发中转令牌,
// 随 session/new | session/load 的 `_meta` 一起送进适配器。不注册 = ACP 会话行为与从前相同。
export {
  setEmdashPlatformInjector,
  setEmdashPlatformCheckpoint,
  setEmdashPlatformRelease,
  withEmdashPlatformSessionRestart,
  type EmdashPlatformCheckpoint,
  type EmdashPlatformInjection,
  type EmdashPlatformInjector,
  type EmdashPlatformRelease,
} from '@main/core/acp/emdash-platform-injector'
// @@@sessionpage TASKPAGE-FUSION — re-export the PTY-divert hook setters so the gugu host can turn a
// session-page codex PTY conversation into a `codex --remote … resume <tid>` client of a gugu-started
// app-server (native TUI + socket delivery, same session). Default (unset) = PTY spawns unchanged.
export {
  setEmdashPtySessionpageHook,
  setEmdashPtySessionpageTeardown,
  // #4653 —— 对话页首轮的信封解析口(PTY 腿上 emdash-mcp-injector 的孪生)。
  setEmdashPtyChatStartupEnvelope,
  type EmdashPtySessionpageHook,
  type EmdashPtySessionpageTeardown,
  type EmdashPtySessionpageStartInfo,
  type EmdashPtyCommandOverride,
  type EmdashPtyChatStartupEnvelope,
  type EmdashPtyChatStartupRequest,
} from '@main/core/sessions/impl/emdash-pty-sessionpage-hook'
export {
  setSessionMessageRouter,
  setSessionLiveNotifier,
  setSessionMessageOutboxReady,
  type SessionMessageRouter,
} from '@main/core/sessions/session-message-router'
export {
  listPendingSessionDirectMessages,
  acceptPendingSessionDirectMessage,
  recordFailedSessionDirectMessage,
  // 宿主在「投递属主注册好了」那一刻要用它把排队的首轮送出去 —— 收件箱 pull 看不见 `ordinary` 行。
  drainSessionMessageOutboxById,
} from '@main/core/sessions/sendMessage'
// @@@3816 — the session-page PTY provider lives in this bundle, while the authoritative local-session
// ownership map lives in gugu main. Pass the binding/callback contract across the module boundary; do not
// rely on the two bundles sharing a module-level Map.
export {
  setLocalSessionDeliveryBridge,
  type LocalSessionDeliveryBridge,
} from '@main/core/sessionpage/local-session-delivery'
// @@@sessionpage 导入本机会话 (spec session-page-import) — 本机 transcript 的扫描与解析归 gugu 侧
// （packages/core 那份已经处理过旁支/注入记录等脏数据），宿主 boot 时把它注入进来；
// 没注入时会话页的导入入口不显示，而不是显示了点进去才发现读不到。
export {
  setEmdashLocalSessionSource,
  type LocalSessionSource,
} from '@main/core/session-import/host-source'
// @@@2374 — 扩展的宿主动作(改标题/角标、开浏览器 tab、报错、投进对话)最后一步必须回到宿主
// 那个渲染器。宿主的 renderer 通道住在 main.js 里,会话页这一侧 import 不到它——相对 import
// 只会把那个模块**再打一份**进本 bundle,而那一份的窗口永远是 null。所以走注入。
export {
  setExtensionHostWindowChannel,
  type ExtensionHostWindowChannel,
} from '@main/core/extensions/extension-bridge-relay'
import { reconcileResourceSampler, stopResourceSampler } from '@main/core/resource-monitor/resource-sampler'
import { ensureAgentDependenciesProbed, localDependencyManager } from '@main/core/dependencies/dependency-managers'
import { ensureAgentInstalled } from '@main/core/agents/ensure-agent-installed'
import { DEPENDENCIES } from '@main/core/dependencies/registry'
import {
  createProbeOrphanSweepDeps,
  sweepProbeOrphans,
} from '@main/core/dependencies/probe-orphan-sweep'
import { projectManager } from '@main/core/projects/project-manager'
import { runtimeManager } from '@main/core/runtime/runtime-manager'
import { appScope } from '@main/app/app-scope'
import { sessionEvents } from '@main/core/sessions/session-events'
import { type AgentEvent } from '@shared/core/agents/agentEvents'
import { busyForVersionSwitch, parseAgentStatusView, type AgentStatusView } from '@gugu/core/shared/agentStatus'
import {
  type AgentStatusChange,
  type SessionScope,
} from '@shared/core/sessions/sessionEvents'
import { log } from '@main/lib/logger'
import { guguNodeTarget, installGuguNode } from './core/pty/gugu-node'
import { createStageLedger, type StageLedger } from '@main/lib/stage-ledger'
import { openProject } from '@main/core/projects/operations/openProject'
import { withRpcLogging } from '@main/lib/rpc-logging'
import { pluginIdForAgentType } from '@gugu/core/agentTypes'

// The full router, re-exported so the host's renderer IPC bridge can type the surface.
export const emdashRpcRouter = rpcRouter
export type EmdashRpcRouter = typeof rpcRouter

/**
 * ELECTRON-28 API GAP SHIM. The session backend's browser-webcontents-registry calls `Session.clearData(...)` — an
 * API added in Electron 37. On the host's Electron 28 it is `undefined`, so the in-app browser's "clear
 * browsing data" path would throw at runtime. We feature-detect it once and, if absent, install a
 * best-effort polyfill on the Session PROTOTYPE mapping `clearData` onto the Electron-28 primitives
 * `clearStorageData` + `clearCache`.
 *
 * ADDITIVE + app-global-safe: Electron 28 genuinely lacks `clearData`, and the host never calls it, so
 * adding the method to the shared prototype can only enable the session backend's path — it cannot change host
 * behavior. Shims RUNTIME behavior WITHOUT editing the calling site (the typecheck side is handled by
 * emdash-ambient.d.ts). The one accepted degradation is LOUD.
 */
function installSessionClearDataShim(): void {
  if (installClearDataPolyfill(electronSession.defaultSession)) {
    log.warn(
      '[sessionpage] Session.clearData absent (Electron < 37) — installed best-effort polyfill ' +
        '(clearStorageData + clearCache). The in-app browser data-clear degrades gracefully; some ' +
        'site-data types may be over/under-cleared until the host upgrades Electron.',
    )
  }
}

/**
 * Boots the session backend MODULE inside the host's already-ready main process — its ordered
 * subsystem init — then registers the full RPC router
 * against the host `ipcMain`. The host calls this ONE entry; it must never cherry-pick the steps below.
 */
/** 咕咕 server(server-entry.ts):同一份主进程,没有窗口、没有渲染层。 */
const HEADLESS_SERVER = process.env.GUGU_SERVER_MODE === '1'

export async function bootEmdashModule(ipcMain: IpcMain, discovery?: Pick<SessionHostBootOptions, 'scheduleDiscovery'>): Promise<void> {
  // #6264 没有窗口:会话里的 open_in_tab 送到正看着这条会话的桌面,❌ 问一个不存在的渲染层干等超时(remote-pane.ts)。
  if (HEADLESS_SERVER) setRemotePaneOpener(sharedRemotePaneRoute())
  const electronIpc = createElectronHostIpc({ ipcMain, BrowserWindow, MessageChannelMain })
  // @@@task-web-host 方案 A:桌面 app 额外对浏览器开一个 WebSocket 口。owner 09-03 硬约束——这个口等于
  // 「操纵本机 agent 与 shell」,**对安装用户必须不可用**:打包版永远不起;dev 也要显式开关。
  // 网页版(pnpm dev:web)不走这里,它自带无头宿主(session-host-entry.ts),不依赖这个开关。
  const devWs = await maybeStartDevWsHost()
  // #6264 别的桌面经设备连接(SSH / 咕咕云)用这台机器的会话页宿主 —— 与本机窗口同一张路由表(host-ws/device-session-host.ts)。
  const deviceHost = installDeviceSessionHost({ appVersion: () => app.getVersion() })
  // 看着这台机器上会话的那几台电脑(订阅随连接生灭):open_in_tab 的 tab 开到它们那里(host-ws/device-pane-relay.ts)。
  if (HEADLESS_SERVER) installDevicePaneRelay(deviceHost, sharedRemotePaneRoute())
  await bootSessionHostCore({
    hostIpc: composeHostIpc(devWs ? [electronIpc, deviceHost, devWs] : [electronIpc, deviceHost]),
    browserFeatures: true,
    ...discovery,
  })
}

async function maybeStartDevWsHost(): Promise<HostIpc | null> {
  if (app.isPackaged || process.env.GUGU_TASK_HOST_WS !== '1') return null
  const { startSessionHostWsServer } = await import('./host-ws/server')
  const server = await startSessionHostWsServer({
    host: process.env.GUGU_TASK_HOST_BIND,
    port: process.env.GUGU_TASK_HOST_PORT ? Number(process.env.GUGU_TASK_HOST_PORT) : undefined,
    token: process.env.GUGU_TASK_HOST_TOKEN,
  })
  log.warn('[task-web-host] dev-only WebSocket host is OPEN (GUGU_TASK_HOST_WS=1)', {
    url: server.url,
  })
  return server.hostIpc
}

export type SessionHostBootOptions = {
  hostIpc: HostIpc
  /** 只有 Electron 窗口宿主为 true:<webview> 准入、扩展桥、内置浏览器分区。无头宿主 false。 */
  browserFeatures: boolean
  /** The host owns the first-request boundary; ordinary desktop hosts discover immediately. */
  scheduleDiscovery?: (work: () => Promise<void>) => Promise<void>
}

/**
 * 宿主无关的 boot 核心:Electron 桌面 app 与无头宿主共用同一序列,只在 browserFeatures 上分叉。
 */
export async function bootSessionHostCore(options: SessionHostBootOptions): Promise<void> {
  setHostIpc(options.hostIpc)
  // 经网络连进来的线(别的电脑、手机)开的时间线 / 会话列表订阅,线断了一并拆:寿命跟着连接走,❌ 另设保活。
  options.hostIpc.onConnectionClosed?.(releaseSubscriptionsOf)
  const { ipcMain } = options.hostIpc
  const { browserFeatures } = options
  // 首启默认组(161 10-15):这个 profile 是不是第一次启动,只有在任何东西建出 App 的记录目录之前才看得出来 —— 所以最先。
  // 只归桌面和咕咕 server(first-run-apps.ts `firstRunAtBoot`):网页版的无头宿主不记、不装。
  const firstRun = firstRunAtBoot(browserFeatures)
  firstRun.noteProfile(app.getPath('userData'))
  // --- Electron-28 API gap shim FIRST — before any code path can touch a Session (index.ts:0). ---
  if (browserFeatures) installSessionClearDataShim()

  // --- Webview admission control (#2374). Idempotent: the host installs it as soon as it loads
  // this module (main.ts), because a policy that only exists once an optional boot succeeds would
  // turn deny-by-default into allow-by-default exactly when something has already gone wrong.
  // Repeated here so any caller of this entry gets it regardless of how it was reached.
  if (browserFeatures) registerWebviewAttachPolicy()

  // --- 网页预览的文件供给(#6156)。scheme 在宿主 main.ts 里早于 app ready 注册,handler 装在
  // 这儿,因为只有到这一步才拿得到工作区。无头宿主没有 protocol,所以跟着 browserFeatures 走。
  if (browserFeatures) setupPreviewProtocol()

  // --- The half of the bridge that ANSWERS (#2374). Every `window.gugu.*` call is an
  // `ipcRenderer.invoke` on this channel, so without this line the handler does not exist and
  // EVERY call fails with「No handler registered for 'gugu-ext:call'」—— which is exactly what
  // shipped: the function was defined and never called, so no extension could read a file, set
  // its title, or learn its own context. It went unnoticed because a surface that can draw its
  // own HTML still LOOKS fine, and the examples' empty states ("这个工作副本里没有 .sql 文件")
  // are the same words they print when every call fails. ❌ 别把「面画出来了」当成「桥通了」。
  if (browserFeatures) registerExtensionBridge()

  // @@@4467 任务结束的**第二条腿**:PTY 会话归 SessionMount 自己 destroyAll,ACP 会话活在 ACP worker 里,
  // 只认它自己的 stopSession —— 而平台令牌的结清正挂在那个 stop 上(runtime 停记录 → 通知宿主 release →
  // 删 0600 settings 文档 + 清续期定时器)。少这条腿,归档在用户眼里结束了,凭证还留在盘上。
  // 由组合根接线(与 setEmdashPlatform* 那批同形):session-main 的中心件不该静态引 ACP host 的模块级 scope。
  // ⚠️ worker 没起就什么都不做:那意味着一条 ACP 会话都不存在,把它叫醒等于收尾自己制造出要收的东西。
  setSessionAcpSessionStopper(async ({ sessionId }) => {
    const client = await peekAcpRuntimeClient()
    if (!client) return
    const [row] = await db
      .select({ runtime: sessions.runtime })
      .from(sessions)
      .where(eq(sessions.id, sessionId))
      .limit(1)
    if (row?.runtime !== 'acp') return
    const result = await client.stopSession({ sessionId }).catch((error: unknown) => {
      log.warn('session teardown: ACP session stop threw', { sessionId, error: String(error) })
      return null
    })
    // 归档在用户眼里已经发生了,没停干净不该把整个归档判失败;响亮记一笔。
    if (result && !result.success) {
      log.warn('session teardown: ACP session stop reported an error', { sessionId, error: result.error })
    }
  })

  // --- The half of the bridge that acts (#2374). Installed here rather than beside the attach
  // policy because it is not a gate: with it missing, an allowed action throws「host is not
  // installed」and the extension is told it failed. ❌ 别把它挪到能静默缺席的地方。
  if (browserFeatures) installExtensionBridgeRelay()

  // --- 咕咕自带的 Node 摆上 agent 的 PATH(gugu-node.ts):早于任何会话起来。装不上只少了这一样,响亮记一笔、不挡启动。
  try {
    const target = guguNodeTarget(process.env, process.execPath)
    installGuguNode(target)
    log.info('gugu-node installed', target)
  } catch (error) {
    log.warn('gugu-node could not be installed: agents here get no gugu-node to run scripts with', { error: String(error) })
  }

  // --- DB first (index.ts:112-122). Migrations run here; controllers assume a migrated DB. ---
  // task → session(DESIGN §4.2):迁移前整库备份 → 段 1(0032,在 initializeDatabase 里)→ 段 2(库外:tmux 名、
  // 名册、浏览器分区、无主附件)。段 2 必须赶在任何会话恢复、tmux 重连、名册加载、浏览器会话之前,并且等启动时
  // 那次 tmux 后台清扫落定(改名改到一半被它看见会收掉后台)。段 2 失败不拦启动:不写 .done、下次重试,失败项响亮记下。
  await backupBeforeTaskToSession(sqlite, resolveDatabasePath())
  await backupBeforeSessionNaming(sqlite, resolveDatabasePath())
  await initializeDatabase()
  await tmuxBackendStartupSweepSettled()
  await runTaskToSessionOnce({ db: sqlite, userData: app.getPath('userData') }).then(
    (summary) => { if (summary) log.info('task-to-session: segment 2 done', { summary }) },
    (error: unknown) => log.error('task-to-session: segment 2 failed; retrying next start', { error: String(error) })
  )
  // 名字层(0033 之后):存着的 JSON 与库外文件里的旧键名改成新的。新代码只认新名字,所以同样赶在一切读者之前。
  await runSessionNamingOnce({ db: sqlite, userData: app.getPath('userData') }).then(
    (summary) => { if (summary) log.info('session-naming: segment 2 done', { summary }) },
    (error: unknown) => log.error('session-naming: segment 2 failed; retrying next start', { error: String(error) })
  )
  // 开门即已迁完(退役的 lifecycle 条目在门里先迁走);同上面两段一样不等占用判定。
  await setSessionMessageOutboxReady()
  // #6892 起任何 agent / worker 之前问一次系统代理,只补给 agent 与安装器(utils/systemProxyEnv.ts)。
  log.info('[session-host] system proxy for agent processes', await resolveSystemProxy((url) => electronSession.defaultSession.resolveProxy(url)))

  // @@@5080 收残之前先问一句:这份数据目录现在还有别的活宿主在用吗?
  //
  // 下面这几段做的是「上一个进程死了,收干净它的残留」,判据是「我刚启动」—— 那句话只在
  // **一台机器一个宿主**时等于「库里标着正在跑的都是残留」。owner 定的用法(不同时开两个;
  // 真要开两个就各用各的位置)让这个前提成立,但那是纪律不是闸:不小心开了两个时,
  // 后果是**静默且不可撤的** —— 另一个宿主正在干活的 agent 被判停、正在发的消息被判失败。
  //
  // 两边的代价不对称:收不了残 = 几行状态过时,下次独占启动会收掉;误收别人的 = 数据损坏。
  // ⇒ 有人占着就**跳过并喊一声**,❌ 不硬收。
  const dataDir = app.getPath('userData')
  const occupancy = dataDirHeldByAnotherHost(dataDir)
  // 先宣告再收残:占用判定明确排除本进程的 pid,所以宣告不会让自己跳过自己的收残;
  // 而先宣告能把「两个宿主几乎同时开机、都读到『没人占』」的窗口收窄到写文件那一瞬。
  // (❌ 不为此上文件级互斥锁:那一瞬撞上的后果 = 退回今天的行为,不是新的损坏。)
  claimDataDir(dataDir)
  if (occupancy.held) {
    log.warn(
      `[session-host] 这份数据目录正被另一个活着的宿主(pid ${occupancy.byPid})使用 —— `
        + '跳过开机收残,以免把它正在跑的会话判成停止、正在发的消息判成失败。'
        + '两个宿主要同时跑就各配各的 GUGU_TASK_HOST_USER_DATA。'
    )
  } else {
    // 用量页的运行区间:上一个进程没来得及收口的,按它最后一次心跳收 —— 与下面的状态收残同一道闸
    // (别的活宿主占着这份数据目录时,它那几段区间还开着是对的)。
    closeInterruptedRunIntervals()
    // 收残只收引擎随上一个进程没了的会话;在 tmux 里活下来的照旧在跑。tmux 只问这一次,所有会话按同一份列表判。
    // 没有 tmux 服务器 = 空列表(listTmuxSessionNames 自己这样答);问不出来(没装 tmux、tmux 坏了)= 一个都没活下来,
    // 照旧全收 —— 响亮记一条,❌ 为此让开机失败。
    const tmuxSessionNames = await listTmuxSessionNames(new LocalExecutionContext()).catch((error: unknown) => {
      log.error('[session-host] 开机收残问不出 tmux 会话列表,按一个都没活下来收', { error: String(error) })
      return new Set<string>()
    })
    await agentStatusWriter.settleAfterRestart(tmuxSessionNames)
    // 上一个进程投到一半就没了的消息：现在认领为「结果未知」终态（不能重投，只能如实说）。
    // 必须在任何人看见会话之前做完 —— 正常在途不经过这里，所以新建会话不会闪这条提示。
    claimInterruptedDispatches()
    claimInterruptedDeferredMessages()
  }
  searchService.initialize()
  workspaceFileIndexService.initialize()
  void editorBufferService.pruneStale()
  // 附件目录:既不是一条还在的会话、也没有任何一行附件落在里面 ⇒ 孤儿(创建失败、或者删会话时没清成)。
  // ⚠️ 只在这里跑:运行中跑会误删一个正在被新建页攒着、会话还没建出来的草稿目录(#5269)。
  void sweepOrphanSessionAttachmentDirectories().then(
    (removed) => {
      if (removed > 0) log.info('task-attachments: swept orphan directories', { removed })
    },
    (error: unknown) => log.warn('task-attachments: sweep failed', { error: String(error) })
  )
  // 依赖体检的 `<bin> --version` 是 detached 起的(不然只杀得掉直接子进程)，收尾在 finally 里 ——
  // 那一半只在我们还活着时有效。被强杀时子进程活下来，stdio 管道读端却没了，不处理 SIGPIPE 的
  // 程序就在写失败上空转：mac1 实测两个 `amp --version` 各占满一核，清掉两个半小时后又长出两个。
  // ⚠️ 只在这里跑：判据里的「ppid 已变成 1」要求 spawner 确实已经不在，运行中跑会误伤正在进行的探测。
  {
    const deps = createProbeOrphanSweepDeps((rows) =>
      log.info('probe-orphans: swept stuck --version probes', {
        pids: rows.map((row) => row.pid),
      })
    )
    if (deps) {
      void sweepProbeOrphans(
        DEPENDENCIES.flatMap((dependency) => dependency.commands),
        deps
      ).catch((error: unknown) =>
        log.warn('probe-orphans: sweep failed', { error: String(error) })
      )
    }
  }
  // 分区改名后的目录搬迁:必须赶在任何浏览器会话打开之前(下面注册 RPC 之前)同步做完,见函数注释。
  if (browserFeatures) migrateLegacyBrowserPartitionDirs()
  if (browserFeatures) void cleanupLegacyBrowserPartitions()

  // #6387 上一次运行的会话都已随进程结束:它们冻结的扩展副本、以及卸载时延后删的数据夹,在这里清掉。
  // 放在任何会话启动之前,才保证清的都是没人在用的。
  try {
    sweepExtensionSessionLeftovers()
  } catch (e: unknown) {
    log.warn('extensions: failed to sweep session leftovers', { error: e })
  }

  // 预装 App(工作区等)随包带来,每次启动按这一版装一遍(preinstalled-apps.ts)。放在后台拉起之前:
  // 预装 App 若声明了 background,也要在下面那一步被拉起来。
  try {
    ensurePreinstalledApps()
  } catch (e: unknown) {
    log.warn('extensions: failed to install preinstalled Apps', { error: e })
  }

  // 已启用且声明了 background 的扩展,在这里就把后台拉起来 —— ❌ 不能等第一个 tab 打开。
  // 「跨会话共享的活实例」的意思正是它不依赖任何 tab:番茄钟要在你还没打开它那一格的时候
  // 就已经在走。放在这里而不是更早,是因为它要读扩展目录与启用名单,那两样属于已 boot 的服务。
  try {
    syncExtensionBackgrounds()
  } catch (e: unknown) {
    // 说出来而不是让 app 起不来:一个扩展的后台起不来,不该连累整个会话页。
    log.warn('extensions: failed to start backgrounds', { error: e })
  }

  // 首启默认组(owner 10-16「为什么会有安装这一步,而不是一启动就装好了」):新 profile 的那几个 gugu 自己的 App,main 一起来
  // 就在后台从下载站装,和登录并行 —— ❌ 等(boot 不等它),❌ 弹任何东西;没装完的下次启动接着装(first-run-apps.ts)。
  firstRun.start()
  // 市场 App 自动更新(owner 10-19,照 VS Code):起来就去下载站取一次目录,之后每次取回来变了都更新一遍(auto-update-apps.ts)。
  autoUpdateAtBoot(browserFeatures)

  // 这里不做遥测初始化:原有的 PostHog 埋点(56 个事件)2026-09-10 整套拆除 ——
  // owner:「他是个美国人的服务吗?感觉我很多软件用户是国内的,这种数据外流可能不安全」。
  // 那条管子默认是开的,只差构建时传一个 key 就会往美国发;所以是拆,不是藏开关。

  // #26 订阅连接的开机对齐:趁还没有任何会话、自动化也还没起,把默认账号的凭据放到会话要读的地方(见 harness-connections)。
  try {
    const { alignHarnessConnectionsAtStartup } = await import('@main/core/agents/harness-connections')
    await alignHarnessConnectionsAtStartup()
  } catch (e: unknown) {
    log.warn('harness connections: startup alignment failed; sessions keep the credentials already in place', { error: e })
  }

  // --- Eager service .initialize()/.start() block (index.ts:146-156). ---
  projectSettingsService.initialize()
  prSyncScheduler.initialize()
  stopActivityCollector = installActivityCollector()
  automationsService.start()
  appService.initialize()
  await appSettingsService.initialize()
  // 「终端」开关还没定值(升级上来的第一次启动)就按老用户迁移规则算一次写回,渲染层与新会话都读这一份。
  await settleTerminalEnabled().catch((e) => log.warn('terminal setting: migration failed; it stays off until set', { error: e }))
  if (browserFeatures) {
    browserWebContentsRegistry.setKeyboardSettings(await appSettingsService.get('keyboard'))
  }
  setBrowserCorsRelaxationSettings(await appSettingsService.get('browser'))
  await promptLibraryService.initialize()
  // 写入者先于任何事件来源就位:它订 hook 总线,births / 收残 / 回收都经它(spec agent-status-writer)。
  agentStatusWriter.initialize()
  installSessionsGoneFeed()
  onSessionsGone((scope) => agentStatusWriter.forget(scope))
  agentHookService.initialize().catch((e) => {
    log.error('Failed to start agent event service:', e)
  })

  // --- Wire surface #2: ACP + agent-config runtime workers (index.ts:159-165). ---
  initializeAcpRuntimeProcess().catch((e) => {
    log.error('Failed to start ACP runtime process:', e)
  })
  initializeAgentConfigRuntimeProcess().catch((e) => {
    log.error('Failed to start agent-config runtime process:', e)
  })
  acpAgentStatusBridge.initialize()
  installPlatformCheckpointFeed()
  // #6334 用量页的运行时长底账:同一条 'agent:status' 输出的第二个订阅者,外加每分钟一次与
  // agent_status 列的对账(补上不经过那条事件的状态写入:出生即 working、restart)。
  installRunIntervalRecorder({ agentStatus: agentStatusWriter, sessionEvents })
  // 附带(defer:推迟到对方下次进入运行中时再送):同一条输出的又一个订阅者 —— 会话进入运行中那一刻,把挂着的附带按普通发送投出去。
  installDeferredMessageDelivery(agentStatusWriter)
  // spec idle-reclaim:同一条输出的第三个订阅者 —— 空闲满 10 分钟、不在屏上的会话停掉进程,任务放回重启后的样子。
  installIdleReclaim({ agentStatus: agentStatusWriter })
  // @@@4068 — same funnel, second consumer: tell extension surfaces that an agent moved.
  // Subscribed here rather than inside the bridge because a static import of agentHookService
  // there would drag the conversation/DB stack into the bridge's module graph — the reason
  // `listAgents` imports its reader lazily. Must run AFTER the same two initializers above.
  if (browserFeatures) installExtensionAgentChangeFeed()
  // 手机端「跨页提醒」与会话列表的实时状态,读的是同一条 tap ——
  // ❌ 不再自造第二份「事件 → 状态」的推导(#3961 的教训:同形拷贝各改各的,
  // 于是有一份永远是旧的)。注入而不是 import:session-timeline 那条链被本模块 import,
  // 反向直接引会成环。必须在上面两个初始化之后,否则订到的是一条还没活的频道。
  // ⚠️ 不跟着 browserFeatures 走:那道开关管的是浏览器 tab 扩展面,
  // 而手机看管页的状态与它无关 —— 挂上去等于「没开扩展就看不到 agent 在跑」。
  setSessionStatusFeed(onAgentStatus)
  // 跑在非原生订阅连接上的 Claude 会话,记录在连接自己的配置根里:交给时间线服务去那里找(同样是注入,免得成环)。
  setConnectionConfigRootResolver(connectionConfigRoot)
  // 手机端往一条**已经不活**的 ACP 会话里回话时,先按桌面端同一条「唤醒」把引擎拉起来。
  // 同样是注入(write-bridge 被本模块经 session-timeline 引着,反向 import 成环)。
  setSessionWake(ensureEmdashSession)
  // 手机端的「停止」= 桌面端删忙 agent 用的同一条取消口(ACP cancel / 终端腿中断键),❌ 不另写一份。
  setSessionCancel(cancelEmdashTurn)

  // 这里原先是旧账号体系的会话恢复 + 「OAuth 拿到的 GitHub token 落库」那条登记。
  // 整条链只有那套账号自己的登录服务能触发,咕咕里进不去 —— 2026-09-10 连同子系统一起拆。
  // 咕咕现在接 GitHub 只有两条路:gh CLI 导入、设备码流程,都不经过这里。
  // ⚠️ 库里可能存着 credentialSource='emdash_oauth' 的老账号行,**读的那一侧照旧认它**。
  //
  // 拆子系统要把它留下的东西一起收干净:那套账号把会话令牌加密存在 app_secrets 的
  // `emdash-account-token` 下。代码没了,那一行还在 —— 一份谁也不会再用、也没人会去清的凭据。
  // 一条按主键的 DELETE,没有就是空操作。
  void encryptedAppSecretsStore.deleteSecret('emdash-account-token').catch((e: unknown) => {
    log.warn('failed to drop the retired account token', e)
  })

  // --- Surface #1: the RPC router registration (index.ts:183). ---
  registerRPCRouter(rpcRouter, app.isPackaged ? ipcMain : withRpcLogging(ipcMain))

  // --- Post-registration reconcilers (index.ts:185-215). Fire-and-forget. ---
  void reconcileResourceSampler()
  const discover = () => ensureAgentDependenciesProbed(localDependencyManager)
  const discovery = options.scheduleDiscovery ? options.scheduleDiscovery(discover) : discover()
  discovery.catch((e: unknown) => {
    log.error('Failed to probe dependencies:', e)
  })
  // @@@3130 GitHub 账号对账**不在这里跑**。它三步里任何一步碰到已有数据都会写加密存储 →
  // safeStorage → macOS 钥匙串,而开机时用户可能连登录都还没做,系统会弹窗要开机密码(全新
  // profile 上那把钥匙其实没有任何东西要解)。改由 githubController.getAccountState 惰性触发
  // 且只跑一次 —— renderer 的 GithubContext 在 mount 时就查这个 RPC,功能没有损失。
  // ❌ 别把 reconcile 挪回开机。

}

let stopActivityCollector: (() => void) | null = null

/**
 * Tears down the runtime worker processes the module spawned. The host folds this into its own
 * `before-quit` rather than letting the session backend register its own preventDefault quit handler.
 */
let disposeEmdashModulePromise: Promise<void> | null = null

async function disposeEmdashModuleOnce(): Promise<void> {
  const failures: unknown[] = []
  const runPhase = async (phase: string, action: () => void | Promise<void>): Promise<void> => {
    const startedAt = performance.now()
    log.info(`[shutdown] phase=session-main.${phase} state=started elapsedMs=0`)
    try {
      await action()
      log.info(`[shutdown] phase=session-main.${phase} state=completed elapsedMs=${Math.round(performance.now() - startedAt)}`)
    } catch (error) {
      log.error(`[shutdown] phase=session-main.${phase} state=failed elapsedMs=${Math.round(performance.now() - startedAt)} error=${JSON.stringify(String((error as Error)?.message ?? error))}`, error)
      failures.push(error)
    }
  }

  // @@@5080 先撤掉数据目录的占用宣告:留着它,下一个宿主会看到一个 pid 已死的锁 —— 那种锁不会
  // 误判占用(判据查的是 pid 存活,不是文件在不在),但把自己的东西收干净还是更干净。
  await runPhase('data-dir-release', () => releaseDataDir(app.getPath('userData')))
  await runPhase('automations', () => automationsService.stop())
  await runPhase('extension-programs', stopAllExtensionPrograms)
  await runPhase('agent-hooks', () => agentHookService.dispose())
  await runPhase('agent-status', () => agentStatusWriter.dispose())
  await runPhase('resource-sampler', stopResourceSampler)
  await runPhase('pr-sync', () => prSyncScheduler.dispose())
  await runPhase('acp-agent-status', () => acpAgentStatusBridge.dispose())
  await runPhase('project-release', () => projectManager.release())
  await runPhase('project-dispose', () => projectManager.dispose())
  await runPhase('runtime-manager', () => runtimeManager.dispose())
  await runPhase('acp-runtime', disposeAcpRuntimeProcess)
  await runPhase('agent-config-runtime', disposeAgentConfigRuntimeProcess)
  await runPhase('module-scope', () => appScope.dispose())
  await runPhase('local-pty', disposeLocalPtySessions)
  await runPhase('activity', () => { stopActivityCollector?.(); stopActivityCollector = null })
  await runPhase('database', closeDatabase)
  await runPhase('logging', flushLogWrites)
  await flushLogWrites()

  if (failures.length === 1) throw failures[0]
  if (failures.length > 1) throw new AggregateError(failures, 'session main cleanup failed')
}

export function disposeEmdashModule(): Promise<void> {
  // 后台是进程级常驻的,不挂在任何窗口下 —— 拆模块时不收,它就活过了整个会话页。
  stopAllExtensionBackgrounds()
  return (disposeEmdashModulePromise ??= disposeEmdashModuleOnce())
}

// @@@sessionpage TASKPAGE-FUSION — module-boundary CONTROL-CHANNEL entries (owner #43: the host reaches
// the session backend ONLY through exported entries, never a deep-import of the ACP runtime internals).
// The gugu host uses these to make one session-page codex session message another: a gugu `agent.deliver`
// for a session-page agent is fulfilled by injecting a new ACP turn into that agent's live session-page
// conversation — NOT by pty writes. FAIL-LOUD: if the conversation is not a live session-page session, `sendPrompt` returns an error and
// we THROW (surfaced by gugu's onAgentDeliverFailure). A busy-but-live session returning {queued:true}
// is not inbox admission; detached callers surface it as an error instead of marking delivery complete.

/**
 * Inject a user turn into a live session-page ACP conversation over its control channel. Mirrors the
 * `getAcpRuntimeClient().sendPrompt(...)` call sessionCreate.ts uses; throws (fail-loud) when the target is
 * not a live session so the delivery never silently degrades to a pty write or a durable requeue.
 */
/**
 * @@@2374 — `gugu_session` app_* 的动作分派。宿主(main.ts)只会把它当成一个不透明的
 * 函数递给 MCP 层:扩展目录与其服务住在会话页这一侧,宿主不该为了装一个工具去
 * 深引会话页的模块图。
 */
/** D-31 Who asks an install, for its sheet: the agent of that session, by its name here and its id (its face). */
async function requesterOf(sessionId: string): Promise<{ name: string; agentUserId: string | null }> {
  const agent = await localAgentForSession(sessionId, process.env).catch(() => null)
  return { name: agent?.name ?? 'Agent', agentUserId: agent?.gugu_user_id ?? null }
}

export async function runEmdashExtensionAction(
  action: unknown,
  caller: { sessionId?: string; workspaceRoot?: () => Promise<string | null>; hasApp?: (extensionId: string) => Promise<boolean>; signal?: AbortSignal } = {},
): Promise<unknown> {
  const sessionId = caller.sessionId
  return runExtensionAgentAction(action, {
    // D-31: an agent's install is asked as an approval in its session — wherever the person follows it — and here too.
    requestInstallConsent: sessionId
      ? async (request) => askInstallInSession(sessionId, request, await requesterOf(sessionId), undefined, caller.signal)
      : requestExtensionInstallConsent,
    headless: HEADLESS_SERVER,
    // A Gugu server has no window to tell of an install (161 10-15: it installs Apps too): nothing to wait on there.
    ...(HEADLESS_SERVER ? { notifyInstalledChanged: async () => undefined } : {}),
    // 摩擦单 F5: the App run as a hidden page with the context a real open gives it, read back, closed.
    checkSurface: checkExtensionSurface,
    appSourcesRoot,
    ...(caller.workspaceRoot ? { callerWorkspaceRoot: caller.workspaceRoot } : {}),
    ...(caller.sessionId ? { callerSessionId: caller.sessionId } : {}),
    // The same id `getContext().session.agentId` names that session's agent by.
    ...(sessionId ? { callerAgent: async () => (await agentIdsBySession(process.env)).get(sessionId) ?? null } : {}),
    ...(caller.hasApp ? { callerHasApp: caller.hasApp } : {}),
  })
}

/**
 * #6387 每个已装扩展带来的 MCP 程序与 skill 目录,不论它此刻能不能给 agent 用 —— 能不能只由
 * `extensionPrograms.agentToolsRefusal` 判:会话开场只取被允许的(#6615),catalog 要看得见被停用 / 撤权的才说得出原因。
 */
export function emdashExtensionAgentContributions(): {
  extensionId: string
  name: string
  description?: string
  agentInstructions?: string
  /** The manifest as installed: what an agent's app_search filters and shows (app-search.ts). */
  manifest: ExtensionManifest
  /** Switched on in 「App」: an agent's app_search says a switched-off one is there, and who switches it on. */
  enabled: boolean
  rootDir: string
  dataDir: string
  digest: string
  settings: Record<string, string | boolean>
  settingsInvalid?: true
  disclosure: 'full' | 'progressive'
  servers: ExtensionMcpServerContribution[]
  skillsDir: string | null
}[] {
  const service = extensionsService()
  return service
    .list()
    .extensions.map(({ manifest, rootDir: installedDir }) => {
      // 程序从这一版的副本起、技能从这里读:装、升、卸都是 rename 安装目录,程序 ❌ 能以它为 cwd(Windows 上 EBUSY)。
      // 不能给 agent 用的扩展既不起程序也不给技能,不冻结副本。副本与程序的版本都按包的内容认:同一版本号重装了
      // 新代码,就是新副本、新程序(10-06)。
      const bundleDigest = bundleContentDigest(installedDir)
      let settings: Record<string, string | boolean> = {}
      let settingsInvalid: true | undefined
      try { settings = service.settings(manifest.id) }
      catch (error) {
        settingsInvalid = true
        log.warn('App configuration is invalid; its programs are left out', { extensionId: manifest.id, error })
      }
      const rootDir = extensionPrograms.agentToolsRefusal(manifest.id)
        ? installedDir
        : ensureSessionSnapshot(installedDir, sessionSnapshotDir(app.getPath('userData'), manifest.id, bundleDigest))
      return {
      extensionId: manifest.id,
      name: manifest.name,
      ...(manifest.description ? { description: manifest.description } : {}),
      ...(manifest.contributes.agentInstructions ? { agentInstructions: manifest.contributes.agentInstructions } : {}),
      manifest,
      enabled: service.isEnabled(manifest.id),
      rootDir,
      dataDir: extensionDataRoot(manifest.id),
      digest: createHash('sha256').update(bundleDigest).update(JSON.stringify(settings)).digest('hex'),
      settings,
      ...(settingsInvalid ? { settingsInvalid } : {}),
      disclosure: service.disclosure(manifest.id),
      servers: (manifest.contributes.mcpServers ?? []).map((server) => ({ ...server })),
      skillsDir: manifest.contributes.skills ? path.join(rootDir, manifest.contributes.skills) : null,
      }
    })
}

/** #6615 The programs the extension gateway calls: run by gugu, shared by every session. */
export function emdashExtensionPrograms(): ExtensionPrograms {
  return extensionPrograms
}

/**
 * D-30 「给哪些 agent」 for an App installed here, read live (an App installed mid-session is asked about too): the places on
 * this computer the person gave it at (null: never chose, so every agent), and its identity, which the chats' rows name it by
 * (null without one: it reaches agents only through this computer's places).
 */
export function emdashAppGiven(extensionId: string): { app: string | null; here: string[] | null } {
  const service = extensionsService()
  const identity = service.identityOf(extensionId)
  return { app: identity ? appKey(identity) : null, here: identity ? service.givenHere(identity) : null }
}

/** F14 (L7-b) Whether app_check can run here: its hidden page needs a window, and a Gugu server has none. */
export function emdashExtensionCheckAvailable(): boolean {
  return !HEADLESS_SERVER
}

/** The picture guide apps-ui shows: this build's look, drawn in a hidden page (only where app_check can run). */
export function emdashLookPicture(): Promise<ExtensionPicture> {
  return lookGalleryPicture()
}

/** #6387 Frozen copies only last run's sessions could still have used, and what belongs to no installed App. */
function sweepExtensionSessionLeftovers(): void {
  const { extensions, invalid } = extensionsService().list()
  const userData = app.getPath('userData')
  pruneExtensionData(
    path.join(userData, EXTENSION_DATA_DIR_NAME),
    new Set([...extensions.map(({ manifest }) => manifest.id), ...invalid.map(({ dirName }) => dirName)])
  )
  pruneSessionSnapshots(userData, new Map(extensions.map(({ manifest, rootDir }) => [manifest.id, bundleContentDigest(rootDir)])))
}

/**
 * #6387 系统交给咕咕的一条链接(gugu://ext/<扩展>/<tab>/…)。不是扩展链接的原样说「不是」,
 * 宿主据此不理它;失败带原因回去,由宿主按用户语言告诉人 —— 人点了链接正在等。
 */
export async function openEmdashLink(url: string): Promise<LinkOpenOutcome> {
  return await openLink(url)
}

/** #4320 —— 唤醒超过它就把分段整份 warn 出来(沿用 #4181 报 still-running 的 30s 节拍)。 */
const SESSION_WAKE_BUDGET_MS = 30_000

/**
 * @@@4526B 取消这条会话当前在飞的回合。宿主 ACP 通道那一侧的取消口 —— 与 `injectEmdashPromptDetached`
 * 走同一个 runtime client,只是方向相反。owner 删除一个正忙的 agent 时由删除序调用:
 * ❌ 不有界等待它跑完(那条等待服务的是"会话还要继续存在"的释放,见 spec delivery-routing),
 * 失败照常抛 —— 没停下来却回报已删除,正是这条缺陷本身。
 */
export async function cancelEmdashTurn(sessionId: string): Promise<boolean> {
  const session = (await getSessions()).find((candidate) => candidate.id === sessionId)
  if (!session) return false
  if (session.runtime === 'acp') {
    const client = await getAcpRuntimeClient()
    const result = await client.cancelTurn({ sessionId })
    if (!result.success) {
      throw new Error(`session-page cancel turn failed for ${sessionId}: ${result.error.type}`)
    }
    return true
  }
  // 原生 TUI 腿:按这一家在 descriptor 里声明的中断键写进 pty。键位语义归 provider 声明,
  // `ptyController.interrupt` 只按拍子写字节 —— ❌ 它明确拒绝回落 Ctrl-C(对不少家那是退进程,
  // 「暂停」会变成「杀掉」)。没声明键位的家在这里 fail loud:停不下来就要说出来。
  // 写完键位由宿主自己把这一轮收成空闲(被打断不发 hook 的家,见 `interruptTuiTurn`)。
  return interruptTuiTurn(session)
}

/**
 * Reopen an existing conversation for a mapped local delivery debt, preserving its runtime.
 *
 * #4320 —— 这就是「唤醒」。发信方的 `tools/call` 目前一路 await 到这里(delivery-bridge 的 deliver →
 * ensureSessionForAgent → 这里 → ACP startSession → provider 进程冷启动),而这一整段过去零日志。
 * 分段账本让「唤醒慢在挂载工作区还是慢在起引擎」当场可读;超预算时一行 warn 带走完整分段,
 * 默认日志级别下也落盘。
 */
export async function ensureEmdashSession(sessionId: string): Promise<void> {
  const ledger = createStageLedger({
    scope: 'sessionpage/session-wake',
    what: 'session-page session wake',
    fields: { sessionId },
    budgetMs: SESSION_WAKE_BUDGET_MS,
  })
  try {
    await wakeEmdashSessionStages(sessionId, ledger)
  } catch (error) {
    // 失败也要留下分段:「唤醒挂在挂载工作区那一步」与「唤醒压根没开始」是两种不同的事故。
    ledger.settle({ outcome: 'failed' })
    throw error
  }
}

async function wakeEmdashSessionStages(sessionId: string, ledger: StageLedger): Promise<void> {
  const session = (await getSessions()).find((candidate) => candidate.id === sessionId)
  if (!session) throw new Error(`session ${sessionId} was not found`)
  ledger.mark('session-resolved')
  if (session.runtime !== 'acp') {
    if (session.providerSessionState === 'missing') {
      throw new Error(`session ${sessionId} provider session is missing; cannot resume`)
    }
    await sessionService.ensureSessionMounted(sessionId)
    ledger.mark('session-mounted')
    // Use the same resume operation as reopening this conversation in the UI. It preserves the
    // provider session and the supervisor prevents a second spawn if it is already starting/live.
    await hydrateSession(session.projectId, sessionId)
    const resumed = (await getSessions()).find((candidate) => candidate.id === sessionId)
    if (!resumed || resumed.providerSessionState === 'missing') {
      throw new Error(`session ${sessionId} could not resume its provider session`)
    }
    ledger.mark('tui-start-returned')
    ledger.settle({ outcome: 'reopened' })
    return
  }
  // 「ACP 会话活没活」只认 acpSessionLive(`starting` 也算活:再起一次只会撞上正在起的那个)。
  if (await acpSessionLive(sessionId)) {
    ledger.mark('already-live')
    ledger.settle({ outcome: 'already-live' })
    return
  }
  ledger.mark('summary-read')
  if (!session.workspaceId) throw new Error(`session ${sessionId} workspace is not ready`)
  const mounted = await sessionService.ensureSessionMounted(sessionId)
  ledger.mark('session-mounted')
  const workspace = resolveWorkspace(session.projectId, mounted.workspaceId)
  if (!workspace) throw new Error(`session ${sessionId} workspace is not mounted`)
  const result = await (await getAcpRuntimeClient()).startSession({
    input: acpStartInputFor(session, mounted.workspaceId, workspace.path),
  })
  ledger.mark('acp-start-returned', { success: result.success })
  ledger.settle({ outcome: result.success ? 'reopened' : 'failed' })
  if (!result.success) throw new Error(`session ${sessionId} failed to reopen: ${JSON.stringify(result)}`)
}

/**
 * 一条 ACP 会话的启动入参 —— 唤醒与**重载**共用同一份。
 *
 * 抽出来不是为了少写几行:两条路只要有一处字段不一致,重载就会悄悄换掉某个会话级事实
 * (权限档、推理档),而用户以为自己只是换了个模型。
 */
export function acpStartInputFor(
  // ⚠️ 用**会话记录的真类型**,❌ 不手写一个结构类型:手写那版把 `permissionMode` 的联合压成了
  // `string`,于是启动入参的四档权限被悄悄放宽 —— typecheck 当场红,而它红得对。
  session: Awaited<ReturnType<typeof getSessions>>[number],
  workspaceId: string,
  cwd: string,
) {
  return {
    sessionId: session.id,
    projectId: session.projectId,
    providerId: session.providerId,
    workspaceId,
    cwd,
    providerSessionId: session.providerSessionId ?? null,
    // 首轮的来路与会话页那份启动入参(acp-chat-store)同一组:不经会话页起的(launchCreatedSession)也要带上,
    // 否则注入器认不出这一轮该落成一条咕咕消息 / 任务卡(gugu-dev#181 建完不打开的派任务正是走这里)。
    ...(session.startupOrigin ? { startupOrigin: session.startupOrigin } : {}),
    ...(session.initialMessageId ? { initialMessageId: session.initialMessageId } : {}),
    ...(session.taskChatId ? { taskChatId: session.taskChatId } : {}),
    model: session.model ?? null,
    effort: session.effort ?? null,
    permissionMode: resolveSessionPermissionMode(session),
  }
}

/**
 * 重载后 harness 自己那条原生会话的去向,读的是重载**实际**拿回来的 session id,❌ 按意图推断。
 * `preserved` = 同一条原生会话接回来了(harness 自己的历史在);`replaced` = 按插件的
 * `sourceChangeSession=replace` 起了一条新的原生会话(咕咕这边的对话记录仍在,harness 自己的上下文从零开始)。
 * `not-started` = 这条会话从没起来过(#7092):只把新选择落进了记录,没停也没起 —— 调用方按正常首启起它。
 */
export type ReloadNativeSession = 'preserved' | 'replaced' | 'not-started'

/**
 * 重载一条活着的 ACP 会话 —— **换掉会话级注入,但保住这条会话的历史**。
 *
 * ## 为什么需要它(不是「重启一下」的同义词)
 *
 * 三家 harness 在 spawn 之后都**学不到新的端点/凭据/模型清单**(本机实测:claude 一个进程一个
 * `ANTHROPIC_BASE_URL`;codex 的 `thread/resume` 带 `modelProvider` 会被接受但不生效;opencode
 * 只认 spawn 时那份配置文档里已声明的 provider)。所以凡是改了**会话级注入**的操作 —— 换咕咕网关的
 * 模型、切一个 MCP 开关(#5157)—— 都只能重开进程,再用同一个 provider 会话 id 续上。
 *
 * ## 它做的就是两件事,顺序不能反
 *
 * 1. `stopSession`:先停。凭据与配置文档是在 spawn 那一刻写进进程的,活着的进程换不了值。
 * 2. `startSession(sessionId=…)`:注入**在这一步的 spawn 钩子里自动重算**(`platformModelForSession`
 *    与整份 capability bundle 都挂在那条路上)⇒ 调用方**不传 diff**,只要先把新的选择落进会话记录,
 *    这里重跑一遍整份即可。这也是两条车道商定的语义:重算整份、幂等,❌ 不开「只改一格」的后门。
 *
 * ## ❌ 失败必须响亮
 *
 * runtime 的 `session/load` 失败不会回落到 `session/new`。恢复失败保留原 conversation、provider
 * session 引用和持久化 transcript，并以 `restart_failed` 停住；这条入口只返回成功的原会话恢复。
 *
 * 没有 provider 会话 id 的会话(从没起来过)没有历史可续、也没有进程可停:带着新模型 / 档位来的,只把选择落进记录
 * 并答 `not-started`,由调用方走正常首启(#7092:会员模型首启被拒,换个模型再起);其余(MCP 开关、手动重开)直接拒。
 */
export async function reloadEmdashSession(input: {
  sessionId: string
  /** 为什么重载(换模型 / 改 MCP 开关 …)。进日志,也是 UI 上那句「正在重连」的由来。 */
  reason: string
  /**
   * 这次要换成的模型 —— **由宿主自己落进会话记录**,而不是让调用方先写一遍再来叫重开。
   *
   * ⚠️ 这一条是被真机打回来的(owner 2026-09-07 实测「Failed to change model」):
   * 渲染层原本先调 `store.setModel()` 再请求重开,而那是**活 ACP 会话**的 `set_config_option` ——
   * 换不成正是重开的**前提**(新模型不在适配器已 advertise 的清单里),所以它必然失败、
   * 当场弹「Failed to change model」,而且新模型根本没被持久化 ⇒ 重开之后跑的还是旧模型。
   * 一次点击里两个失败:一个响亮但误导,一个静默且致命。
   *
   * ⇒ 顺序由宿主保证:**先写记录、再停、再起**。写不进去就当场抛,❌ 不带着旧模型重开 ——
   * 那会让用户看到「重开成功」而模型没变,比报错更坏。
   */
  model?: string | null
  /**
   * 新模型走**哪条计费路** —— `platform` = 咕咕代付,`own` = 用户自己的凭据。**给了 `model` 就必须给它**。
   *
   * ⚠️ 这不是冗余信息:spawn 侧读的是每会话那份 `sessionpage-platform-model` 记录
   * (`sessionPlatformModel`),**不是** `config.model`。只改 `config.model` 就重开,
   * 会带着**旧的**那条计费路重来:
   * · 换到自己的模型 ⇒ 进程仍连咕咕的端点、带咕咕的票,下一轮 403;
   * · 换到咕咕的模型 ⇒ 一个平台变量都不注入,拿用户自己的 key 去调一个他没有的模型。
   * 只有 platform→platform 那一种碰巧还成立,而那正是「看起来能用」最危险的形状。
   *
   * ⇒ 它就是 composer 建会话时做的同一个决定,只是这次发生在会话中途。
   * ❌ 宿主不猜:这一侧没有目录,猜出来的与用户点的会漂。缺了就抛。
   */
  modelSource?: 'platform' | 'own'
  /**
   * 这条会话**关掉**了哪几台 MCP server(#5157)。宿主写进会话记录,再重开 —— 与 `model` 同一条纪律:
   * 顺序只有宿主保证得了,渲染层先写一遍的话,两次往返之间被打断就会留下「记录改了但没重开」
   * 或反过来,两种都是「用户看到的与实际跑的不一致」且不报错。
   *
   * ⚠️ 记的是**关掉的**那几台,❌ 不是启用集合(0df72f96 定):记启用集合的话,用户之后在自己配置里
   * 新加一台 server 就**默认变成关的** —— 一个他从没做过的决定。记「关掉的」天然满足
   * 「没碰过的都开着」。
   *
   * ⚠️ **空数组不等于缺席,❌ 不许归一**:`[]` = 用户显式决定过、一台都没关;
   * `undefined` = 从没碰过。宿主仍按在场性保存用户的决定，adapter 进程归属则始终按 conversation id 固定。
   */
  mcpDisabledServers?: readonly string[]
  /**
   * #5276 把这条会话的模型选择**清掉**（回到 harness 自家默认 + 用户自己的凭据）后重开。
   * 与 `model` 互斥：给了 `model` 就是「换成它」，`resetModel` 是「不再指定」。
   * 两半一起清：`config.model` 删键、`sessionpage-platform-model` 记录删掉（❌ 不写 null 冒充「用户选过自己的模型」）。
   */
  resetModel?: boolean
  /**
   * 思考档位,三态:字符串 = 换成这一档;`null` = 删键、回 harness 默认;缺席 = 不碰。
   * 只收终端会话 —— 终端的档位在 spawn 那一刻进 argv(claude `--effort`、codex
   * `model_reasoning_effort`),活进程改不了;通用模式在活会话里当场改,不走重开。
   */
  effort?: string | null
}): Promise<{ warning?: string; nativeSession: ReloadNativeSession }> {
  const { sessionId, reason } = input
  if (input.resetModel && typeof input.model === 'string' && input.model.trim()) {
    throw new Error(`session ${sessionId} reload asked to both reset and set a model (${reason})`)
  }
  const session = (await getSessions()).find((candidate) => candidate.id === sessionId)
  if (!session) throw new Error(`session ${sessionId} was not found`)
  const providerSessionId = session.providerSessionId?.trim()
  // 只收模型 / 档位:MCP 开关仍按原样拒 —— 那一维有正在起的会话要跟上,只落记录会变成「记了没生效」。
  const carriesModelChoice = (typeof input.model === 'string' && !!input.model.trim())
    || !!input.resetModel
    || input.effort !== undefined
  if (!providerSessionId && carriesModelChoice && !Array.isArray(input.mcpDisabledServers)) {
    await recordUnstartedSessionChoice({
      sessionId,
      runtime: session.runtime === 'acp' ? 'acp' : 'pty',
      reason,
      model: input.model,
      modelSource: input.modelSource,
      resetModel: input.resetModel,
      effort: input.effort,
    })
    return { nativeSession: 'not-started' }
  }
  if (!providerSessionId) {
    throw new Error(
      `session ${sessionId} has no provider session to resume; `
      + 'start it normally instead of reloading',
    )
  }
  if (!session.workspaceId) throw new Error(`session ${sessionId} workspace is not ready`)
  const mounted = await sessionService.ensureSessionMounted(sessionId)
  const workspace = resolveWorkspace(session.projectId, mounted.workspaceId)
  if (!workspace) throw new Error(`session ${sessionId} workspace is not mounted`)
  const reloadSurface = session.runtime === 'acp' ? 'acp' : 'tui'
  const sourceChangeSession = getPlugin(session.providerId).capabilities.sessionBundle
    .credentialLifecycle?.[reloadSurface]?.sourceChangeSession ?? 'preserve'

  // Both session-page legs use this host-owned stop/start boundary. PTY has no ACP store to
  // reattach, so the renderer reconnects its existing terminal resource after this returns.
  // Keep the runtime recorded on the conversation; changing it here would silently turn a
  // credential repair into a view switch.
  if (session.runtime !== 'acp') {
    if (Array.isArray(input.mcpDisabledServers)) {
      throw new Error(`session ${sessionId} PTY reload does not accept MCP changes`)
    }
    const nextModel = typeof input.model === 'string' && input.model.trim() ? input.model.trim() : null
    if (nextModel && input.modelSource !== 'platform' && input.modelSource !== 'own') {
      throw new Error(
        `session ${sessionId} asked to switch to ${nextModel} without saying which `
        + 'billing path it is on (modelSource)',
      )
    }
    const effortChanged = input.effort !== undefined
    const nextEffort = typeof input.effort === 'string' && input.effort.trim() ? input.effort.trim() : null
    let configBeforePatch: typeof sessions.$inferSelect.config | null = null
    const platformBefore = nextModel || input.resetModel ? await sessionPlatformModel(sessionId) : undefined
    const sourceChanged = crossesBillingSource(platformBefore, reloadTargetSource(nextModel, input))
    const replaceProviderSession = sourceChanged && sourceChangeSession === 'replace'
    let platformWritten = false
    if (input.resetModel) {
      // 与 ACP 腿同一个决定:两半一起清。
      configBeforePatch = await dropRecordedModel(sessionId, reason)
      await forgetSessionPlatformModel(sessionId)
      platformWritten = true
    } else if (nextModel || effortChanged) {
      const rows = await db.select({ config: sessions.config })
        .from(sessions).where(eq(sessions.id, sessionId))
      const current = rows[0]?.config
      if (!current || typeof current !== 'object') {
        throw new Error(`session ${sessionId} has no config to update (${reason})`)
      }
      configBeforePatch = current
      const nextConfig = { ...current }
      if (effortChanged) {
        if (nextEffort) nextConfig.effort = nextEffort
        else delete nextConfig.effort
      }
      if (!nextModel) {
        // 只换档位:模型与计费路都不动。
      } else if (input.modelSource === 'platform') {
        // Platform models are selected by the spawn-time capability bundle. Keeping the
        // provider-native id in config.model makes ACP call set_config_option on a live
        // session with `gugu-platform/<id>` and OpenCode rejects that as an unknown model.
        delete nextConfig.model
      } else {
        nextConfig.model = nextModel
      }
      await db.update(sessions)
        .set({ config: nextConfig })
        .where(eq(sessions.id, sessionId))
      if (nextModel) {
        await recordSessionPlatformModel(
          sessionId,
          input.modelSource === 'platform' ? { modelId: nextModel } : null,
        )
        platformWritten = true
      }
    }
    const sessionMount = resolveSession(session.projectId, sessionId)
    if (!sessionMount) throw new Error(`session ${sessionId} session runtime is not mounted`)
    try {
      await sessionMount.sessions.stopSession(sessionId)
      const fresh = (await getSessions()).find((candidate) => candidate.id === sessionId)
      if (!fresh) throw new Error(`session ${sessionId} vanished during reload (${reason})`)
      await sessionMount.sessions.startSession(
        replaceProviderSession ? { ...fresh, providerSessionId: undefined } : fresh,
        undefined,
        true,
      )
      const resumed = (await getSessions()).find((candidate) => candidate.id === sessionId)
      if (!resumed || (!replaceProviderSession && resumed.providerSessionId !== providerSessionId)) {
        if (resumed?.providerSessionId && resumed.providerSessionId !== providerSessionId) {
          await setProviderSessionId(sessionId, providerSessionId)
        }
        throw new Error(
          `provider resume returned a different session (${resumed?.providerSessionId ?? 'none'}; expected ${providerSessionId})`,
        )
      }
      const currentRows = await db.select({ config: sessions.config })
        .from(sessions).where(eq(sessions.id, sessionId))
      const currentConfig = currentRows[0]?.config
      if (currentConfig && typeof currentConfig === 'object') {
        const { pendingRestart: _pendingRestart, providerSessionState: _providerSessionState, ...cleanConfig } = currentConfig
        await db.update(sessions).set({ config: cleanConfig }).where(eq(sessions.id, sessionId))
      }
      return { nativeSession: resumed.providerSessionId === providerSessionId ? 'preserved' : 'replaced' }
    } catch (error) {
      if (configBeforePatch) {
        const message = error instanceof Error ? error.message : String(error)
        await db.update(sessions).set({
          config: {
            ...configBeforePatch,
            providerSessionState: 'restart_failed',
            pendingRestart: {
              status: 'restart_failed',
              dimension: nextModel ? 'model' : 'effort',
              ...(nextModel ? { targetModel: nextModel } : {}),
              ...(input.modelSource ? { targetModelSource: input.modelSource } : {}),
              error: message,
            },
          },
        }).where(eq(sessions.id, sessionId))
      }
      if (platformWritten) {
        if (platformBefore === undefined) await forgetSessionPlatformModel(sessionId)
        else await recordSessionPlatformModel(sessionId, platformBefore)
      }
      throw new Error(
        `session ${sessionId} failed to reload (${reason}); `
        + '历史未丢失，当前仍未应用新设置: '
        + `${error instanceof Error ? error.message : String(error)}`,
      )
    }
  }

  if (input.effort !== undefined) {
    throw new Error(
      `session ${sessionId} ACP reload does not take an effort change; `
      + 'set it on the live session instead',
    )
  }
  // ① 先把新选择落进会话记录 —— 重开时宿主按记录重算整份注入,记录没变就等于白重开。
  //    ❌ 不由渲染层代劳:那条路要么走活 ACP(必然失败,见 `model` 字段的注释),要么多一次
  //    可能与重开之间被打断的往返。
  const configPatch: Record<string, unknown> = {}
  const nextModel = typeof input.model === 'string' && input.model.trim() ? input.model.trim() : null
  if (nextModel) {
    if (input.modelSource !== 'platform' && input.modelSource !== 'own') {
      throw new Error(
        `session ${sessionId} asked to switch to ${nextModel} without saying which `
        + 'billing path it is on (modelSource). 只改模型不改计费路,重开出来的进程会连着旧的端点与票。',
      )
    }
    if (input.modelSource === 'own') configPatch.model = nextModel
  }
  if (Array.isArray(input.mcpDisabledServers)) {
    // 参数**在场**就是「这条会话被显式决定过」——`[]` 也算,所以判的是 `Array.isArray` 而不是长度。
    configPatch.mcpDisabledServers = [...input.mcpDisabledServers]
    configPatch.mcpToggleDecided = true
  }
  /**
   * 写之前那一份 —— 起不来时原样写回去,见下面 `restoreConfig`。
   * ⚠️ 类型取自列本身:摊平成 `Record<string, unknown>` 写不回去(TS2322),
   *    而那正说明摊平之后我们已经不知道自己在写什么了。
   */
  let configBeforePatch: typeof sessions.$inferSelect.config | null = null
  const providerSessionIdBeforeReload = session.providerSessionId
  if (Object.keys(configPatch).length > 0 || (nextModel && input.modelSource === 'platform')) {
    // ⚠️ 模型**不是 conversations 的列**,它住在 `config` 那份 JSON 里(见 build-session-row:121)。
    //    ⇒ 读-改-写,而且只动 `model` 一个键:整份覆盖会把 permissionMode /
    //    firstUtterance 这些同住一份 JSON 的事实一起抹掉,而症状要等下一次重开才显形。
    const rows = await db.select({ config: sessions.config })
      .from(sessions).where(eq(sessions.id, sessionId))
    const current = rows[0]?.config
    if (!current || typeof current !== 'object') {
      throw new Error(`session ${sessionId} has no config to update (${reason})`)
    }
    configBeforePatch = current
    const nextConfig = { ...current, ...configPatch }
    if (nextModel && input.modelSource === 'platform') {
      // `config.model` is the harness-native half of the record; the platform model lives only in
      // the per-conversation platform KV below. The host hands that KV to the runtime as
      // `platformModel`, and the runtime asserts it on the resumed session in the provider's own
      // addressing (#6196) — a platform id left here would be sent un-addressed as a native id.
      delete nextConfig.model
    }
    await db.update(sessions)
      .set({ config: nextConfig })
      .where(eq(sessions.id, sessionId))
  } else if (input.resetModel) {
    configBeforePatch = await dropRecordedModel(sessionId, reason)
  }

  /**
   * 计费路那份记录 —— 与 `config.model` **同一次决定的两半**,所以一起写、一起回滚。
   *
   * ⚠️ 它住在另一个 KV(`sessionpage-platform-model`),而 spawn 读的是它。两半不同步的后果不是
   * 「配置不整齐」,是**跑错端点**:见 `modelSource` 字段的注释。
   */
  const platformBefore = nextModel || input.resetModel ? await sessionPlatformModel(sessionId) : undefined
  // 原生会话续接还是换新,由 descriptor 的 `sourceChangeSession` 按腿回答。
  const sourceChanged = crossesBillingSource(platformBefore, reloadTargetSource(nextModel, input))
  let platformWritten = false
  if (nextModel) {
    await recordSessionPlatformModel(
      sessionId,
      input.modelSource === 'platform' ? { modelId: nextModel } : null,
    )
    platformWritten = true
  } else if (input.resetModel) {
    await forgetSessionPlatformModel(sessionId)
    platformWritten = true
  }

  /**
   * 把记录写回重开之前那一份。
   *
   * ⚠️ 只在**起不来**时用。`写记录 → 停 → 起` 的代价是:起失败时记录里留着一个起不来的选择,
   * 于是这条会话之后每次启动都会撞同一堵墙 —— 用户看到的是一条**再也打不开的会话**,
   * 而他只是点了一下换模型。报错响亮 ≠ 可恢复:两件事都要有(mac1 2026-09-07 实撞,
   * 服务端半边还是旧版 ⇒ 适配器没拿到那个模型 ⇒ `set_config_failed`,会话卡死在 gpt-6-astra)。
   *
   * ❌ 不在「起来了但不是自己那条会话」「起来了但复用了同一个进程」那两支回滚:
   * 那两支里进程**已经带着新选择跑起来了**,把记录改回旧的只会让记录与实际再次不一致。
   */
  const restoreConfig = async (failure?: string): Promise<string> => {
    if (!configBeforePatch) return ''
    try {
      const restoredConfig = failure
        ? {
            ...configBeforePatch,
            providerSessionState: 'restart_failed' as const,
            pendingRestart: {
              status: 'restart_failed' as const,
              dimension: reason === 'mcp-toggle' ? 'mcp' as const : 'model' as const,
              ...(nextModel ? { targetModel: nextModel } : {}),
              ...(input.modelSource ? { targetModelSource: input.modelSource } : {}),
              error: failure,
            },
          }
        : configBeforePatch
      await db.update(sessions)
        .set({ config: restoredConfig })
        .where(eq(sessions.id, sessionId))
      // provider 会话 id 的回滚也经 `setSessionId` —— 它会广播(#5869)。
      // ⚠️ 这一步**不能省**:换计费路那一支上面已经 `clearSessionId` 过一次,渲染端此刻以为
      // 这条会话没有可续的 provider 会话;回滚只改库不说话的话,它就一直停在那句作废的话上。
      // 回滚失败由外层 catch 统一报(它本来就会把「回滚也失败了」单独说一句)。
      if (sourceChanged && providerSessionIdBeforeReload) {
        const restored = await setProviderSessionId(sessionId, providerSessionIdBeforeReload)
        if (!restored.success) throw new Error(`session id rollback failed: ${restored.error.type}`)
      }
      // 两半一起回滚。`undefined` = 这条会话本来就没有记录(存量会话),那就把记录删掉还原成
      // 「没有记录」,❌ 不要写一个 null 冒充「用户选过自己的模型」——那是另一个决定。
      if (platformWritten) {
        if (platformBefore === undefined) await forgetSessionPlatformModel(sessionId)
        else await recordSessionPlatformModel(sessionId, platformBefore)
      }
      return failure
        ? ' 重启未完成，历史未丢失，当前仍未应用新设置；可以重试或新建会话。'
        : ' 会话记录已回滚到重开前那一份 —— 下次启动会按重开前那个模型起。'
    } catch (error) {
      // 回滚也失败 = 两件事故,分开报,❌ 不要只报后一件盖掉前一件。
      return ' ⚠️ 而且回滚会话记录也失败了,这条会话会停在一个起不来的选择上:'
        + `${error instanceof Error ? error.message : String(error)}`
    }
  }

  const client = await getAcpRuntimeClient()
  // 停之前先记下这条会话此刻attach的适配器进程 —— 重载的真判据是**进程换没换**,见下面那段。
  const before = await client.adapterProvenance({ sessionId })
  const stopped = await client.stopSession({ sessionId })
  // 停不下来就别往下走:接着 start 会撞上一个还活着的适配器进程,而它手里是**旧**凭据 ——
  // 那正是「界面写着新模型、实际跑旧的」那类静默错。
  if (!stopped.success) {
    const message = `could not be stopped for reload (${reason}): ${JSON.stringify(stopped)}`
    throw new Error(
      `session ${sessionId} ${message}`
      + await restoreConfig(message),
    )
  }
  if (sourceChanged) {
    // Clear transient provider state before the source-change reload. The descriptor decides
    // whether the provider session id is retained or replaced by the new billing route.
    const currentConfig = configBeforePatch
      ? { ...configBeforePatch, ...configPatch }
      : null
    if (currentConfig) {
      const { providerSessionState: _cleared, ...configWithoutProviderState } = currentConfig
      if (input.resetModel || (nextModel && input.modelSource === 'platform')) delete configWithoutProviderState.model
      await db.update(sessions)
        .set({ config: configWithoutProviderState })
        .where(eq(sessions.id, sessionId))
      // ⚠️ provider 会话 id **单独经 `clearSessionId` 写**,不跟着上面那次 config 一起落
      // (#5869):这一格渲染进程手里也留着一份,而全仓只有 `set-session-id.ts` 那两个写口会把
      // 改动广播出去。跟着 config 一起裸写的话,记录里已经没有可续的会话,渲染端却还以为有 ——
      // 两边都不报错,只是下一次它会拿一个作废的 id 去续。
      // `preserve` 那一支本来就是把原值写回去,等于没改,所以只有「换掉」这一支要动。
      if (sourceChangeSession !== 'preserve' && providerSessionIdBeforeReload) {
        await clearProviderSessionId(sessionId, providerSessionIdBeforeReload)
      }
    }
  }
  // ⚠️ **重读**会话记录:上面那次写之后,函数开头读到的那份就是旧的了。
  //    拿旧的去 start = 带着旧模型重开,而界面会显示「重开成功」—— 白重开比报错更坏。
  const fresh = (await getSessions()).find((candidate) => candidate.id === sessionId)
  if (!fresh) {
    const message = `session vanished during reload (${reason})`
    throw new Error(
      `session ${sessionId} ${message}`
      + await restoreConfig(message),
    )
  }
  if (input.resetModel && fresh.model) {
    // #5276 清模型:写了删键却读回来还有 = 记录层没生效。响亮停,❌ 带着旧模型重开。
    const message = `did not drop its model (${reason}): record still says ${String(fresh.model)}`
    throw new Error(
      `session ${sessionId} ${message}`
      + await restoreConfig(message),
    )
  }
  const modelRecordMatches = input.modelSource === 'platform'
    ? !fresh.model
    : fresh.model === nextModel
  if (nextModel && !modelRecordMatches) {
    // 写进去了却读不回来 = 记录层没生效。响亮停,❌ 不带着旧模型重开。
    const message = `did not take the new model (${reason}): asked ${nextModel} via ${input.modelSource}, record still says ${String(fresh.model)}`
    throw new Error(
      `session ${sessionId} ${message}`
      + await restoreConfig(message),
    )
  }
  /**
   * ⚠️ **抛与「返回失败」都要回滚** —— 这两种起不来长得完全不一样,而我只挡了后一种。
   *
   * 2026-09-07 隔离栈阴性控实撞:把一个**没有渠道分组**的模型上架,重开时服务端在**铸令牌那一步**
   * 就拒了(「refusing to mint a session token that would land in a group with no channel」)——
   * 那是 `startSession` **抛异常**,不是返回 `{success:false}`。于是我的回滚整段被跳过,
   * 会话记录停在 `glm-4.5` 上 —— 正是这个回滚存在的理由本身。
   *
   * ⇒ 把「写完记录之后、确认新会话跑起来之前」整段包住:任何一条出口都先把记录放回去再抛。
   */
  let result: Awaited<ReturnType<typeof client.startSession>>
  try {
    result = await client.startSession({
      input: acpStartInputFor(fresh, mounted.workspaceId, workspace.path),
    })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    const restored = await restoreConfig(message)
    throw new Error(
      `session ${sessionId} failed to reload (${reason}): `
      + `${message}${restored}`,
    )
  }
  if (!result.success) {
    throw new Error(
      `session ${sessionId} failed to reload (${reason}): ${JSON.stringify(result)}`
      + await restoreConfig(JSON.stringify(result)),
    )
  }
  // A restart normally succeeds only when the provider returns the same session id that was loaded.
  // Providers that declare sourceChangeSession=replace intentionally start a new native session
  // when the billing route changes; the host transcript remains the durable history for that path.
  const expectedProviderSessionId = providerSessionId
  if (result.data.providerSessionId !== expectedProviderSessionId && !(sourceChanged && sourceChangeSession === 'replace')) {
    const message = `provider resume returned a different session (asked ${expectedProviderSessionId}, got ${result.data.providerSessionId})`
    throw new Error(
      `session ${sessionId} failed to reload (${reason}): ${message}`
      + await restoreConfig(message),
    )
  }
  /**
   * 进程真的换了吗 —— 这是重载**唯一**够格的判据。
   *
   * 每条 conversation 的 `makeAcpConnectionKey` 都含有会话 id，同工作区的兄弟会话不会共用
   * adapter。这里仍对**进程身份**取证，以便重载明确证明新进程已建立，而不是只依赖返回的 session id。
   * 拿不到 pid(平台不给)时不假装判过 —— 那种情况下这条判据不成立,交给上面那道 sessionId 判据。
   */
  const after = await client.adapterProvenance({ sessionId })
  if (
    before && after
    && before.pid !== null && after.pid !== null
    && before.pid === after.pid
  ) {
    if (before.connectionKey === after.connectionKey) {
      // 进程没换 = 新的会话级注入一个字节都没到达 ⇒ 记录里那个新选择**没有生效**,
      // 留着它只会让下一次启动带着一个从没跑过的配置。⇒ 与「起不来」同一处置:先放回去再抛。
      const message = `reload (${reason}) reused the SAME adapter process`
      const restored = await restoreConfig(message)
      throw new Error(
        `session ${sessionId} reload (${reason}) reused the SAME adapter process `
        + `(pid ${after.pid}, connection ${after.connectionKey}) —— 新的会话级注入一个字节都没到达。`
        + '这条会话与同工作区的另一条会话共用一个适配器进程,停掉自己那一份租约不会让进程重启。'
        + '请检查这条会话的 adapter ownership 后再重试。'
        + restored,
      )
    }
    throw new Error(
      `session ${sessionId} reload (${reason}) kept pid ${after.pid} across two `
      + `different connections (${before.connectionKey} → ${after.connectionKey}) —— 这不是正常的会话重载,`
      + '而是一个进程被两条连接同时认领,属于另一类事故,❌ 不要按「重载失败」重试。',
    )
  }
  const currentConfigRows = await db.select({ config: sessions.config })
    .from(sessions).where(eq(sessions.id, sessionId))
  const currentConfig = currentConfigRows[0]?.config
  if (currentConfig && typeof currentConfig === 'object') {
    const { pendingRestart: _pendingRestart, providerSessionState: _providerSessionState, ...cleanConfig } = currentConfig
    await db.update(sessions).set({ config: cleanConfig }).where(eq(sessions.id, sessionId))
  }
  if (input.resetModel) await recordReportedDefaultModel(sessionId, platformBefore ?? null)
  return { nativeSession: result.data.providerSessionId === expectedProviderSessionId ? 'preserved' : 'replaced' }
}

/**
 * 清掉会话记录里的 `config.model`,返回写之前那一份(起不来时回滚用)。
 * 删键，❌ 不写 `model: undefined`/`null`：spawn 侧按「有没有这个键」读，留一个空值会被当成「选过」。
 */
async function dropRecordedModel(
  sessionId: string,
  reason: string,
): Promise<typeof sessions.$inferSelect.config> {
  const rows = await db.select({ config: sessions.config })
    .from(sessions).where(eq(sessions.id, sessionId))
  const current = rows[0]?.config
  if (!current || typeof current !== 'object') {
    throw new Error(`session ${sessionId} has no config to reset (${reason})`)
  }
  const { model: _dropped, ...rest } = current as Record<string, unknown> & { model?: unknown }
  void _dropped
  await db.update(sessions)
    .set({ config: rest as typeof current })
    .where(eq(sessions.id, sessionId))
  return current
}

/**
 * 这次重开把会话放到哪条计费路上。清模型 = 回到自己那条路(harness 自家默认 + 用户自己的凭据),
 * 所以从平台清回「你自己的模型(默认)」与换成一个自己的模型一样,是一次换计费路(#6210)。
 */
function reloadTargetSource(
  nextModel: string | null,
  input: { modelSource?: 'platform' | 'own'; resetModel?: boolean },
): 'platform' | 'own' | null {
  if (nextModel) return input.modelSource ?? null
  return input.resetModel ? 'own' : null
}

/** `undefined` = 存量会话没有平台记录,说不出换没换路 —— 按没换处理(与改动前一致)。 */
function crossesBillingSource(
  platformBefore: SessionPlatformModel | null | undefined,
  target: 'platform' | 'own' | null,
): boolean {
  return target !== null && platformBefore !== undefined && (platformBefore !== null) !== (target === 'platform')
}

/**
 * 清回「你自己的模型(默认)」并重开之后,把会话**自报**的模型写进会话记录(#6210)。
 *
 * 默认 = harness 自己取的那个,咕咕不替它挑;它报出来了就是这条会话此刻的事实,记录跟上
 * (与热切同一个写者),下次启动按它断言。不报当前模型的 harness(copilot 走自定义 provider)
 * 没有可写的,记录保持「默认」—— 它的原生会话按 descriptor 已换新,没有平台模型的记忆。
 *
 * 报出来的仍是刚离开的那个平台模型 = 原生会话把平台模型带到了用户自己的凭据上 —— 响亮失败,
 * ❌ 不把它当成「自己的模型」写进记录。
 */
async function recordReportedDefaultModel(
  sessionId: string,
  platformBefore: SessionPlatformModel | null,
): Promise<void> {
  const reported = (await readSessionOptions(sessionId)).model?.selected ?? null
  if (!reported) return
  const left = platformBefore?.modelId
  // 只认平台寻址形式(`gugu-platform/<id>`):裸 id 相等说明不了什么 —— 用户自己的默认完全可能与平台同名
  // (两条不同的凭据路径,见 `runtimeOptionForPlatformModelId` 抬头)。
  if (left && reported !== left && platformModelIdFromRuntimeOption(reported, [left]) === left) {
    throw new Error(
      `session ${sessionId} was reset to its own default model, but the reopened `
      + `session still runs the platform model ${reported} on the user's own credentials`,
    )
  }
  await recordLiveModelSwitch({ sessionId, modelId: reported, source: 'own' })
}

/**
 * 热切下发给 harness 的那个值 —— 与 composer 的 `planModelSwitch.wireValue` 同一条规则、同一个函数:
 * 平台模型取活会话**自报清单**里的寻址形式(pi / opencode 是 `gugu-platform/<id>`,递裸 id 会被当未知模型拒,#6182 review),
 * 报不出就交规范 id,让 provider 的原始拒绝显形;自己的模型清单里那条就是下发值。
 * 会话不在跑时读不到清单 —— 那时 `setModelOption` 本身也不会成,调用方照旧走重开。
 */
async function liveWireValue(sessionId: string, modelId: string, source: 'platform' | 'own'): Promise<string> {
  if (source !== 'platform') return modelId
  const options = await readSessionOptions(sessionId).catch((error: unknown) => {
    if (error instanceof SessionOptionsError && error.code === 'session_not_live') return null
    throw error
  })
  const advertised = options?.model?.available.map((choice) => choice.id) ?? []
  return runtimeOptionForPlatformModelId(modelId, advertised) ?? modelId
}

/**
 * #6396 宿主告诉一条会话页会话一件事:聊天面板那侧转录里画一行 / agent 下一轮的开头(见 SessionManager.announce)。
 * ACP 运行时没起 ⇒ 这台机器上没有活的聊天面板会话,❌ 不为了一条通知把它叫起来,答 delivered:false。
 * 终端会话不在 ACP 运行时里,同样 delivered:false —— 那一侧没有宿主画得进去的转录。
 */
export async function announceEmdashSession(input: AcpAnnounceSessionInput): Promise<{ delivered: boolean }> {
  const client = await peekAcpRuntimeClient()
  if (!client) return { delivered: false }
  return client.announceSession(input)
}

/**
 * #5276 把 Agent 级模型选择应用到它**此刻的活会话**。
 *
 * 判据与会话页 composer 那条路（`planModelSwitch`）同一套，只是这里没有渲染层手里那份 advertised
 * 清单 —— 用运行时自己的回答代替：同一条计费路上先试 `setModelOption`，适配器认就是热切（它认 =
 * 这枚票认 = 下一轮就生效）；不认、或者要换计费路（换进程才换得了端点与票），走 `reloadEmdashSession`。
 * 默认档 = 清掉会话记录里的模型后重开。
 *
 * ⚠️ 热切之后**记录也要跟上**：spawn 读的是每会话那份记录，不是活会话的 config；不写的话这条会话
 * 下次冷启动又回到旧模型 —— 与用户在手机上看到的「已生效」不一致。
 */
export async function applyEmdashSessionModelSelection(input: {
  sessionId: string
  selection:
    | { source: 'default' }
    | { source: 'byok'; modelId: string }
    | { source: 'platform'; modelId: string; protocol: string }
  /** 这条会话此刻跑在哪条计费路上 —— 由宿主按活会话持有的平台记录判，❌ 这里不猜。 */
  runningOn: 'platform' | 'own'
}): Promise<{ applied: 'hot' | 'reload' | 'next-session'; warning?: string; nativeSession?: 'preserved' | 'replaced' }> {
  const { sessionId, selection } = input
  const reason = 'model-switch'
  if (selection.source === 'default') {
    return reloadOutcome(await reloadEmdashSession({ sessionId, reason, resetModel: true }))
  }
  const target: 'platform' | 'own' = selection.source === 'platform' ? 'platform' : 'own'
  if (target === input.runningOn) {
    const client = await peekAcpRuntimeClient()
    const hot = client
      ? await client.setModelOption({
          sessionId,
          dimension: 'model',
          value: await liveWireValue(sessionId, selection.modelId, target),
        })
      : null
    // 只有活会话**确认生效**才算热切:`restart_required` / `pending_next_turn` 也是 success,
    // 把它们当成「已换」就是记录说换了、下一轮仍跑旧模型。
    if (hot?.success && hot.data.status === 'applied') {
      await recordLiveModelSwitch({ sessionId, modelId: selection.modelId, source: target })
      return { applied: 'hot' }
    }
  }
  return reloadOutcome(await reloadEmdashSession({
    sessionId,
    reason,
    model: selection.modelId,
    modelSource: target,
  }))
}

/** 从没起来过的会话只记下了选择(#7092),下一次起就用它 —— 对 Agent 级改模型来说就是「下一次会话」。 */
function reloadOutcome(reloaded: { warning?: string; nativeSession: ReloadNativeSession }): {
  applied: 'reload' | 'next-session'
  warning?: string
  nativeSession?: 'preserved' | 'replaced'
} {
  const warning = reloaded.warning ? { warning: reloaded.warning } : {}
  if (reloaded.nativeSession === 'not-started') return { applied: 'next-session', ...warning }
  return { applied: 'reload', nativeSession: reloaded.nativeSession, ...warning }
}

export interface SessionpageAgentSessionStartInput {
  agentUserId: string
  displayName: string
  agentType: string
  projectPath: string
  chatId: string
  initialText?: string
  initialPrompt?: string
  initialMessageId?: string
  initialChatPublicId?: number | null
  initialChatKind?: string | null
  specialFocus?: string | null
  avatar?: string | null
  /**
   * 建的人在创建框里选的模型(#6264),与手机「新建会话」同一套取值:`platform:` 前缀 = 咕咕平台模型,
   * 其它 = 这家 agent 自家的模型。缺席 = 没选,回落 agent 级选择。
   */
  model?: string | null
  /** 创建框里选的思考强度档位 id(#6264,如 high)。缺席 = 没选,用这家 agent 的默认。 */
  effort?: string | null
  /**
   * 创建框里选的权限模式(#6264,GuguPermissionMode)。缺席 = 没选,按无人值守默认档;
   * 选了这家 agent 没有的档当场拒,❌ 不静默换档。
   */
  permissionMode?: string | null
  /**
   * #7199 这个 agent 开子 agent 不指定 harness 时用哪个(child-harness-default.ts)。缺席 = 没配,子 agent 继承它自己的。
   * 这台机器不认得这个 harness 就当场拒建,❌ 记下一个以后 spawn 才炸的设置。
   */
  childHarness?: string | null
  signal: AbortSignal
}

export interface SessionpageAgentSessionProvisioned {
  guguAgentUserId: string
  chatId: string
  created: boolean
  sessionId: string
  projectId: string
}

export interface SessionpageAgentSessionProvisioner {
  (input: {
    agentUserId: string
    displayName: string
    /** The normalized provider used by attachAgentToSession and ACP startSession. */
    providerId: AgentProviderId
    projectPath: string
    chatId: string
    sessionId: string
    projectId: string
  }): Promise<{ guguAgentUserId: string; chatId: string; created: boolean }>
}

/**
 * Create one durable session and start it through the same ACP runtime used by session-page sessions.
 * The host callback performs the gugu identity/cache/owner projection via provisionSessionpageAgentForSession
 * before the provider session is started, so a successful return always has a live delivery owner.
 */
// #4182 —— 用任务 bundle 自己的 logger（host-boundary：会话页 bundle 不 import 宿主模块）。
const agentSessionLog = {
  info: (fields: Record<string, unknown>, msg: string) => log.info({ scope: 'sessionpage/agent-session', ...fields }, msg),
  error: (fields: Record<string, unknown>, msg: string) => log.error({ scope: 'sessionpage/agent-session', ...fields }, msg),
}

/**
 * 把登记过的项目全部打开 —— 渲染层启动时做的那件事(project-manager.ts 的 `_doLoad` → 每个项目 mountProject)。
 * 主进程里二十多处「取项目」都假定项目已被打开;桌面上渲染层一启动就替它们打开了,
 * 没有渲染层的咕咕 server(#6264)没人开,重启后第一条消息就报 `Project … not found`。
 * 各项目各自兜错(打不开的只记日志),与渲染层 allSettled 同一语义。
 */
export async function openAllEmdashProjects(): Promise<void> {
  const projects = await getProjects()
  const results = await Promise.allSettled(projects.map((project) => openProject(project.id)))
  results.forEach((result, index) => {
    const project = projects[index]!
    if (result.status === 'rejected') {
      agentSessionLog.error({ projectId: project.id, err: result.reason }, '启动时打开项目失败')
    } else if (!result.value.success) {
      agentSessionLog.error({ projectId: project.id, error: result.value.error }, '启动时打开项目失败')
    }
  })
}

/**
 * 云端 agent.create 落到这台机器、而这台机器还没装这个 agent 时,先装上(#6264)。
 * 与设备 RPC 建会话(session-timeline/create-session.ts)同一个 ensureAgentInstalled ——
 * 那里面走的是设置页「安装」按钮那同一个入口,❌ 不另写一条装法。已装好就立即返回。
 */
export async function ensureSessionpageAgentInstalled(agentType: string, signal?: AbortSignal): Promise<void> {
  await ensureAgentInstalled(toAgentProviderId(pluginIdForAgentType(agentType)), signal)
}

export async function startSessionpageAgentSession(
  input: SessionpageAgentSessionStartInput,
  provision: SessionpageAgentSessionProvisioner,
): Promise<SessionpageAgentSessionProvisioned> {
  // #4181 —— 这条链路曾静默挂死 30 分钟以上且零日志。每个阶段落一行，挂点自己报名；
  // #4184 —— host-owned abort：每个阶段边界检查取消（150s 有界启动预算）。两套互补：测点管可见，abort 管有界。
  const signal = input.signal
  const throwIfAborted = () => signal.throwIfAborted()
  throwIfAborted()
  const startedAt = Date.now()
  const mark = (stage: string) =>
    agentSessionLog.info({ agentUserId: input.agentUserId, stage, elapsedMs: Date.now() - startedAt }, 'agent session start stage — #4181')
  agentSessionLog.info({ agentUserId: input.agentUserId, agentType: input.agentType, displayName: input.displayName }, 'agent session start begin — #4181')
  // 目录还没登记 / 隐式任务工作区还没建(没有渲染层的咕咕 server)时当场补齐,见 resolve-agent-session-project.ts。
  const project = await resolveAgentSessionProject(input.projectPath)
  throwIfAborted()
  mark('projects-loaded')
  const opened = projectManager.getProject(project.id)
    ? { repositoryWorkspaceId: project.repositoryWorkspaceId }
    : await openProject(project.id).then((result) => {
      if (!result.success) throw new Error(`session-page project ${project.id} failed to open: ${result.error.type}`)
      return result.data
    })
  mark('project-opened')
  const repositoryWorkspaceId = opened.repositoryWorkspaceId ?? project.repositoryWorkspaceId
  if (!repositoryWorkspaceId)
    throw new Error(`session-page project ${project.id} has no repository workspace to run in`)
  const sessionId = randomUUID()
  const provider = toAgentProviderId(pluginIdForAgentType(input.agentType))
  // 在建会话之前解释模型:选了一个这台机器给不了的模型就当场拒,❌ 不静默落成自家模型(那会去烧用户自己的 Key,
  // 在一台没登录过这家 agent 的服务器上就是 401)。
  const modelChoice = await resolveCreateModelChoice(provider, 'acp', input.model)
  throwIfAborted()
  // 权限模式同理:这家 agent 没声明这一档就当场拒;没选按无人值守默认档。
  const requestedPermissionMode = input.permissionMode?.trim() || null
  let permissionMode: GuguPermissionMode = UNATTENDED_SESSION_PERMISSION_MODE
  if (requestedPermissionMode) {
    if (!isGuguPermissionMode(requestedPermissionMode)) {
      throw new Error(`agent.create 权限模式「${requestedPermissionMode}」不是咕咕的权限档`)
    }
    if (!agentSupportsPermissionMode(getPlugin(provider).capabilities, requestedPermissionMode)) {
      throw new Error(`agent.create ${provider} 没有「${requestedPermissionMode}」这一档权限`)
    }
    permissionMode = requestedPermissionMode
  }
  const effort = input.effort?.trim() || null
  const childHarness = input.childHarness?.trim() || null
  if (childHarness && !listPlugins().some((plugin) => plugin.metadata.id === childHarness)) {
    throw new Error(`agent.create 子 agent 默认 harness「${childHarness}」这台机器不认得`)
  }
  assertNoDeliveryEnvelopeInPersistedText(input.initialText, 'origin.firstUtterance')
  const promptCapability = getPlugin(provider).capabilities.prompt
  const acceptsDeliveryBridgeStartup = promptCapability.startupDelivery === 'delivery-bridge'
  if (input.initialPrompt && !providerConsumesStartupPrompt(promptCapability, 'pty') && !acceptsDeliveryBridgeStartup) {
    throw new Error(
      `agent.create ${provider} received an initial prompt but does not declare an argv/stdin startup channel`,
    )
  }
  let cleanupPromise: Promise<void> | null = null
  const cleanup = (): Promise<void> => cleanupPromise ??= (async () => {
    await stopExactSessionpageSession({ projectId: project.id, sessionId }).catch(() => false)
    await deleteSession(project.id, sessionId, { skipTransportStop: true }).catch(() => undefined)
  })()
  let started = false
  try {
    throwIfAborted()
    // 落行并挂载(挂不上就撤掉这一行再抛,见 attachAgentToSession);ACP 会话的引擎在下面显式起。
    const session = await attachAgentToSession({
      id: sessionId,
      projectId: project.id,
      workspaceId: repositoryWorkspaceId,
      provider,
      title: input.displayName,
      // 这条会话就是这个 agent 的运行时,标题 = 它在通讯录里的名字 —— 显式命名,harness 起的名不盖它。
      titleSource: 'manual',
      permissionMode,
      ...(effort ? { effort } : {}),
      // 不带首句 = 常驻,等主人的第一条消息:出生 idle(#7199;从前记一句占位当首轮,一出生就「在干活」,云电脑永远不闲)。
      origin: input.initialText?.trim() ? { kind: 'create', firstUtterance: input.initialText.trim() } : { kind: 'resident' },
      runtime: 'acp',
      ...(modelChoice
        ? { ...(modelChoice.model ? { model: modelChoice.model } : {}), platformModel: modelChoice.platformModel }
        : {}),
    })
    throwIfAborted()
    mark('session-attached')
    const mounted = resolveSession(project.id, session.id)
    if (!mounted) throw new Error(`session-page agent session ${session.id} is not mounted`)
    const provisioned = await provision({
      agentUserId: input.agentUserId,
      displayName: input.displayName,
      providerId: provider,
      projectPath: mounted.sessionPath,
      chatId: input.chatId,
      sessionId: session.id,
      projectId: project.id,
    })
    throwIfAborted()
    mark('identity-provisioned')
    // 在首轮跑起来之前记下:首轮里就可能开子 agent。
    if (childHarness) await recordChildHarnessDefault(provisioned.guguAgentUserId, childHarness)
    const startPromise = (await getAcpRuntimeClient()).startSession({
      input: {
        sessionId: session.id,
        projectId: project.id,
        providerId: provider,
        workspaceId: repositoryWorkspaceId,
        cwd: mounted.sessionPath,
        providerSessionId: null,
        model: modelChoice?.model ?? null,
        effort,
        ...(input.initialPrompt ? { initialQueue: [{ text: input.initialPrompt, origin: 'communication' }] } : {}),
        permissionMode,
      },
    })
    let removeAbortListener: () => void = () => undefined
    const abortPromise = new Promise<never>((_, reject) => {
      const onAbort = () => {
        void cleanup().then(
          () => reject(signal.reason ?? new Error('session-page agent session start aborted')),
          reject,
        )
      }
      if (signal.aborted) onAbort()
      else {
        signal.addEventListener('abort', onAbort, { once: true })
        removeAbortListener = () => signal.removeEventListener('abort', onAbort)
      }
    })
    let result: Awaited<typeof startPromise>
    try {
      result = await Promise.race([startPromise, abortPromise])
    } catch (error) {
      // The cleanup above owns the task/provider resources. If the runtime finishes its handshake later,
      // run the same idempotent cleanup again so a late success cannot resurrect a timed-out session.
      void startPromise.then(
        () => cleanup(),
        () => undefined,
      )
      throw error
    } finally {
      removeAbortListener()
    }
    if (!result.success) throw new Error(result.error.message ?? result.error.type)
    started = true
    mark('runtime-started')
    return { ...provisioned, sessionId: session.id, projectId: project.id }
  } catch (error) {
    agentSessionLog.error(
      { agentUserId: input.agentUserId, elapsedMs: Date.now() - startedAt, error: error instanceof Error ? error.message : String(error) },
      'agent session start failed — #4181',
    )
    if (started) await (await getAcpRuntimeClient()).stopSession({ sessionId }).catch(() => undefined)
    await cleanup()
    throw error
  }
}

export async function disposeSessionpageAgentSession(input: {
  projectId: string
  sessionId: string
}): Promise<void> {
  await stopExactSessionpageSession(input).catch(() => false)
  await deleteSession(input.projectId, input.sessionId, { skipTransportStop: true })
    .catch(() => undefined)
}

/**
 * #7199 个人助理搬走:它在这条会话上排的已安排(schedule_create)一并撤掉 —— 目标那边按搬家前读到的清单重建。
 * 返回撤了几条;一条都没有 = 0。
 */
export async function removeSessionSchedules(sessionId: string): Promise<number> {
  const { listAgentSchedules } = await import('@main/core/automations/repo')
  const { automationsService } = await import('@main/core/automations/automations-service')
  const schedules = await listAgentSchedules(sessionId)
  for (const schedule of schedules) await automationsService.deleteAutomation(schedule.id)
  return schedules.length
}

export async function exportEmdashRawAcpLog(sessionId: string): Promise<string> {
  const client = await getAcpRuntimeClient()
  const result = await client.exportRawAcpLog({ sessionId })
  if (!result.success) {
    throw new Error(`session-page raw ACP export failed: ${result.error.type}`)
  }
  return result.data
}

/**
 * @@@sessionpage TASKPAGE-FUSION — a project's display name, for the gugu host to name the chat group it
 * mirrors that project onto (session-page spec ⑨「项目 = 群」). Read-only projection at the module boundary so
 * the host never deep-imports the session backend's projects/DB layer (owner #43). Returns null for an unknown id; the
 * host falls back to an id-derived name rather than failing a session start over a cosmetic lookup.
 */
export async function emdashProjectName(projectId: string): Promise<string | null> {
  const project = await getProjectById(projectId)
  return project?.name ?? null
}
export async function emdashProjectRoot(projectId: string): Promise<string | null> { return (await getProjectById(projectId))?.path ?? null }
/** The chat a conversation's agent was born in, taken at its first mint (birth-groups.ts). */
export async function emdashTakeBirthGroup(sessionId: string): Promise<BirthGroup | null> {
  return (await import('@main/core/sessions/birth-groups')).takeBirthGroup(sessionId)
}

export type EmdashSessionProvisionInput = {
  sessionId: string
  providerId: string
  surface: 'acp' | 'tui'
  cwd: string
  projectId: string
  /**
   * spec session-graph:起这条会话的一方**显式**给的名字(`gugu_session spawn` 的 title)。
   *
   * ⚠️ 它必须**和 provider/surface/cwd 一样**跟着这份投影走,不是可选的锦上添花:开户不止 session start
   * 一条路 —— 派活那条消息进路由时,路由也会 provision(`sessionpage:ensure-agent-address`),而它跑得比
   * session start 快。少了这一格,那条路就用「<引擎 label> <序号>」把号先开了,后面的幂等复用再也改不回来。
   * ⚠️ 这一格是**按路径穷举**补上的,不是由一次读数指认的:真机上那次「config 里是「小弟」、联系人却叫
   * `Codex 2`」后来查明是判据被共享账号里上一条用例的残留满足(判据已收紧)。但这条路径确实会开户、
   * 确实跑在 session start 之前,少了它就是一个真实存在的抢跑口子 —— 按「同一事实要走遍每条开户路径」补齐。
   */
  displayName?: string
}

/** Resolve the generic session facts needed to provision its optional Gugu address before runtime start. */
export async function emdashSessionProvisionInput(target: {
  projectId: string
  sessionId: string
}): Promise<EmdashSessionProvisionInput | null> {
  const rows = await getSessions()
  const session = rows.find((row) => row.id === target.sessionId && row.projectId === target.projectId)
  if (!session) return null
  if (!session.workspaceId) throw new Error('Session workspace is not ready')
  const [workspace] = await db
    .select({ path: workspacesTable.path })
    .from(workspacesTable)
    .where(eq(workspacesTable.id, session.workspaceId))
    .limit(1)
  if (!workspace?.path) throw new Error('Session workspace path is not ready')
  return {
    sessionId: session.id,
    providerId: session.providerId,
    surface: session.runtime === 'acp' ? 'acp' : 'tui',
    cwd: workspace.path,
    projectId: session.projectId,
    displayName: session.agentDisplayName,
  }
}

export type EmdashLibraryMcpForSession = {
  /** 送进这条任务的那几台(包建好时还要再按咕咕自己的那几台去一次撞名,见 capability-bundle)。 */
  servers: LibraryMcpServer[]
  /** 该带、在这里却留在外面的那几台和原因。 */
  leftOut: SessionLibraryMcpFact['leftOut']
}

/**
 * 资源库 → MCP:这条任务新建时带上的那几台,按名字现取这台机器的列表(会话能力包的桥每次开 / 续开都问一次)。
 * 留在外面的,按顺序判:资源库里已经没有 / 这一家这条腿收不到(descriptor 的 `units.mcp` 不是 native)/
 * 这条腿只收 http / 这一家这条任务自己就有同名的(用户级、本地级、项目级都算,按任务目录读;以它自己的为准)。
 */
export async function emdashLibraryMcpForSession(sessionId: string): Promise<EmdashLibraryMcpForSession> {
  const session = (await getSessions()).find((row) => row.id === sessionId)
  const names = session?.libraryMcp ?? []
  if (!session || names.length === 0) return { servers: [], leftOut: [] }
  const { servers, missing } = await mcpLibraryService.selected(names)
  const delivery = sessionMcpDeliveryOn(
    pluginRegistry.get(session.providerId)?.capabilities.sessionBundle,
    session.runtime === 'acp' ? 'acp' : 'tui',
  )
  const provision = delivery.channel ? await emdashSessionProvisionInput({ projectId: session.projectId, sessionId }) : null
  const own = delivery.channel
    ? new Set((await mcpService.listForAgent(session.providerId, provision?.cwd)).map((server) => server.name))
    : new Set<string>()
  return planLibraryMcpDelivery({ servers, missing, delivery, own })
}

/** 包建好以后记下这一次的送达事实(`/mcp` 面板读它)。 */
export async function emdashRecordLibraryMcp(sessionId: string, fact: SessionLibraryMcpFact): Promise<void> {
  await setSessionLibraryMcp(sessionId, fact)
}

/**
 * Exact session-page conversation lookup for the gugu DM projection/open action: does the mapped conversation still
 * exist. Its status, review gate and blocker are NOT read here — they ride the host's per-agent feed
 * (spec agent-status-writer), one channel for one fact.
 */
export async function emdashSessionExists(target: {
  projectId: string
  sessionId: string
}): Promise<boolean> {
  const rows = await getSessions()
  return rows.some((row) => row.id === target.sessionId && row.projectId === target.projectId)
}

/**
 * 这条映射会话现在以哪种展示开(编程 / 通用);null = 会话已不在。私聊头部的模式按钮(#7167)据此把「使用中」
 * 那种排在前面、写出来 —— 在聊天页上看不见任务页,不说的话两行长得一模一样,而点哪一行的代价差一次重启。
 */
export async function emdashSessionView(target: {
  projectId: string
  sessionId: string
}): Promise<SessionView | null> {
  const row = (await getSessions()).find((candidate) => candidate.id === target.sessionId && candidate.projectId === target.projectId)
  return row ? sessionViewOfRuntime(row.runtime ?? 'pty') : null
}

/** Stop the exact session-page conversation through its owning ACP or PTY runtime. */
export async function emdashStopSession(target: {
  projectId: string
  sessionId: string
}): Promise<void> {
  const stopped = await stopExactSessionpageSession(target)
  if (!stopped) throw new Error('mapped session-page session no longer exists')
}

/** Open a mapped DM file through the same validated task action used by task-session tools. */
export async function emdashOpenSessionFile(
  target: { projectId: string; sessionId: string },
  path: string,
): Promise<unknown> {
  const session = (await getSessions()).find((candidate) => candidate.id === target.sessionId)
  if (!session?.workspaceId || session.archivedAt) throw new Error('映射的会话工作区尚未就绪')

  return runSessionAction(
    { ...target, workspaceId: session.workspaceId },
    { action: 'open_in_tab', path, intent: 'preview' },
  )
}

/**
 * @@@sessionpage TASKPAGE-FUSION — the authoritative inventory the gugu host reconciles its social-side
 * projection against (session-page spec ⑨: the session page is the single source of truth; gugu's contacts and
 * groups are a projection of it). `sessionIds` = conversations that still EXIST and are not archived;
 * `projectIds` = projects that still exist. The host reaps any session-page agent whose conversation is absent
 * here, and archives the group mirroring any absent project. Conversations reuse `getSessions` — the
 * same query the session-page UI lists from (it already hides archived conversations) — so
 * anything absent here is absent from the product and reaping on absence can never orphan a visible row.
 */
export async function emdashSessionpageInventory(): Promise<{
  sessionIds: string[]
  projectIds: string[]
}> {
  // Detaching folders only hides a project. Its historical group must survive reaping.
  const [sessionRows, projectRows] = await Promise.all([getSessions(), getProjects({ includeHidden: true })])
  return {
    sessionIds: sessionRows.map((c) => c.id),
    projectIds: projectRows.map((p) => p.id),
  }
}

/**
 * @@@sessionpage TASKPAGE-FUSION — fires whenever something MAY have removed conversations, so the gugu
 * host can re-reconcile its projection (spec ⑨ 删除必同步). Deliberately a coarse "something changed"
 * trigger rather than per-entity delete events: project deletes cascade their conversation rows away WITHOUT
 * emitting `session:deleted` per child — so any per-entity wiring would silently miss cases. Only
 * `session:archived` / `session:deleted` NAME a dead session; `session:torn-down` (archive, delete,
 * project dispose on app quit, plain detach) is a bare reconcile — a teardown stops runtimes, it does not end
 * the session. Returns an unsubscribe fn.
 */
export function onEmdashSessionpageReapTrigger(
  cb: (reason: string, info?: { deadSessionId?: string }) => void
): () => void {
  // ⚠️ 宿主把会话页后端的 main 打成一个 esbuild 包,其中一部分模块被包成 **lazy ESM 段**(`__esm(...)`):
  // 没被显式触碰过的段不会求值,于是这里的静态 binding 可能读到 undefined —— 实测 `sessionService` 就是
  // (e2e 里表现为 boot OK 之后立刻 unhandledRejection: "Cannot read properties of undefined (reading
  // 'on')",dev 的 vite 产物不分段所以一直没暴露)。根治要动打包配方(让这些段非 lazy 或显式 init);
  // 在那之前,**绝不能让一个订阅失败把会话页后端整体带崩** —— 每条订阅各自兜住,失败就响亮说清少了
  // 哪一条删除同步。动态 import 不是解:它会让这份 CJS 产物被截断。
  const offs: Array<() => void> = []
  const sub = (label: string, attach: () => () => void): void => {
    try {
      offs.push(attach())
    } catch (error) {
      log.error(
        `[sessionpage] SESSIONPAGE-FUSION: 订阅 ${label} 失败(打包产物里该单例未初始化)—— 这条删除同步会缺失`,
        error
      )
    }
  }
  // session:archived / session:deleted 都在行操作**之后**发、且与会话是否挂载无关 —— 归档一条用户从未
  // 打开的会话照样发(它没有挂载可拆,所以 session:torn-down 对它根本不触发)。
  sub('session:deleted', () =>
    sessionEvents.on('session:deleted', (sessionId) =>
      cb('session:deleted', { deadSessionId: sessionId }))
  )
  sub('session:archived', () =>
    sessionEvents.on('session:archived', (sessionId) =>
      cb('session:archived', { deadSessionId: sessionId }))
  )
  sub('project:deleted', () => projectEvents.on('project:deleted', () => cb('project:deleted')))
  // 拆除只说「运行时停了」,不说「会话没了」:应用退出时项目按 `tmux ? 'detach' : 'terminate'` 拆每个挂载,
  // 那些会话都还在。会话死亡的写入者是上面的 session:archived / session:deleted(行操作之后才发);
  // 这里只触发一轮普通对账,由 inventory 判断(#6168:点名死亡曾让每次退出应用都回收掉 TUI agent)。
  sub('session:torn-down', () =>
    sessionWorkspaceManager.hooks.on('session:torn-down', () => cb('session:torn-down'))
  )
  return () => {
    for (const off of offs) off()
  }
}

let extensionAgentFeedInstalled = false
/**
 * Feeds「这个 agent 动了」to open extension surfaces.
 *
 * Every event type is forwarded:
 * an extension asked to be told when agents change state, and「开始生成」is a
 * change even though nobody is blocked on a human. The bridge coalesces the
 * burst and filters by each surface's declared scope, so forwarding freely here
 * is cheap and is the only place that cannot wrongly narrow the answer.
 *
 * Channel warning: ❌ events.on(...) —— 那条是
 * main→renderer 单向发的,main 侧监听器永不触发。
 */
function installExtensionAgentChangeFeed(): void {
  if (extensionAgentFeedInstalled) return
  extensionAgentFeedInstalled = true
  agentHookService.on('agent:event', (event) => {
    // 先记下它停下时 hook 给的那句(readAgentHistory 补记录还没追上的回答),再告诉 App:App 一听到就会去读。
    heardAgentEvent(event)
    notifyExtensionAgentsChanged(event.sessionId)
  })
  // 状态也会不经事件总线就变(打断、退出、provider 门、出生、重开):写入者的每一次输出同样算「动了」。
  agentStatusWriter.on('agent:status', ({ sessionId }) => {
    notifyExtensionAgentsChanged(sessionId)
  })
  // ❌ 不转发 session:deleted。那条推送在桥里要过一遍「这个 agent 这个 surface
  // 看得见吗」,而被删掉的会话已经不在库里 —— 过滤器必然把它滤掉,于是这一路只会是
  // 一条声称存在、实际永远静默的通道。删除该怎么告知是另一件事,值得单独设计;
  // 装上一个不响的铃比没有铃更糟。
}

let platformCheckpointFeedInstalled = false
function installPlatformCheckpointFeed(): void {
  if (platformCheckpointFeedInstalled) return
  platformCheckpointFeedInstalled = true
  agentHookService.on('agent:event', (event) => {
    if (event.type === 'stop' || event.type === 'error') {
      void checkpointEmdashPlatformSession(event.sessionId)
    }
  })
}

/**
 * spec agent-status-writer —— 宿主读会话页 agent 状态只经这一个口:状态写入者写下之后的那份输出(按 agent 的流、
 * 手机列表推送都订它)。❌ 另起一条「事件 → 状态」的推导:两份推导迟早会给出两个答案。返回退订函数。
 */
export function onAgentStatus(cb: (change: AgentStatusChange) => void): () => void {
  return agentStatusWriter.on('agent:status', cb)
}

/** 启动 / 重连时的对账:每条会话此刻的读数(与写入者第一次触及它时得到的同一个)。 */
export function agentStatusSnapshot(): Promise<AgentStatusChange[]> {
  return agentStatusWriter.snapshot()
}

const sessionsGoneSubscribers = new Set<(scope: SessionScope) => void>()

/** 会话不在了(删除、归档、随任务 / 项目一起走)。写入者与宿主按 agent 的流都据此回收。 */
export function onSessionsGone(cb: (scope: SessionScope) => void): () => void {
  sessionsGoneSubscribers.add(cb)
  return () => {
    sessionsGoneSubscribers.delete(cb)
  }
}

function announceSessionsGone(scope: SessionScope): void {
  for (const cb of sessionsGoneSubscribers) {
    try {
      cb(scope)
    } catch (err) {
      log.warn('sessions-gone subscriber threw', { error: String(err) })
    }
  }
}

// app_check 给这条会话留着接着用的页面(owner 10-13):会话走了(含随项目一起走),页面跟着关。
onSessionsGone((scope) => closeCheckPages(scope))

let sessionsGoneFeedInstalled = false
function installSessionsGoneFeed(): void {
  if (sessionsGoneFeedInstalled) return
  sessionsGoneFeedInstalled = true
  // 与 onEmdashSessionpageReapTrigger 同一个防护:打包产物里 lazy 段的单例可能还没求值,一条订阅失败不能带崩后端。
  const sub = (label: string, attach: () => void): void => {
    try {
      attach()
    } catch (error) {
      log.error(`[sessionpage] 订阅 ${label} 失败 —— 这一类会话消失的回收会缺失`, error)
    }
  }
  sub('session:deleted', () =>
    sessionEvents.on('session:deleted', (sessionId) => announceSessionsGone({ sessionId }))
  )
  sub('session:archived', () =>
    sessionEvents.on('session:archived', (sessionId) => announceSessionsGone({ sessionId }))
  )
  sub('project:deleted', () =>
    projectEvents.on('project:deleted', (projectId) => announceSessionsGone({ projectId }))
  )
}

/**
 * TEST-ONLY (host exposes it env-gated behind GUGU_SESSION_TEST_HOOKS). Feed a REAL AgentEvent into the
 * REAL agentHookService pipeline for a REAL conversation — the exact call the ACP status bridge and the
 * codex CLI hooks make. Used by the otty e2e to deliver the `stop`/`permission_prompt` event that
 * represents a genuinely-finished/blocked agent's state when the ci environment's own hook plumbing
 * (missing bubblewrap sandbox, codex trust gates) fails to fire it — the derive → persist → emit → render
 * (badge + sidebar dot) is 100% the shipped pipeline; only the trigger is delivered by the test.
 */
export function emitSessionpageAgentEventForTest(event: AgentEvent): void {
  agentHookService.emitAgentEvent(event, false)
}

/** Host bridge for provider lifecycle sources that do not pass through the CLI hook server. */
export function emitSessionpageAgentEvent(event: AgentEvent): void {
  agentHookService.emitProviderLifecycleEvent(event, isAppFocused())
}

/**
 * Snapshot of the session runtime's live ACP sessions (conversationId + lifecycle + isGenerating, etc.).
 * Used by the host's delivery target for a liveness pre-check before injecting. Reads the same live-state
 * list the ACP agent-status bridge follows (agent-status-bridge.ts), taking a one-shot snapshot.
 */
export async function emdashSessionSummaries(): Promise<SessionSummary[]> {
  return Object.values(await readAcpSessionSummaries())
}

/**
 * What the task sidebar shows for each active session: its title, the project it sits in, its status,
 * whether it is pinned, and when it was last active. `session_peers` rows are these facts joined to identity.
 * This is deliberately a separate bridge from ACP runtime summaries: PTY sessions have no ACP summary, and a
 * runtime summary is not the source of the user's sidebar label. Status is the session-page status writer's
 * reading in this machine's task DB — the same column the sidebar and the phone digest read.
 */
export async function emdashSessionpageSessionFacts(): Promise<Array<{
  sessionId: string
  title: string
  projectName: string
  status: AgentStatusView | null
  isPinned: boolean
  lastInteractedAt: string | null
}>> {
  const [rows, projectRows] = await Promise.all([getSessions(), getProjects()])
  const projectName = new Map(projectRows.map((project) => [project.id, project.name]))
  return rows.map((session) => ({
    sessionId: session.id,
    title: formatSessionTitleForDisplay(session.providerId, session.title),
    projectName: projectName.get(session.projectId) ?? '',
    // 行 → Conversation 的映射器总是写这两格(`mapSessionRowToSession`);类型上可选只因渲染侧的乐观对象。
    status: session.agentStatus
      ? { status: session.agentStatus, detail: session.agentStatusDetail ?? null }
      : null,
    isPinned: session.isPinned === true,
    lastInteractedAt: session.lastInteractedAt ?? null,
  }))
}

/**
 * 手机看管 agent 的设备 RPC 处理器(`taskpage.*`)。
 *
 * ⚠️ **必须从这里导出、由宿主经桥拿**,❌ 宿主别再直接
 * `import … from './session/main/core/session-timeline/device-rpc'` ——
 * 那条静态 import 会把整条 session-timeline 链一起打进 electron main 的 rollup,
 * 于是同一份模块在**两个 bundle 里各有一份实例**:
 *   · 读侧(时间线)只读磁盘,两份都能跑,看不出问题;
 *   · 写侧要运行时状态(session message router、conversation provider 手里的 pty),
 *     而那些状态只装在桥这一份里 ⇒ 手机发消息恒报
 *     `no session message router is installed`,而桌面自己发一切正常。
 * 这也是本文件顶注说的「宿主只调唯一入口 + 桥接 IPC,从不单独伸手进会话页后端的
 * DB / pty / services」那条规矩 —— 伸手进去的代价就是上面这种「读得到、发不出」。
 */
export { createSessionpageSessionDeviceRpcHandlers } from './core/session-timeline/device-rpc'
/** #6264 经云端中转的附件:这台机器取中转桶的实现(宿主按自己的登录态拼好交回给上面那组处理器)。 */

/**
 * 这台机器上会话的**状态摘要**,随设备心跳写进云端 —— 机器离线后手机就只剩它可读了
 * (product spec 的验收:离线时仍要看得到会话状态)。
 *
 * 只出**状态**,不出正文:会话名、harness、状态、最后动静、项目名。时间线内容与消息正文
 * 一概不进 —— 「内容不在手机落库」那条边界没有放开,放开的只是「离线时也知道它卡在哪儿」。
 *
 * 同步函数:心跳那头要的就是「此刻这台机器上是什么样」,而 listSessionStates 读的是本地库,本来就是同步的。
 * ❌ 不在这里排序取前 N —— 上限由心跳侧统一施加(DEVICE_SESSION_DIGEST_LIMIT),两处各定一个数
 * 迟早对不上。这里只保证「最近动过的排在前面」。
 */
export function sessionpageSessionDigest(): Array<{
  conversationId: string
  projectId: string
  projectName: string
  title: string
  harness: string
  agentStatus: string | null
  status: AgentStatusView | null
  lastInteractedAt: string | null
  supported: boolean
  isPinned: boolean
  unseen: boolean
  parentConversationId: string | null
  agentUserId?: string | null
}> {
  refreshDigestAgents()
  const agents = digestAgents
  const { projects, sessions } = listSessionStates()
  const projectName = new Map(projects.map((project) => [project.id, project.name]))
  return [...sessions]
    .sort((a, b) => (b.lastInteractedAt ?? '').localeCompare(a.lastInteractedAt ?? ''))
    .map((session) => ({
      conversationId: session.conversationId,
      projectId: session.projectId,
      projectName: projectName.get(session.projectId) ?? '',
      title: session.title,
      harness: session.harness,
      agentStatus: session.agentStatus,
      status: parseAgentStatusView(session.status ?? null),
      lastInteractedAt: session.lastInteractedAt,
      supported: session.supported,
      // 离线时手机看的就是这份。少了这三项,离线的会话列表会把置顶画成没置顶、
      // 未读画成已读、子 agent 画成平级 —— 那不是「信息少一点」,是画错。
      // 这里三项都读得到(本地库就在手边),所以给确定值;❌ 不写 `?? false` 之类的兜底,
      // 缺席的语义在读侧(normalizeSessionDigest)是「老宿主不报」,与这里给不出值不是一回事。
      isPinned: session.isPinned === true,
      unseen: session.unseen === true,
      parentConversationId: session.parentConversationId ?? null,
      // #7199 花名册是异步读的、这里是同步的:用上一轮读到的(心跳每轮都来,晚一拍);一次都没读到就不带这一格。
      ...(agents ? { agentUserId: agents.get(session.conversationId)?.slice('user:'.length) ?? null } : {}),
    }))
}

/** 摘要里的「这条会话的 agent」:花名册的上一份读数(sessionpageSessionDigest 每次被叫时顺手刷新下一份)。 */
let digestAgents: Map<string, string> | null = null
let digestAgentsInflight = false
function refreshDigestAgents(): void {
  if (digestAgentsInflight) return
  digestAgentsInflight = true
  agentIdsBySession(process.env)
    .then((ids) => {
      digestAgents = ids
    })
    .catch((error: unknown) => {
      log.warn('session digest: read agent roster failed', { error: String(error) })
    })
    .finally(() => {
      digestAgentsInflight = false
    })
}

/**
 * #6264 server 换版时这台机器(这个账号)算不算忙 —— 写进 activity.json 的 busy,守护进程据此决定现在换还是等空闲。
 * 只数账号进程一重启就会被打断的会话(`busyForVersionSwitch`,「会不会被打断」读 `sessionProcess(id).home`);
 * tmux 里的终端会话换版后照名字接回,不拦换版。本机读数,❌ 进云端摘要:读者只有本机守护进程。
 */
export function sessionpageBusyForVersionSwitch(): boolean {
  return listSessionStates().sessions.some((session) =>
    busyForVersionSwitch(
      parseAgentStatusView(session.status ?? null),
      session.runtime,
      sessionProcess(session.conversationId)?.home ?? null,
    ),
  )
}

/**
 * #4277 日志按账号分文件:宿主在 owner 边界处调用,会话页那份 gugu-task.log 跟着切。返回切换后的路径
 * (失败时是原路径,宿主据此打 warn)。❌ 写成 `export { x as y } from`:打包后成了未定义绑定(CI 守卫判红)。
 */
export function setSessionpageLogFileOwner(ownerUserId: string | null): string | undefined {
  return setLogFileOwner(ownerUserId)
}

export {readAssistantWorkReceipts} from '@main/core/session-timeline/task-exchanges'
