import './browser-user-agent-bootstrap'
import { noteExitReason } from './lib/exit-reason'
import {assistantWorkHistoryPosition} from './assistant-work-history-position'
import { createDesktopWorkReportIds } from './assistant-work-report-ids'
import { createAssistantWorkAvailabilityNotifier } from '@gugu/core/cloud/assistantWorkAvailability'
import { registerFileViewerMenus } from './file-viewer-context-menu'
import { registerContentContextMenus } from './content-context-menu'
import { configuredEndpoint } from '@gugu/core/cloud/attachmentsApi'
import { createDesktopFileAccess } from './desktopFileAccess'
import { createNativeFileHost, registerNativeFileIpc } from './nativeFileHost'
import { uploadSessionFiles } from '@gugu/core/local/agent/sessionFileHandoff'
import { resourceMonitorWindow } from './resource-monitor-window'
import { linkProjectDevice } from './session/main/core/projects/project-device-link'
import {
  app,
  // @@@5747 Electron 自带的那个 autoUpdater(Squirrel 的直接封装),与 electron-updater 的同名导出
  // 不是一个东西。停机跑完之后要的正是它:它才会走 Squirrel 的「装完并重新打开」。
  autoUpdater as nativeAutoUpdater,
  session,
  BrowserWindow,
  shell,
  ipcMain,
  Tray,
  Menu,
  nativeImage,
  nativeTheme,
  dialog,
  clipboard,
  Notification,
  net,
  protocol,
  powerMonitor,
  safeStorage,
  screen,
  desktopCapturer,
  webContents,
  type OpenDialogOptions
} from 'electron'
import { listAgents, listDevices, listReapedAgents, provisionSessionpageAgentOneTrip, resolveMachineHardwareId, type DeviceTableClient, type RuntimeAuthProvider } from '@gugu/core'
import { claimDeviceFreeCredits, readDeviceClaimStatus } from './device-free-credits'
import { createDeviceActionsRuntime, nativeComponentsDir, type DeviceActionsRuntime } from './device-actions/runtime'
import { sampleCuaImage } from './device-actions/native/cua-image-sample'
import { createComputerControlWindow } from './device-actions/computer-control-window'
import { installNativeAppearanceSync, installWindowMaterial, type WindowMaterialHost } from './window-material'
import enDeviceStrings from '@/i18n/locales/en-US/settings'
import zhDeviceStrings from '@/i18n/locales/zh-CN/settings'
import { createDeviceActionCaller, type DeviceActionCaller } from '@gugu/core/cloud/deviceActionCaller'
import type { DeviceActionResult } from '@gugu/core/shared/deviceActions'
import {
  createLogger,
  currentLogFile,
  initLogging,
  installConsoleBridge,
  switchLogFileForOwner,
  writeRendererLog,
  readLogTailForFeedback,
  RENDERER_LOG_CHANNEL,
} from './lib/logger'
import { autoApproveFromPermissionMode } from '@gugu/session-core/acp'
import { classifyFatal, recordFatalSync } from './lib/fatal-triage'
import { pathToFileURL } from 'node:url'
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'fs'
import { homedir, hostname, platform } from 'os'
import { dirname, join, resolve, sep } from 'path'
import { autoUpdater } from 'electron-updater'
import windowStateStore from 'electron-window-state'
import { mainWindowSize } from './main-window-size'
import {
  invokeRendererAuth,
  invokeRendererExtensions,
  isHostWindowFocused,
  isHostWindowFullScreen,
  onHostWindowFocusChange,
  onHostWindowFullScreenChange,
  notifyRendererForeground,
  setMainWindow,
  setupRendererCommandIpcHandlers,
} from './ipc-bridge'
import {
  EXTENSION_HOST_ACTION_METHOD,
  EXTENSION_INSTALL_CONSENT_CLOSE_METHOD,
  EXTENSION_INSTALL_CONSENT_METHOD,
  EXTENSION_INSTALLED_CHANGED_METHOD,
  EXTENSION_LISTED_SESSION_METHOD,
  EXTENSION_MEMBER_FACES_METHOD,
  type ExtensionInstallConsentResult,
} from '@shared/extensions/host-actions'
import { givesAgentTools } from '@shared/extensions/app-places'
import { buildProbePlatformCredentials } from './harness-catalog-probe-env'
import { runWindowMenuCommand } from './window-menu-commands'
import { isWindowMenuCommand } from '../shared/window-menu-commands'
import { purgeStaleUpdaterCache, updaterCacheBaseDir } from './updaterCache'
import { detectLocalSigning, downloadDmg, pickMacDmgFile, shouldUseDmgPath } from './macDmgUpdater'
import type { LocalSigning } from './macDmgUpdater'
import { createSelectAccountHandler, webAuthnKeychainGroup } from './macWebAuthn'
import {
  cleanupRemoteFileDirectory,
  cleanupStaleRemoteFileDirectories,
  trackRemoteFileDirectory,
} from './remoteFileOpen'
import {
  changelogUrl,
  resolveUpdateChannel,
  updateFeedOptions,
  updateFeedUrl,
} from './updateFeeds'
import {
  parseBuildDistribution,
  resolveUpdaterPolicy,
  shouldRejectUpdateTarget,
  updateStateAdvances,
} from '../shared/update-policy'
import { createBuiltRendererRootResolver } from './rendererRoot'
import { ensureWindowsNpmGlobalBinInPath, hydrateLoginShellPath, loginShellEnvSnapshot } from './shellPath'
import { makeChatClient, makeIdentityClient, supabase, electronFetch, bindElectronSupabaseAuth, refreshElectronSupabaseAuth, resumeElectronSupabaseRealtime } from './supabase'
import { createAccountResumeHandler, installNativeResumeSource, installNativeSleepActivity, watchHostResumeGap } from './server/account-resume-wiring'
import { applyOwnerTimeZoneContext, ownerTimeZoneFromEnvironment } from './server/owner-timezone'
import { runDueScheduledTasksForOwner } from './scheduled-tasks-runner'
import { handOffLegacyWechat } from './wechat/handoff'
import { LegacyWechatStore } from './wechat/store'
import { createDesktopDeviceCommandWakeSubscription } from './device-command-wake'
import { createDesktopDeviceRpcSubscription, type OpenTopicPublisher } from './device-rpc-responder'
import { deviceRpcAskerLimitsFromEnv } from './device-rpc-askers'
import type { MessagePreviewHostDeps } from './session/main/core/session-timeline/preview-rpc'
import { MESSAGE_PREVIEW_EVENT } from '@gugu/session-core/session-record/message-preview'
import { createDeviceLinkHost } from './server/device-link-host'
import { serverDeviceLabel } from '@gugu/core/cloud/serverConnectVia'
import {
  noteTunnelActivity,
  onTunnelRelayChange,
  REMOTE_TUNNEL_OPEN,
  resolveRelayEndpoint,
  SERVER_LOGIN_ACTION,
  TUNNEL_OPEN_RPC_TYPE,
} from '@gugu/core/cloud/remoteTunnel'
import { startTunnelEndpoint, type TunnelEndpoint } from './server/tunnel-endpoint'
import { findFrpc, frpcCandidates } from './server/frpc-runner'
import { createTunnelMachines, type TunnelMachines } from './server/tunnel-machines'
import { TUNNEL_MACHINES_CHANNELS, type TunnelWant } from '../src/lib/tunnelMachines'
import { machineDisplayName } from '@gugu/core/device/machineDisplayName'
import {
  createDeviceRuntimeHostLoop,
  stopRuntimeHostWithTimeout,
  runtimeAuthFromSupabaseTokens,
  clearHumanAuthSession,
  detectDeviceCapabilities,
  resolveGuguHome,
  writeHumanAuthSession,
  createAgent,
  findLocalAgentByUserId,
  catalogEngineIdForAgent,
  engineIdForAgentType,
  setLocalAgentModelSelection,
  type AgentModelSelection,
  type DeviceCapabilities,
  type DeviceRuntimeHost,
  type DeviceRuntimeIdentityClient,
  type RuntimeAuth,
  requireRuntimeAuth,
  setCoreLoggerFactory
} from '@gugu/core'
import { getSupabaseAnonKey, getSupabaseUrl } from '@gugu/core/cloud/config'
import { cloudComputerBaseUrl, createCloudComputerClient, isCloudComputerNotOpen, wakeCloudComputerUntilOnline } from '@gugu/core/cloud/cloudComputer'
import { cloudComputerEnabled, officialServicesEnabled } from '@gugu/core/cloud/optionalServices'
import { createChatChannelsClient } from '@gugu/core/cloud/chatChannels'
import type { SessionMessage } from '@shared/core/sessions/sessions'
import { TRAFFIC_LIGHT_POSITION } from '@shared/window-chrome-native'
import { attachAuxWindows, isOwnPage } from './aux-window'
import { forwardWindowSeen } from './animation-visibility'
import { installQuickChat, type QuickChat } from './quick-chat-window'
import { installAssistantHome } from './assistant-home'
import { receivePhoneDeviceFile } from './phone-device-file'
import {
  clearSessionpageSessionIntegrationOverridesForTest,
  resolveSessionpageCredentialLifecycle,
  setSessionpageSessionIntegrationOverrideForTest,
} from '@gugu/session-plugins/agents'
// Session-page delivery is the only local agent runtime bridge. Unmapped agents fail loud.
import {
  SessionWakeError,
  SessionpageLocalDeliveryRouter,
  createSessionpageDeliveryBridge,
} from './sessionpage/session-injection'
import {
  agentInboxDepsFromBridge,
  resolveGuguIds as resolveGuguIdsForInbox,
  type AgentRosterRemovalReason,
} from '@gugu/core/local/agent/deviceCommandRuntime'
import {
  kickAgentInboxPull,
  readAgentInboxBatchAuditForTest,
} from '@gugu/core/local/agent/agentInboxReader'
import { fetchThreadMessagesViaRest } from '@gugu/core/cloud/threadMessagesRest'
// #4280 —— 壳的唯一 producer 住在这里,三条渠道都从它出字节。
import {
  buildAgentDeliveryEnvelope,
  formatDeliveryTimestamp,
  type GuguIdentity,
} from '@gugu/core/local/agent/deliveryEnvelope'
import { handleUnifiedSessionMessage, type UnifiedRecipientResult } from './unified-session-message'
import {createDesktopAssistantWorkHistory} from './assistant-work-history'
import { installAssistantWorkLedgerHost, enqueueAssistantWorkMessage } from './sessionpage/assistant-work-ledger'
import { createAssistantWorkNoticeWakePump } from '@gugu/core/cloud/assistantWorkNoticeWake'
import { isOwnerReceiptEvent } from '@gugu/core/cloud/assistantWorkReconciliation'
import { assistantWorkCoordinator } from '@gugu/core/cloud/assistantWorkRouting'
import { createDesktopAssistantWorkReconciler } from './assistant-work-reconciliation'
import { enqueueAssistantWorkReport } from '@gugu/core/cloud/assistantWorkReports'
import {withAssistantWorkReply} from '@gugu/core/shared/assistantWorkReply'
import { pickAssistant, type AssistantProvisionRow } from '@gugu/core/shared/assistantProvision'
import { landTaskCardFirstTurn } from './sessionpage/task-card-first-turn'
import { withQuestionCard } from './sessionpage/question-card'
import {
  emdashAgentRegistry,
  type LocalSessionPeer,
} from './sessionpage/emdash-agent-registry'
import {
  resolveSessionpageSenderBinding,
  resolveSessionpageSessionPeers,
} from './sessionpage/session-addressing'
import { kickInboxWhenAuthed } from './sessionpage/agent-inbox-kick'
import { droidDaemonSessionDelivery } from './sessionpage/droid-daemon-session-delivery'
import { opencodeServeAttachSessionDelivery } from './sessionpage/opencode-serve-attach-delivery'
import { relayTurnLifecycleEvent, type TurnLifecycleEdge } from './sessionpage/turn-lifecycle-relay'
import { teardownSessionpageSessionRuntimes } from './sessionpage/sessionpage-session-runtime-registry'
import { fatalSessionpageBoot as showFatalSessionpageBoot, reportFatalBoot, watchNavigations, type FatalBootDeps } from './sessionpage/fatal-boot'
import { agentStatusFeed } from './sessionpage/agent-status-feed'
// 该模块的加载副作用把 app-server 认领者注册进投递注册表(spec session-injection「认领者是注册表」)。
import {
  codexAppServerRegistry,
  disposeAllCodexAppServerSessions,
  killAllCodexAppServerProcessGroupsSync,
  resumeAllCodexAppServerTurnWaiters,
} from './sessionpage/codex-app-server-delivery'
import { removeRetiredCodexCapabilityRuns } from './sessionpage/codex-app-server-transport'
import { releaseAgentLocalFootprint } from './sessionpage/agent-local-footprint'
import {
  awaitSessionpageCloudIdentity,
  onSessionpageAgentProvisioned,
  openOwnerDirectChatForAgent,
  cacheString,
  SESSION_CACHE_KEY,
  PROJECT_CACHE_KEY,
  provisionSessionpageAgentForSession,
  registerExistingSessionpageAgents,
  unregisterForeignSessionpageAgents,
  refreshAgentNamingFacts,
  setSessionpageAgentCardRevoker,
} from './sessionpage/emdash-agent-provisioning'
import { sessionpageRenameAnnouncement, type SessionpageAgentNameTaken } from './sessionpage/sessionpage-rename-announcement'
import { tellAgentItWasRenamed, type AgentRenamed } from './sessionpage/agent-rename-notice'
import {
  demoteSessionpageDeliveryOwnerFromRegistration,
  runSessionpagePtyTeardownSteps,
  sessionpageDeliveryTargets,
  unregisterSessionpageDeliveryOwners,
} from './sessionpage/sessionpage-delivery-owner-registry'
import * as codexPtyProvisioning from './sessionpage/codex-pty-provisioning'
import type { CodexPtyOverride } from './sessionpage/codex-pty-provisioning'
import {
  startSessionTuiHost,
  type SessionTuiHostContext,
  type SessionTuiStartInfo as EmdashPtySessionpageStartInfo,
} from './sessionpage/session-tui-host-start'
import { resolveBootOwner, type BootOwnerAnswer } from './sessionpage/boot-owner'
import { reconcileSessionpageAgents } from './sessionpage/sessionpage-agent-reaper'
import { startSessionpageAgentArchivalSync } from './sessionpage/sessionpage-agent-archival'
import { releaseDeletedOwnedAgent } from './sessionpage/owner-agent-deletion'
import {
  createHostLocalSessionSource,
  type HostLocalSessionSource,
} from './sessionpage/local-session-source'
import { resolveSessionpageAgentCard } from './sessionpage/sessionpage-agent-card'
import { loadSessionpageCanonicalAgentIdentities } from './sessionpage/sessionpage-agent-identity'
import { SESSION_SHELL_CHANNELS, agentNamesFromPeers, type SessionShellAgentName } from '../src/session/shared/lib/ipc/shell-port'
import { sessionpageAgentProvisionedEvent, sessionpageAgentRenamedEvent } from '../src/session/shared/lib/ipc/sessionpage-identity-contract'
import type { EventDefinition } from '../src/session/shared/lib/ipc/events'
import { MAIN_UI_EVENTS } from '../src/lib/mainUiEvents'
import { createSessionpageIdentityHost } from './sessionpage/sessionpage-identity-host'
import { createSessionpageProjectGroupHost, ensureProjectNoticeAccess } from './sessionpage/sessionpage-project-group-binding'
import { prepareProjectAgentNotice } from './sessionpage/project-agent-notice'
import { onProjectGroupMappingChanged } from './sessionpage/sessionpage-project-groups'
import { readSessionpageOpenTarget } from './sessionpage/sessionpage-agent-mapping'
import {
  clearLocalSessionDeliveryFailuresForTest,
  clearLocalSessionInjectionAuditForTest,
  createLocalSessionDeliveryBridge,
  localSessionDeliveryTarget,
  withSessionLiveInboxKick,
  readLocalSessionInjectionAuditForTest,
  readLocalSessionDeliveryFailuresForTest,
} from './sessionpage/local-session-delivery'
import { assertAgentModelSelectionOpen, listPlatformModels, settleResidualPlatformModelAccess } from './model-access'
import {
  findInjectionContract,
  hasCredentialSink,
} from './engine-injection-contract'
import {
  sessionBundleModelFor,
  heldPlatformModelForSession,
  expiredPlatformModelSessions,
  platformCredentialGenerationForSession,
  platformRequestsUseCredentialProxy,
  reissueExpiredPlatformModelForSession,
  sweepStalePlatformSettingsFiles,
  releasePlatformModelsAtExit,
  configurePlatformRelayPersistence,
  configurePlatformCredentialCopy,
  configurePlatformCredentialRefusalSink,
  clearPlatformIssueBackoff,
  configurePlatformMembershipListener,
  platformRelaySessionsRestored,
  restorePlatformRelaySessions,
} from './sessionpage/sessionpage-platform-model'
import { liveTmuxSessionIds } from './sessionpage/detached-runtime'
import { startTmuxBackendStartupSweep } from './sessionpage/tmux-backend'
import { createSessionpagePlatformHooks, type SessionpagePlatformHooks } from './sessionpage/sessionpage-platform-hooks'
import { registerHostResumeTestSignal } from './sessionpage/host-resume-test-signal'
import {
  SessionpagePlatformRecoveryCoordinator,
} from './sessionpage/sessionpage-platform-recovery'
import {
  SESSIONPAGE_PLATFORM_CATALOG_CHANNEL,
  sessionpagePlatformCatalog,
} from './sessionpage/sessionpage-platform-catalog'
import { sessionPlatformModel } from './session/main/core/sessions/platform-model-selection'
import { providerSessionIdForSession } from './session/main/core/sessions/provider-session-id'
import { SESSIONPAGE_SESSION_RELOAD_CHANNEL } from '../src/session/shared/core/agents/session-reload'
import { SESSIONPAGE_PLATFORM_RETRY_CHANNEL } from '../src/session/shared/core/agents/platform-model'
import {
  VOICE_NOTE_MEETINGS_CHANNEL,
  VOICE_NOTE_MICROPHONE_CHANNEL,
  VOICE_NOTE_RELEASE_CHANNEL,
  VOICE_NOTE_TRANSCRIBE_CHANNEL,
  type VoiceNoteTranscribeRequest,
} from '../src/session/shared/core/voice-notes'
import { release as releaseVoiceNoteTicket, transcribeVoiceNoteSegment, upcomingMeetings, voiceNoteMicrophone } from './voice-notes'
import { createSessionTitleNamer } from './session-title-namer'
import { SESSION_TITLE_MODELS_CHANNEL } from '../src/session/shared/core/sessions/session-title-namer'
import { sessionEvents } from './session/main/core/sessions/session-events'
import { applyGeneratedTitle, sessionTitleIsFallback } from './session/main/core/sessions/renameSession'
import { appSettingsService } from './session/main/core/settings/settings-service'
import { platformWebSearchForSession } from './sessionpage/sessionpage-platform-search'
import {
  claudeSessionDelivery,
  sweepStaleRendezvousSocksNow,
} from './sessionpage/claude-session-delivery'
import {
  buildSessionBundle,
  sessionExtensionDelivery,
  sessionBundleUserMcpFor,
  loadSessionAcpCapabilities,
  PRODUCT_CAPABILITY_PACKAGES,
  providerDeliversModelViaConfigFile,
  providerUsesSessionProcessConfig,
  setSessionIntegrationBridge,
  setSessionIntegrationSkillBridge,
  setBrowserUseApp,
  setSessionWebSearchBridge,
  setSessionExtensionBridge,
  setSessionLibraryMcpBridge,
} from './capability-bundle'
import { mcpService } from './session/main/core/mcp/services/McpService'
import { toolsRuntimePath } from './session/main/core/extensions/app-runtime-dir'
import { cloudExtensionMarket } from './session/main/core/extensions/market-catalog-root'
import { buildExtensionGateway, createExtensionCatalog, createExtensionGatewayHost, forgetSessionAppScope, inScopeOf, setSessionAppScope, type ExtensionGatewayHost } from './extension-gateway'
import { appScopeOf, inAppScope } from './app-scope'
import {
  buildIntegrationBridge,
  createIntegrationMcpHost,
  type IntegrationMcpHost,
} from './integration-mcp-bridge'
import {
  browserUseAppInstalled,
  closeSessionBrowserTools,
  createBrowserAppProgram,
} from './browser-agent-mcp'
import { createComputerUsePreview, installedComputerUseApps, type ComputerUsePreview } from './computer-use-program'
import { sessionOf as computerSessionOf } from './device-actions/families/computer'
import { connectedSessionIntegrations } from './session/main/core/integrations/session-integrations'
import { connectedCliSkills } from './session/main/core/integrations/cli/cli-integrations'
import { integrationCredentialStore } from './session/main/core/integrations/integration-credential-store-instance'
import { applySessionMaterialization } from './session-materialization'
import { assistantHomeTaskContext, preparePersonalAssistantContext } from './sessionpage/assistant-context'
import { startupDiscovery } from './sessionpage/startup-discovery'
import { createAssistantPanelRuntime } from './sessionpage/assistant-panel-runtime'
import { assistantWorkBinding, assistantWorkForAgent } from './sessionpage/assistant-work'
import { createStableMcpPersistence, persistedMcpGrantCount, sessionpageSessionOfGrantKey } from './stable-mcp-persistence'
import type { GuguMcpHostPersistence } from './gugu-mcp-host'
import {
  buildAgentIdentityBootstrap,
  isPersonalAssistant,
  buildSessionOnlyBridge,
  createDesktopGuguMcpHost,
  setSessionExtensionCatalog,
  type AcpMcpServer,
  type DesktopGuguMcpHost,
} from './acp-engine-utils'
import { GUGU_PLATFORM_BLOCK, buildSessionpageProjectContextBlock } from './product-platform-prompt'
import {
  guguAgentUserIdForSession,
  localAgentForSession,
  resolveRuntimeForkSource,
} from './sessionpage/sessionpage-session-agent'
import { writeCapabilityLoadReport } from './capability-report-store'
// 零依赖常量模块:与会话页模块共用同一个 scheme 字面量,不把它抄成两份(见 @@@2374-ext-scheme)。
import { EXTENSION_SCHEME } from '../src/session/shared/extensions/scheme'
// 同上:零依赖常量模块。❌ 别从 files/preview-protocol 里取 —— 那条会把会话页主进程图提上来。
import { previewSchemePrivilege } from '../src/session/shared/preview/preview-url'
import { setExtensionCheckAvailable } from './mcp/gugu-extension-tool'
import { setGuideLookPicture } from './mcp/gugu-guide-tool'
import { guguLinkScheme } from '@gugu/core/shared/ui/guguLink'
import { catalogAppsOf, extensionAgentPrograms } from './extension-session-mcp'
// 仅类型:编译期擦除,不会把会话页主进程图提升到 app.setPath 之前(运行时加载见 whenReady 里的动态 import)。
import type { SessionAction } from './sessionpage/emdash-main-bridge'
import type { AgentEvent } from '../src/session/shared/core/agents/agentEvents'
import { listAgentCreationTools } from './session/main/core/agents/plugin-registry'

// @@@gugu-app-scheme — 生产渲染层走自定义协议而非 file://。file:// 下动态插入的
// <script type=module> 被 Chromium 静默拒载(会话页子应用白屏根因),且 file://
// 无 V8 code cache。standard+secure 让 module/fetch/localStorage 都按正常 https 语义工作。
// 注册必须在 app ready 之前;'gugu' scheme 已被 deeplink 占用,故渲染层用 'gugu-app'。
// @@@2374-ext-scheme — 扩展包走 gugu-ext://<extensionId>/,与渲染层同理由(file:// 拒载 module
// script),另加一条:每个扩展拿到**各自独立的 secure origin**,存储彼此隔离、CSP 可按扩展钉死。
// 与 gugu-app 一起在此注册,因为 registerSchemesAsPrivileged 必须早于 app ready;协议的 handler
// 在会话页模块 boot 时装(extension-protocol.ts),那里才知道扩展装在哪。
// ❌ corsEnabled:扩展跨源取数由主进程按 manifest 白名单逐条授权(extension-network-policy.ts),
// 不给这个 scheme 开全局 CORS 通行。
protocol.registerSchemesAsPrivileged([
  {
    scheme: 'gugu-app',
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: true,
      corsEnabled: true,
      stream: true,
      codeCache: true
    }
  },
  {
    scheme: EXTENSION_SCHEME,
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: true,
      stream: true
    }
  },
  // @@@6156-preview-scheme — 网页预览的文件供给。与上面两个同理由在此注册(必须早于 app
  // ready);handler 在会话页模块 boot 时装(files/preview-protocol.ts),那里才拿得到工作区。
  // 每次打开预览发一个新 id 当 host,于是两份预览各自一个 secure origin、存储互不相见。
  // ❌ corsEnabled:预览页在沙箱里是不透明源,取自己旁边的模块脚本与字体要放行,那一条由
  // handler 逐个响应打 `Access-Control-Allow-Origin`,不给这个 scheme 开全局 CORS 通行。
  previewSchemePrivilege()
])
import {
  reapResidualEngineGroupsOnce,
  createReapDeps,
  describeReapSummary,
} from './enginePidReap'
import { createPushedRuntimeAuthProvider, type PushedRuntimeAuth } from './runtime-auth-provider'
import { createServerAuthProvider, type ServerAuthProvider } from './server/server-auth'
import { ensureUtf8Locale } from './server/server-locale'
import { killAccountTmuxServer } from './server/server-layout'
import { registerServerSshInstallIpc } from './server/ssh-install/ipc'
import { registerServerSshUninstallIpc } from './server/ssh-uninstall-ipc'
import { registerSshLinkIpc } from './server/ssh-link-ipc'
import { openCloudDeviceRpcPipe, openSshDeviceRpcPipe } from './device-rpc-requester'
import { createDeviceRpcRequester } from '@gugu/core/cloud/deviceRpcRequester'
import type { DeviceRpcHandlers } from '@gugu/core/cloud/deviceRpcResponder'
import type { AssistantWorkRpcClient } from '@gugu/core/cloud/assistantWorkOutbox'
import type { SessionAttachmentRef, SessionFileInput } from '@gugu/core/cloud/sessionAttachments'
import { createAssistantWorkOutboxHost, type AssistantWorkOutboxHost } from './assistant-work-outbox'
import { subscribeAuthenticatedElectronRealtimeChannel } from './realtime-channel'
import { CrossMachineError, createCrossMachineSessions, type CrossMachineSessions } from './cross-machine-sessions'
import { createActivitySummaryQuery } from './activity-summary-query'
import type { RemoteSessionCaller } from '@gugu/session-core/session-record/contract'
import { computerName, ensureGuguKey, guguKeyComment, guguKeyDir } from './server/ssh-key-install'
import {
  createDirectTerminalResolver,
  closeSshMasters,
  sshControlDir,
  configureSshControlScope,
  runSshInBackground,
  terminalControlPath,
  createMachineKeyInstaller,
  createSshMachineStore,
  defaultSshMachinesFile,
  registerSshMachinesIpc,
  sshTargetOf,
  findSshMachine,
} from './server/ssh-machines'
import { setAccountAccessTokenReader, setAccountFileResolver } from '@main/core/extensions/account-token'
import { createLocalDeviceIdResolver, type DeviceHeartbeatTableClient } from '@gugu/core/cloud/deviceRuntime'
import { announceLocalDeviceIdentity } from './local-device-identity'
import { createDeviceProjectsPublisher, type DeviceProjectsPublisher } from '@gugu/core/cloud/deviceProjectsPublisher'
import type { DeviceProjectsRpcClient } from '@gugu/core/cloud/deviceProjects'
import type { AgentStreamPayload } from '@gugu/core/shared/types/agentStream'
import { emdashPlatformReleaseIntent } from './session/main/core/acp/emdash-platform-injector'
import type {
  EmdashSessionStartInfo as EmdashStartInfo,
  SessionPromptDelivery,
} from './session/main/core/acp/emdash-mcp-injector'
import { createRuntimeBeforeQuitHandler, runShutdownPhase, type ShutdownPhaseEvent } from './runtime-quit'
import { createUpdateQuit } from './update-quit'
import { createUpdateFlow } from './update-flow'
import {
  hardenWebPreferences,
  installDevtoolsLock,
  isDevtoolsLocked,
} from './devtools-lock'
import { applyApplicationMenu } from './app-menu'
import { createMainRendererGoneHandler, createMainRendererResponsivenessLog, type CrashDialogChoice } from './renderer-crash-recovery'
import { menuOpenSettingsChannel } from '@shared/events/appEvents'
import { pinDesktopPointerMedia } from './linux-pointer-media'
import { enableOverlayScrollbars } from './windows-overlay-scrollbars'
import {
  NOTIFICATION_BUS_NAME,
  PROBE_TIMEOUT_MS,
  createNotificationGate,
  probeBusNameHasOwner,
  resolveSessionBusPath,
} from './linux-notification-service'
import { HOST_LOCALE_STATE_FILE, HostLocaleStore } from './host-locale-store'
import {
  OVERLAY_BADGE_SIZE,
  buildOverlayBadgeBitmap,
  formatBadgeCount,
  paintBadgeOnBitmap,
} from './tray-badge'
import { HOST_SYSTEM_LANGUAGES_CHANNEL, hostCatalog, type HostCatalog } from '../shared/host-localization'

// ── Dual-instance support ────────────────────────────────────────────────────
// CLI arg (preferred): --user-data-dir=/path/to/dir ; env fallback: GUGU_USER_DATA_DIR=/path/to/dir
function getArgValue(flag: string): string | undefined {
  const arg = process.argv.find((a) => a.startsWith(`${flag}=`))
  return arg ? arg.slice(flag.length + 1) : undefined
}

import { writeSharedUserDataPointer } from './session/headless/shared-user-data'

const IS_TEST_MODE = process.env.GUGU_TEST_MODE === '1'
// 咕咕 server(product spec):同一份主进程,没有窗口。由 server-entry.ts 置位。
// 没有窗口 ⇒ 不建窗口、不建托盘、不弹界面更新;登录态由主进程自己持有(server/server-auth.ts)。
const SERVER_MODE = process.env.GUGU_SERVER_MODE === '1'
// 这台设备首次登记时报的名字:server 报登录时记在 connect-via.json 的名字(远程 SSH 填的别名、云电脑开通给的「云电脑」),
// 没有就报空名由库取 `Linux 1`;桌面不传,沿用 hostname。**登记设备的每一处都用这一份** —— #7199 远程隧道让
// localDeviceId 在 server 一起来就先登记一次,那笔没带名字,行就按沙箱 hostname(iZbp…)建了,之后改不回来。
const deviceLabelOption: { label?: () => string } = SERVER_MODE ? { label: () => serverDeviceLabel(process.env) } : {}

const userDataDir = getArgValue('--user-data-dir') ?? process.env.GUGU_USER_DATA_DIR
if (userDataDir) {
  app.setPath('userData', userDataDir)
}
// @@@5080 把**解析之后**的 userData 真值留给同机的无头宿主,让「桌面版 / 网页版」看同一份会话
// (owner:「我以为只是换个视窗」)。必须在上面的 setPath 之后取 —— 取早了就写下了被覆盖前的路径。
// ⚠️ 隔离实例(e2e / 双开)带着自己的 --user-data-dir,❌ 不该把机器级指针改写成它们的临时目录:
// 那会让下一个无头宿主指向一个用完就删的目录。所以只有跑在默认目录上的那个实例才写。
// server 用自己的数据目录,❌ 不改写桌面壳留给无头任务宿主的那根机器级指针。
if (!userDataDir && !SERVER_MODE) {
  writeSharedUserDataPointer(app.getPath('userData'))
}
// @@@logging (#2382) - 日志要尽早起来,但必须在 userData 定好之后(日志文件就落在 userData/logs 里)。
// installConsoleBridge:存量 console.* 立刻进文件(逐个改成结构化调用是增量的事)。
// 未捕获异常/未处理拒绝在这之前是彻底静默的 —— 打包后连崩在哪都不知道。
const logDir = join(app.getPath('userData'), 'logs')
initLogging({
  dir: logDir,
  // 生产/开发由 app.isPackaged 判(打包后 NODE_ENV 是 undefined,靠它会把生产当成 dev)
  level: app.isPackaged ? 'info' : 'debug',
  stdout: !app.isPackaged || process.env.GUGU_LOG_STDOUT === '1',
})
installConsoleBridge()
// core 是 transport-agnostic 的(同一份代码也跑在 cloud worker / 脚本里),所以它只认接口;
// 主进程在这里把 pino 塞进去,core 的日志就和主进程同流、同脱敏、同落盘。
setCoreLoggerFactory((scope) => createLogger(`core/${scope}`))
const autonomyDebugLogger = createLogger('autonomy-debug')
// #4008 会话页会话状态 → 咕咕运行事实这条路上的告警(身份解析不到、快照读失败)。
const sessionpageActivityLogger = createLogger('sessionpage/activity')
// 退出登录会重启整个进程,这条路上的日志必须落盘 —— 进程都没了,stdout 没人接。
const authLogger = createLogger('auth')
const integrationMcpLogger = createLogger('sessionpage/integration-mcp')
// @@@devtools-lock — 锁定态本身与它被突破时都要落盘:装机包上出问题时,日志文件是唯一的现场。
const devtoolsLockLogger = createLogger('devtools-lock')
const notificationLogger = createLogger('notification')
const windowMenuLogger = createLogger('window-menu')

/**
 * @@@5641 通知可用性的门。Linux 上先异步确认 `org.freedesktop.Notifications` 真的有属主,
 * 确认通过才允许调 `Notification.isSupported()` —— 后者是同步调用,服务不在线时会把主进程
 * 主线程冻住最长 120 秒。根因、真机读数与不这么做的理由见 linux-notification-service.ts。
 */
const notificationGate = createNotificationGate({
  platform: process.platform,
  isSupported: () => Notification.isSupported(),
  probe: async () => {
    const uid = process.getuid?.()
    if (uid === undefined) throw new Error('当前平台没有 uid,无法做 D-Bus EXTERNAL 认证')
    const socketPath = resolveSessionBusPath(process.env.DBUS_SESSION_BUS_ADDRESS, uid)
    if (socketPath === null) throw new Error('解析不出会话总线地址')
    return probeBusNameHasOwner({ name: NOTIFICATION_BUS_NAME, socketPath, uid, timeoutMs: PROBE_TIMEOUT_MS })
  },
  onUnavailable: (reason) =>
    notificationLogger.warn({ reason }, `[notification] 系统通知服务不可用,本次跳过: ${reason}`),
})
const deviceHeartbeatLogger = createLogger('device/heartbeat')
const assistantRetireLogger = createLogger('assistant/retire')
// ❌ 这里**不再**注册 uncaughtException / unhandledRejection:main.ts:1115/1120 早就有一对(@@@2125① 崩溃时
// 收引擎进程组),再注册一次 = 每次崩溃两行、两个 scope、两套措辞 —— 正是本 PR 要消灭的噪音。结构化日志接进
// 那对既有处理器里(见下方 @@@2125①)。
// pid 已在每行的 base 里,❌ 别再显式带一次(实测落盘那行出现两个 "pid" 键 —— 合法但脏,jq 只取后一个)
createLogger('process').info({ logFile: currentLogFile() }, '日志已就绪')
autonomyDebugLogger.info({ enabled: process.env.GUGU_DEBUG_AUTONOMY === '1' }, 'boot')
const processGoneLogger = createLogger('process-gone')
// GPU / 网络 / 工具进程异常退出:Chromium 自己会重启它们,但不记下来就没有证据 ——
// 2026-10-14 小鸟变成「坏画布」白块时,无从判断 GPU 那一侧当时出过什么事。正常收掉的、退出途中被收掉的不记。
app.on('child-process-gone', (_event, details) => {
  if (details.reason === 'clean-exit' || isQuitting) return
  processGoneLogger.warn(
    { type: details.type, reason: details.reason, exitCode: details.exitCode, name: details.name, serviceName: details.serviceName },
    '子进程异常退出',
  )
})
// @@@tier-userdata - non-production tiers get a distinct default userData (→ distinct single-instance
// @@@yatu-cdp - opt-in Chrome DevTools Protocol port for Playwright-driven real-UI YATU. Off unless
// GUGU_DEBUG_PORT is set; must be appended before app is ready.
// @@@devtools-lock — 锁定态(生产包)下这个口子一律不开:CDP 端口一开,后面那几层守卫全部形同虚设,
// 任何人都能 attach 上来读页面、执行脚本。非生产 tier 保留原行为,YATU / e2e 照跑。
if (process.env.GUGU_DEBUG_PORT) {
  if (isDevtoolsLocked()) {
    // ❌ 不静默吞掉一个显式传进来的开关:排障的人会对着一个「设了却没生效」的端口白查半天。
    devtoolsLockLogger.warn(
      { port: process.env.GUGU_DEBUG_PORT },
      '装机包忽略 GUGU_DEBUG_PORT:CDP 端口在锁定态下一律不开',
    )
  } else {
    app.commandLine.appendSwitch('remote-debugging-port', process.env.GUGU_DEBUG_PORT)
  }
}
// #7199 语音笔记的实测 / e2e:用一段录音冒充麦克风(不碰这台电脑的真麦克风、不弹系统授权框)。只在开发包里认
// (装机包不论哪一档都不认,与 voice-notes.ts 的授权判定同一道)。开关同样要在 app ready 前追加。
if (process.env.GUGU_FAKE_MICROPHONE_FILE?.trim() && !app.isPackaged) {
  app.commandLine.appendSwitch('use-fake-device-for-media-stream')
  app.commandLine.appendSwitch('use-file-for-fake-audio-capture', process.env.GUGU_FAKE_MICROPHONE_FILE.trim())
  // 音频服务的沙箱不让它读那个文件(「Failed to read … as input」,读出来全是静音)。
  app.commandLine.appendSwitch('disable-features', 'AudioServiceSandbox')
}
// @@@5637 Linux 桌面钉死「有鼠标、能 hover」:Chromium 在 VNC / 无 xinput 鼠标的 X11 桌面上会把指针判成
// pointer:none,Tailwind 的整块 hover 样式随之失效(置顶 / 归档等 hover 浮出按钮全灭)。command-line
// 开关必须在 app ready 前追加,所以与上面的 CDP 端口放在一起。细节与真机读数见 linux-pointer-media.ts。
pinDesktopPointerMedia(app.commandLine)
// @@@win-overlay-scrollbar Windows 上让 Chromium 画悬浮滚动条(会话页树的 scrollbar-width: thin 默认是常驻带箭头的 10px 经典条)。
// 同样必须在 app ready 前追加;`enable-features` 只在这一处写,细节见 windows-overlay-scrollbars.ts。
enableOverlayScrollbars(app.commandLine)
forwardWindowSeen()
// @@@devtools-lock — 必须在任何窗口创建之前注册 'web-contents-created',否则主窗口漏在守卫外面。
installDevtoolsLock((url) => {
  // 走到这里说明前面几层漏了 —— 这是要查的 bug,不是正常态,所以留证不静默。
  devtoolsLockLogger.error({ url }, 'DevTools 在锁定态下被打开,已强制关闭')
})
registerContentContextMenus(ipcMain)
registerFileViewerMenus(app, () => currentHostCatalog().fileViewerMenu, (error) => {
  processGoneLogger.error({ error: String(error) }, 'Content context menu failed')
}, (host) => isOwnPage(host.getURL(), mainWindow?.webContents.getURL() ?? ''))
// @@@gugu-tier - inlined at build time by vite (define in vite.config.mts), default 'production'.
declare const __GUGU_TIER__: string
declare const __GUGU_BUILD_DISTRIBUTION__: string
// 给别的机器装哪条通道的 server,构建时按连的库定(vite.config.mts → scripts/build-env-preflight.mjs serverChannelForDb)。
declare const __GUGU_SERVER_CHANNEL__: 'stable' | 'beta'

// @@@home-unify - one account home shared by desktop, CLI, and runtime host. The DEFAULT instance's
if (!process.env.GUGU_HOME) {
  if (userDataDir) {
    process.env.GUGU_HOME = join(app.getPath('userData'), 'gugu-home')
  } else {
    const home =
      __GUGU_TIER__ === 'production'
        ? resolveGuguHome(process.env)
        : join(homedir(), `.gugu-${__GUGU_TIER__}`)
    const legacy = join(app.getPath('userData'), 'gugu-home')
    if (legacy !== home && existsSync(legacy) && !existsSync(home)) {
      mkdirSync(dirname(home), { recursive: true })
      renameSync(legacy, home)
    }
    process.env.GUGU_HOME = home
  }
}
// @@@tmux-socket-isolation - Gugu must not share tmux's default socket with a user's own Homebrew tmux
if (!process.env.GUGU_TMUX_SOCKET_LABEL) {
  process.env.GUGU_TMUX_SOCKET_LABEL = __GUGU_TIER__ === 'production' ? 'gugu' : `gugu-${__GUGU_TIER__}`
}
// @@@spawn-tmux-bin - Prefer the self-contained tmux built by build:tmux in both packaged
// and source-launched app instances. Source-launched Electron does not inherit the user's
// login PATH, so relying on a bare `tmux` silently disables the setting on macOS/Windows.
// 与上面的套接字一样在模块加载时就定:每个问 tmux 的人(开机清扫、收残、接回)读到的都是同一个 tmux(#6992)。
if (!process.env.GUGU_TMUX_BIN) {
  const bundledTmux = process.platform === 'win32'
    ? join(app.isPackaged ? process.resourcesPath : app.getAppPath(), 'psmux-bundle', 'tmux.exe')
    : join(app.isPackaged ? process.resourcesPath : app.getAppPath(), 'tmux-bundle', 'tmux')
  if (existsSync(bundledTmux)) {
    process.env.GUGU_TMUX_BIN = bundledTmux
    console.log(`[tmux] using bundled tmux: ${bundledTmux}`)
  }
}
// @@@tier-device-id (#523) - surface the build-time tier to core so deviceRuntime.resolveTier can fold
// it into the device_id; prod + beta on one machine then register as distinct devices. Default is
// 'production' (see vite define), which resolveTier maps to the legacy device_id hash.
if (!process.env.GUGU_TIER) {
  process.env.GUGU_TIER = __GUGU_TIER__
}
// @@@fleet-version (#663) - surface the running build's version to core the same way as GUGU_TIER:
// syncDeviceHeartbeat folds it into gugu_devices.capabilities.app_version so per-device build is
// queryable (devices pane + #966 DDL-window judgement). Additional-account hosts inherit via
// their {...process.env} spread. Unconditional (no `if (!...)` knob like GUGU_TIER): the reported
// version is ground truth of the running binary — a stray shell var must not spoof the fleet inventory.
process.env.GUGU_APP_VERSION = app.getVersion()
process.env.GUGU_BUILD_DISTRIBUTION = __GUGU_BUILD_DISTRIBUTION__
// ────────────────────────────────────────────────────────────────────────────

const hasSingleInstanceLock = app.requestSingleInstanceLock()
if (!hasSingleInstanceLock) {
  if (SERVER_MODE) {
    process.stderr.write(`[server] 这个数据目录上已经有一个咕咕 server 在跑(${app.getPath('userData')})\n`)
  }
  app.quit()
}

let mainWindow: BrowserWindow | null = null
let tray: Tray | null = null
let deviceRuntimeHost: DeviceRuntimeHost | null = null
// #113 这台机器的项目记到账号上(会话页后端 boot 之后才有)。
let deviceProjectsPublisher: DeviceProjectsPublisher | null = null
// @@@local-device-truth (#777) - retained so localDeviceId can resolve this machine's device id
// instead of returning null → misrouting. Same provider the host ticks with.
let authProvider: RuntimeAuthProvider | null = null
// server 模式下没有渲染进程可问:登录态由主进程持有,四处 `authProvider ??= …` 因此直接拿到它。
let serverAuth: ServerAuthProvider | null = null
if (SERVER_MODE) {
  serverAuth = createServerAuthProvider({
    supabaseUrl: getSupabaseUrl(),
    anonKey: getSupabaseAnonKey(),
    onAuthExpired: (message) => {
      // 登录态已清掉;这个账号的进程退出,守护进程看到它没有登录态就不再拉起(重新登录即恢复)。
      createLogger('server/auth').error({ message }, `登录已失效,需要重新登录:${SERVER_LOGIN_ACTION}`)
      setTimeout(() => process.kill(process.pid, 'SIGTERM'), 1_000)
    },
  })
  authProvider = serverAuth
}
// F33 渲染进程推来的会话(见下面 human-auth-session:write / clear)。桌面模式的 getAuth 平时就用它。
let pushedHumanAuth: PushedRuntimeAuth = undefined
/**
 * #7290 `app_install { device }` from another machine of the owner's (`fromDevice`), as this machine's App action: a part of
 * their folder's package, sent over the device channel (`package_part`); then that package, installed here as a folder
 * (`package_upload` + `package_digest` → `install_folder_package`, only from the bytes of that digest); or a card, by its
 * message.
 */
function appInstallFrom(fromDevice: string, action: Record<string, unknown>): Record<string, unknown> {
  const { package_part: part, package_upload: upload, package_digest: digest, action: _app, device: _device, ...rest } = action
  if (part !== undefined) return { ...(part as Record<string, unknown>), action: 'receive_package_part', from_device: fromDevice }
  if (upload !== undefined || digest !== undefined) return { ...rest, action: 'install_folder_package', from_device: fromDevice, upload_id: upload, digest }
  return { ...action, action: 'install_attachment' }
}

function desktopAuthProvider(): RuntimeAuthProvider {
  return (authProvider ??= createPushedRuntimeAuthProvider(() => pushedHumanAuth))
}
bindElectronSupabaseAuth(async (forceRefresh) =>
  (await desktopAuthProvider().getAuth({ forceRefresh }))?.accessToken ?? null)
let primaryGuguMcpHost: DesktopGuguMcpHost | null = null

function hasPersistedMcpGrants(name: string): boolean {
  return persistedMcpGrantCount(app.getPath('userData'), name) > 0
}

/** #6264 咕咕 MCP / 集成转发口活过宿主进程重启(见 stable-mcp-persistence.ts);唤醒走「投递唤醒」同一个入口。 */
function stableMcpPersistence(name: string): GuguMcpHostPersistence {
  const logger = createLogger('stable-endpoint')
  return createStableMcpPersistence({
    name,
    dataDir: app.getPath('userData'),
    ready: () => sessionpageAgentRehydration.catch(() => undefined),
    quitting: () => isQuitting,
    wake: async (sessionId) => {
      const emdash = loadEmdashBridge()
      if (!emdash) throw new Error('session-page session lifecycle is unavailable')
      await emdash.ensureEmdashSession(sessionId)
    },
    log: {
      info: (message, fields) => logger.info(fields ?? {}, message),
      warn: (message, fields) => logger.warn(fields ?? {}, message),
    },
  })
}
let integrationMcpHost: IntegrationMcpHost | null = null

/**
 * 这条会话该带哪些**已连接集成**的 MCP server。
 *
 * 集成 ≠ MCP:十二家里只有走托管 MCP 授权的那几家能这样递(见 session-integrations)。
 * 递过去的地址是咕咕自己的转发口,❌ 不是对方的地址加用户令牌 —— 理由见 integration-mcp-bridge。
 *
 * 一家都没连 ⇒ 空数组,会话照旧;取不到身份也只是不带,❌ 不把会话拖死:agent 少一台 server
 * 是能用的,起不来是不能用的。
 */
async function integrationMcpServersFor(grantKey: string, subjectId: string): Promise<AcpMcpServer[]> {
  if (!authProvider) return []
  try {
    const entries = await connectedSessionIntegrations()
    // 一条会话到底带了哪几家,日志里要看得见 —— 「没带」和「带了但对方连不上」是两个不同的故障,
    // 没有这一行就只剩 agent 那句「没有 Linear 工具」,指不到成因。
    integrationMcpLogger.info(
      { grantKey, integrations: entries.map((entry) => entry.integrationId) },
      'integrations available to this session',
    )
    if (entries.length === 0) return []
    const { userId } = await requireRuntimeAuth(authProvider, 'gugu integration MCP bridge')
    integrationMcpHost ??= createIntegrationMcpHost(stableMcpPersistence('integration-mcp'))
    return await buildIntegrationBridge(integrationMcpHost, grantKey, userId, subjectId, entries)
  } catch (error) {
    integrationMcpLogger.warn(
      { error: (error as Error).message },
      'integration MCP bridge skipped for this session',
    )
    return []
  }
}
let extensionGatewayHost: ExtensionGatewayHost | null = null

/** #6615 扩展网关:会话经它调 main 托管的扩展程序。 */
function getExtensionGatewayHost(): ExtensionGatewayHost {
  return (extensionGatewayHost ??= createExtensionGatewayHost(() => {
    const emdash = loadEmdashBridge()
    if (!emdash) throw new Error('session-page extensions are unavailable')
    return emdash.emdashExtensionPrograms()
  }, stableMcpPersistence('extension-gateway'), { sessionContext: extensionCallerSessionContext }))
}

/** #6615 问题 11 The caller's task and working copy, stamped into every extension program call's `_meta`. */
function extensionCallerSessionContext(agentId: string) {
  const emdash = loadEmdashBridge()
  if (!emdash) throw new Error('session-page extensions are unavailable')
  return emdash.emdashAgentSessionContext(agentId)
}

/** #6634 问题 14 app_* for one session-page session: a relative folder its agent passes is taken from its working copy. */
function extensionActionsFor(sessionId: string) {
  return (action: unknown, signal?: AbortSignal) => emdashBridge!.runEmdashExtensionAction(action, {
    sessionId: sessionId,
    ...(signal ? { signal } : {}),
    workspaceRoot: async () => (await extensionCallerSessionContext(sessionId))?.workspaceRoot ?? null,
    hasApp: (extensionId) => inScopeOf(sessionpageSurfaceKey(sessionId), extensionId),
  })
}
let sessionpageLocalDelivery: SessionpageLocalDeliveryRouter | null = null
// 开机重注册那一份 promise。一开始就**挂着**,boot 开始那一刻(见 `bootEmdashModule` 之后)接上真正的那一份:
// 开机期间进来的投递、重启前那些卡的认回都等它,❌ 在它真开始之前就当成「已就绪」放过去。
let startSessionpageAgentRehydration!: (rehydration: Promise<void>) => void
let sessionpageAgentRehydration: Promise<void> = new Promise<void>((resolve, reject) => {
  startSessionpageAgentRehydration = (rehydration) => rehydration.then(resolve, reject)
})
void sessionpageAgentRehydration.catch(() => undefined)
let isQuitting = false
let hostLocaleStore: HostLocaleStore | null = null

function getSessionpageLocalDelivery(): SessionpageLocalDeliveryRouter {
  // spec session-injection「认领者是注册表」:targets 来自注册表(内核角色由 owner-registry 登记,
  // 各家原生认领者在自己的模块里自注册)—— 这里不再手拼每家一行。
  return (sessionpageLocalDelivery ??= new SessionpageLocalDeliveryRouter(sessionpageDeliveryTargets(), {
    waitUntilReady: () => sessionpageAgentRehydration,
    archivalState: (sessionId) => loadEmdashBridge()?.emdashSessionArchivalState(sessionId) ?? null,
    messageRefused: (sessionId, messageId, createdAt) => loadEmdashBridge()?.emdashSessionMessageRefused(sessionId, messageId, createdAt) ?? false,
    wakeSession: async (sessionId) => {
      if (isQuitting) throw new Error('session-page host is shutting down; cannot wake a session')
      const emdash = loadEmdashBridge()
      if (!emdash) throw new Error('session-page session lifecycle is unavailable')
      await emdash.ensureEmdashSession(sessionId)
    },
    // 引擎进程还在跑 = 唤醒什么也起不了(唯一事实在会话页 bundle 的 session-process)。桥没加载 = 没有进程。
    processRunning: (sessionId) => loadEmdashBridge()?.sessionProcess(sessionId) != null,
    onWakeComplete: (agentUserId) => kickInboxForAgent(agentUserId, 'wake-complete'),
  }))
}

function createDeviceSessionpageBridge() {
  const bridge = createSessionpageDeliveryBridge(getSessionpageLocalDelivery(), {
    stopAgent: stopSessionpageAgent,
    retireAgent: retireSessionpageAgent,
    ensureSessionReady: ensureSessionpageSessionReady,
    providerSessionIdForSession,
    applyAgentModelSelection: applyAgentModelSelectionOnDevice,
    // #6264 远端建 agent:目标机器(比如刚装好的咕咕 server)还没装这个 agent 时先装上,再进启动预算。
    ensureAgentInstalled: async (agentType, signal) => {
      const emdash = loadEmdashBridge()
      if (!emdash) throw new Error('session-page agent session runtime is unavailable')
      await emdash.ensureSessionpageAgentInstalled(agentType, signal)
    },
    startAgentSession: async (input) => {
      // #4181 —— bridge 段测点：claim→embedded 入口之间曾静默挂死（mac1 实测 begin 日志缺席），
      // 三个 await 各落一行，挂点自己报名。
      const bridgeLog = createLogger('sessionpage/agent-session-bridge')
      const bridgeStartedAt = Date.now()
      const bmark = (stage: string) =>
        bridgeLog.info({ agentUserId: input.agentUserId, stage, elapsedMs: Date.now() - bridgeStartedAt }, 'agent.create bridge stage — #4181')
      bmark('begin')
      const auth = await authProvider?.getAuth()
      if (!auth || auth.userId !== input.ownerUserId) {
        throw new Error(`session-page agent session owner mismatch for ${input.agentUserId}`)
      }
      bmark('auth-ok')
      const deviceId = await localDeviceId()
      if (!deviceId || deviceId !== input.deviceId) {
        throw new Error(`session-page agent session device mismatch for ${input.agentUserId}`)
      }
      bmark('device-resolved')
      const emdash = loadEmdashBridge()
      if (!emdash) throw new Error('session-page agent session runtime is unavailable')
      bmark('sessionpage-loaded')
      return emdash.startSessionpageAgentSession({
        agentUserId: input.agentUserId,
        displayName: input.displayName,
        agentType: input.agentType,
        projectPath: input.projectPath,
        chatId: input.chatId,
        initialText: input.initialText,
        initialPrompt: input.initialPrompt,
        initialMessageId: input.initialMessageId,
        initialChatPublicId: input.initialChatPublicId,
        initialChatKind: input.initialChatKind,
        specialFocus: input.specialFocus,
        avatar: input.avatar,
        model: input.model,
        effort: input.effort,
        permissionMode: input.permissionMode,
        childHarness: input.childHarness,
        signal: input.signal,
      }, async (session) => {
        const provisioned = await provisionSessionpageAgentForSession({
          sessionId: session.sessionId,
          providerId: session.providerId,
          surface: 'acp',
          cwd: session.projectPath,
          projectId: session.projectId,
          agentUserId: session.agentUserId,
          displayName: session.displayName,
          chatId: session.chatId,
        }, {
          getAuth: async () => ({
            accessToken: auth.accessToken,
            refreshToken: auth.refreshToken ?? '',
            userId: auth.userId,
          }),
          resolveDeviceId: async () => deviceId,
          resolveProjectName: (projectId: string) => emdash.emdashProjectName(projectId),
          takeBirthGroup: (sessionId: string) => emdash.emdashTakeBirthGroup(sessionId),
          provisionOneTrip: (input) => provisionSessionpageAgentOneTrip({ ...input, fetchImpl: electronFetch }),
          env: process.env,
        })
        if (!provisioned) throw new Error(`session-page agent session ${session.sessionId} has no addressable identity`)
        return {
          guguAgentUserId: provisioned.guguAgentUserId,
          chatId: provisioned.chatId,
          created: false,
        }
      })
    },
  })
  return {
    ...bridge,
    downloadAttachment: desktopFiles.download,
    fetchLocalSessionDirectInbox: async (agentUserId: string) => {
      // @@@4629 属主解析走认领者注册表 —— ❌ 别退回「查会话页 agent 注册表,查不到再查 local-session」:
      // 那两个是内核角色,promote 把 native 认领者(codex app-server / opencode serve-attach)扶正时正好
      // 会把它们摘掉,于是 pty 腿在这里恒为空手 —— `session_spawn` 的启动委托永远取不到,child 在
      // `waitForNextInjectedTurnLive` 上挂满 90s 后被补偿删除。
      // 认领基数暂时 >1 时 `sessionIdForAgent` 会 THROW —— 那是交接窗口里的**结构歧义**,
      // 由 router 判(prepare 装 blocker → await 旧认领者异步处置,这段窗口里两家同时在册)。
      // 它必须响亮,但❌ 不该顺手把这一轮的**云端**收件箱拉取也带走:那两件事没有关系。
      // ⇒ 在这一格收住并 loud log,本机投影这一轮空手,下一个触发重来。
      let sessionId: string | null = null
      try {
        sessionId = getSessionpageLocalDelivery().sessionIdForAgent(agentUserId)
      } catch (error) {
        createLogger('sessionpage/deliver').error(
          { agentUserId, err: error instanceof Error ? error.message : String(error) },
          '本机 session-direct 投影解析不出唯一属主(交接窗口的结构歧义):本轮不取本机行,云端拉取照常',
        )
        return []
      }
      // ⚠️ 下面三条都会「空手而归」，但原因完全不同，而空手对调用方长得一模一样：
      // 其中一条（本机没有待投的启动委托）正是 codex 全新会话僵满 90 秒的那个状态。
      // 分不出来就没法判是「没人投」还是「投了没取到」，所以逐条记名。
      if (!sessionId) {
        createLogger('sessionpage/deliver').warn(
          { agentUserId },
          '本机 session-direct 投影空手:这个 agent 还没有 live 的会话属主',
        )
        return []
      }
      const emdash = loadEmdashBridge()
      if (!emdash) {
        createLogger('sessionpage/deliver').warn(
          { agentUserId, sessionId },
          '本机 session-direct 投影空手:任务页运行时没装载',
        )
        return []
      }
      const pending = emdash.listPendingSessionDirectMessages(sessionId)
      if (pending.length === 0) {
        createLogger('sessionpage/deliver').debug(
          { agentUserId, sessionId },
          '本机 session-direct 投影空手:这条会话没有待投的启动委托',
        )
      }
      return pending.map((message) => ({
        chatId: `local-session:${sessionId}`,
        chatKind: 'dm' as const,
        chatPublicId: null,
        chatName: null,
        chatCreatorUserId: null,
        listenMode: 'active',
        notificationLevel: 'all',
        lastReadSeq: 0,
        id: message.id,
        seq: message.seq,
        senderUserId: agentUserId,
        senderType: 'agent',
        senderDisplayName: null,
        senderGuguNumber: null,
        content: '',
        contentType: 'text',
        toUserIds: [agentUserId],
        isWhisper: true,
        replyToMessageId: null,
        replyToSenderUserId: null,
        replyToContent: null,
        threadRootId: null,
        isThreadRoot: false,
        createdAt: new Date().toISOString(),
        localSessionDirect: { sessionId, envelope: message.text },
      }))
    },
    markLocalSessionDirectRead: async ({ sessionId, messageId }: { agentUserId: string; sessionId: string; messageId: string }) => {
      const emdash = loadEmdashBridge()
      if (!emdash) throw new Error('session-page session runtime is unavailable')
      emdash.acceptPendingSessionDirectMessage(sessionId, messageId)
    },
  }
}

async function disposeSessionpageAgentFromRoster(agent: {
  gugu_user_id: string | null
  cache?: Record<string, unknown> | null
}): Promise<void> {
  if (!agent.gugu_user_id) return
  const projectId = cacheString(agent.cache, PROJECT_CACHE_KEY)
  const sessionId = cacheString(agent.cache, SESSION_CACHE_KEY)
  if (!projectId || !sessionId) return
  const emdash = loadEmdashBridge()
  if (!emdash) return
  await emdash.disposeSessionpageAgentSession({ projectId, sessionId })
}

/**
 * 收回发给这个 agent 身份的每一张 gugu MCP 卡(三个 host)。身份没了,卡就跟着作废:不撤的话,这条会话下次以新身份
 * 要卡时,撞上 grant 里「同主人改 subject」的检查,点几次重试都一样。两处用它:#6938 云端已经没有这个 agent;
 * 第 19 条开户失败撤掉的身份,在那条会话下一次铸身份时(emdash-agent-provisioning)。
 */
async function revokeAgentCards(agentUserId: string): Promise<void> {
  await Promise.all([primaryGuguMcpHost, integrationMcpHost, extensionGatewayHost].map((host) => host?.revokeSubject(agentUserId)))
}

/**
 * 设备 runtime 删掉了名册上的一行(主账号与附加账号的宿主同用这一个)。
 * `owner-change`:换账号时归属未知的老行,连会话一起拆(原样)。
 * `cloud-gone`(#6938):云端已经没有这个 agent —— 只收回发给它的卡,❌ 不拆会话(会话是用户的工作,#4526)。
 * 会话下一次起来以新身份要卡;旧卡不撤,那一次就撞上 grant 里「同主人改 subject」的检查,点几次重试都一样。
 */
async function onLocalAgentRosterRemoved(
  agent: { gugu_user_id: string | null; cache?: Record<string, unknown> | null },
  reason: AgentRosterRemovalReason,
): Promise<void> {
  const agentUserId = agent.gugu_user_id
  if (!agentUserId) return
  if (reason === 'cloud-gone') {
    await revokeAgentCards(agentUserId)
    return
  }
  unregisterSessionpageDeliveryOwners(agentUserId)
  await disposeSessionpageAgentFromRoster(agent)
}

type AppNotification = {
  title: string
  body: string
  chatId: string | null
  createdAt: string
  displayed: boolean
}

// #7199 快速聊天(全局快捷键叫出和个人助理聊天的小窗):第一次建主窗时装上,一个进程一份。
let quickChat: QuickChat | null = null

function focusMainWindow(): void {
  if (!mainWindow || mainWindow.isDestroyed()) return
  if (mainWindow.isMinimized()) mainWindow.restore()
  if (!mainWindow.isVisible()) mainWindow.show()
  mainWindow.focus()
}

function currentHostCatalog(): HostCatalog {
  if (!hostLocaleStore) throw new Error('HOST_LOCALE_NOT_INITIALIZED')
  return hostCatalog(hostLocaleStore.current())
}

function trayIconPath(): string {
  const dir = join(app.getAppPath(), 'build-resources')
  if (process.platform === 'darwin') return join(dir, 'tray-iconTemplate.png')
  const tone = nativeTheme.shouldUseDarkColors ? 'dark' : 'light'
  const ext = process.platform === 'win32' ? 'ico' : 'png'
  return join(dir, `tray-icon-${tone}.${ext}`)
}

function loadTrayIcon(): ReturnType<typeof nativeImage.createFromPath> {
  const iconPath = trayIconPath()
  const icon = nativeImage.createFromPath(iconPath)
  if (icon.isEmpty()) throw new Error(`TRAY_ICON_MISSING: ${iconPath}`)
  return icon
}

function buildTrayMenu(): Menu {
  const labels = currentHostCatalog().tray
  return Menu.buildFromTemplate([
    {
      label: labels.show,
      click: () => focusMainWindow(),
    },
    { type: 'separator' },
    {
      label: labels.quit,
      click: () => {
        isQuitting = true
        app.quit()
      },
    },
  ])
}

function refreshTrayChrome(): void {
  if (!tray) return
  tray.setToolTip(currentHostCatalog().tray.tooltip)
  // owner 2026-09-05 定调:托盘就是系统原生菜单「打开 / 退出」,左右键都弹它;❌ 自定义面板窗口(做过两版都被砍)。
  tray.setContextMenu(buildTrayMenu())
}

/**
 * @@@5295 托盘数字角标（参考微信）。
 *
 * 角标数 = **未读聊天消息**,与会话列表上那些未读数(免打扰的除外)逐条对得上账。
 * ❌ 别再把会话页的「做完未读」加进来(#6433,owner 2026-09-24「我们只算消息聊天未读消息吧」):
 * agent 被聊天消息唤醒、回完话,同一件事在聊天侧已经算过一次;任务侧那个数在应用里又没有
 * 任何一处显示总数 ⇒ 角标就成了一个用户对不上账、只涨不落的数。
 */
let unreadChatMessages = 0
let trayBadgeEnabled = true

function applyUnreadBadge(): void {
  const total = trayBadgeEnabled ? unreadChatMessages : 0
  const label = formatBadgeCount(total)

  if (process.platform === 'darwin') {
    // 菜单栏图标是 template 图(单色,系统按明暗自己反相),往里画红块会被压成黑方块 ⇒
    // mac 用原生的 setTitle 在图标旁写文本。Dock 角标照旧走 app.setBadgeCount。
    app.setBadgeCount(total)
    tray?.setTitle(label)
    return
  }
  tray?.setImage(badgedTrayIcon(total))
  if (process.platform === 'win32' && mainWindow && !mainWindow.isDestroyed()) {
    // 任务栏 overlay:Windows 上用户多数时间看的是任务栏而不是托盘区。
    // ⚠️ 喂进去的必须是**只有角标**的图 —— overlay 是叠在应用图标上的,喂托盘图进去
    // 任务栏上就是两只鸟拼在一起(#5929,owner 实机照片 + win-dev 复现)。见 tray-badge.ts。
    mainWindow.setOverlayIcon(label ? overlayBadgeIcon(label) : null, label || '')
  }
}

/** 任务栏 overlay 图:透明底 + 红圆角标,❌ 不含咕咕鸟(它已经是任务栏按钮的底图了)。 */
function overlayBadgeIcon(label: string): ReturnType<typeof nativeImage.createFromBitmap> {
  const size = OVERLAY_BADGE_SIZE
  return nativeImage.createFromBitmap(buildOverlayBadgeBitmap(label, size), {
    width: size,
    height: size,
  })
}

/** 把角标画进托盘图标。0 时原样返回底图 —— 干净退回,❌ 不留一个画着 0 的圈。 */
function badgedTrayIcon(count: number): ReturnType<typeof nativeImage.createFromPath> {
  const base = loadTrayIcon()
  const label = formatBadgeCount(count)
  if (!label) return base
  const { width, height } = base.getSize()
  if (width === 0 || height === 0) return base
  const bitmap = base.toBitmap()
  paintBadgeOnBitmap(bitmap, width, height, label)
  return nativeImage.createFromBitmap(bitmap, { width, height })
}

/**
 * @@@5301 把当下的语言推给会话页那一侧:agent 通知的文案,和语言本身(App 名字按它挑,host-locale.ts)。
 * 启动时推一次、语言切换时再推一次 —— 会话页自己够不到宿主的语言 store(跨界只会拿到复制品)。
 */
function publishSessionHostLocale(): void {
  if (!emdashBridge || !hostLocaleStore) return
  emdashBridge.setSessionAgentNotificationCopy(currentHostCatalog().sessionAgentNotifications)
  emdashBridge.setSessionHostLocale(hostLocaleStore.current())
}

function publishWindowChromeLabels(): void {
  mainWindow?.webContents.send(
    'window-chrome:labels-changed',
    currentHostCatalog().windowChrome,
  )
}

/** 应用菜单跟着宿主语言走(「设置…」是自己的字,换语言要重装一次)。 */
function refreshApplicationMenu(): void {
  applyApplicationMenu({
    locked: isDevtoolsLocked(),
    settingsLabel: currentHostCatalog().appMenu.settings,
    // 设置是会话页那边的弹窗(product spec):主窗收在托盘里也先拉出来,再叫它打开。
    openSettings: () => {
      if (!mainWindow || mainWindow.isDestroyed()) return
      focusMainWindow()
      mainWindow.webContents.send(menuOpenSettingsChannel.name)
    },
  })
}

function syncResolvedHostLocale(value: unknown): void {
  if (!hostLocaleStore) throw new Error('HOST_LOCALE_NOT_INITIALIZED')
  const before = hostLocaleStore.current()
  hostLocaleStore.syncResolvedLocale(value)
  refreshTrayChrome()
  refreshApplicationMenu()
  publishSessionHostLocale()
  publishWindowChromeLabels()
  if (hostLocaleStore.current() !== before) tellHostPresentationChanged()
}

function currentHostLocale(): string {
  if (!hostLocaleStore) throw new Error('HOST_LOCALE_NOT_INITIALIZED')
  return hostLocaleStore.current()
}

// 语言与色调是宿主自己的记录(HostLocaleStore、windowTone),App 的上下文从这里读;变了告诉会话页那一侧。
const hostPresentationListeners = new Set<() => void>()
function tellHostPresentationChanged(): void {
  for (const listener of hostPresentationListeners) listener()
}

// @@@close-to-tray-hint - close hides the window to the tray instead of quitting; without a signal users
// think the app vanished. Notify the FIRST time only, persisting the flag in app-state.json under userData.
function appStatePath(): string {
  return join(app.getPath('userData'), 'app-state.json')
}

function readAppState(): Record<string, unknown> {
  const path = appStatePath()
  if (!existsSync(path)) return {}
  return JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>
}

function writeAppState(state: Record<string, unknown>): void {
  writeFileSync(appStatePath(), JSON.stringify(state), 'utf8')
}

/**
 * @@@window-tone — 无边框窗口(Windows/Linux)在网页内容画出来之前露出来的那块底色。
 *
 * 从前这里写死 `#111114`(深色),而**咕咕的默认主题是浅色**(见 index.html 的引导脚本与
 * `session/renderer/lib/theme/host-theme.ts` 的 `DEFAULT_PREFERENCE = 'light'`)⇒ 浅色用户每次
 * 启动、每次拖动窗口都会看到一块与产品无关的深色。mac 那支走 vibrancy,没有这个问题 ——
 * 于是这成了一条只在 Windows/Linux 上存在的差异。
 *
 * 真值在渲染层(`<html data-theme>` 是它的唯一写入者),主进程**问不到**,所以:
 * 建窗时用上次记住的色调(首次启动 = 产品默认的浅色),渲染层一落属性就同步过来改写并记住。
 * ❌ 别拿 `nativeTheme.shouldUseDarkColors` 冒充它:那是系统外观,不是用户在咕咕里选的那一项。
 */
const WINDOW_TONE_BG = { light: '#ffffff', dark: '#111114' } as const
type WindowTone = keyof typeof WINDOW_TONE_BG

function readWindowTone(): WindowTone {
  const saved = readAppState().windowTone
  return saved === 'dark' ? 'dark' : 'light'
}

/**
 * @@@window-material (#7333) — mac 主窗材质可见时,窗口底色必须是透明的:不透明的窗口底色会把 vibrancy 整块盖住
 * (从前这里对所有窗口一律写主题色,mac 主窗的材质因此从来没露出来过)。材质不可见(减弱透明度 / 增强对比度)
 * 或别的窗口,照旧写主题色。⚠️ 透明底色对 vibrancy 的实际效果要 Mac 真机核。
 */
let windowMaterial: WindowMaterialHost | null = null
function windowBackgroundFor(win: BrowserWindow, tone: WindowTone): string {
  return win === mainWindow && windowMaterial?.current() === 'native' ? '#00000000' : WINDOW_TONE_BG[tone]
}

function syncWindowTone(value: unknown): void {
  const tone: WindowTone = value === 'dark' ? 'dark' : 'light'
  if (readWindowTone() !== tone) {
    writeAppState({ ...readAppState(), windowTone: tone })
    tellHostPresentationChanged()
  }
  for (const win of BrowserWindow.getAllWindows()) win.setBackgroundColor(windowBackgroundFor(win, tone))
}

async function maybeShowCloseToTrayHint(): Promise<void> {
  if (IS_TEST_MODE || !(await notificationGate.usable())) return
  const state = readAppState()
  if (state.closeToTrayHintShown === true) return
  const message = currentHostCatalog().notifications.closeToTray
  const hint = new Notification({
    title: message.title,
    body: message.body,
  })
  // @@@5301 系统拒了要留痕。❌ 别再 fire-and-forget —— 这条不弹时以前连日志都没有。
  hint.once('failed', (_event, error) => {
    notificationLogger.warn({ error: String(error) }, `[notification] close-to-tray 提示被系统拒绝: ${error}`)
  })
  hint.show()
  writeAppState({ ...state, closeToTrayHintShown: true })
}

// @@@auth-expired-notification - the device runtime host raises this exactly once when its auth is
async function showAuthExpiredNotification(message: string): Promise<void> {
  console.warn(message)
  if (IS_TEST_MODE || !(await notificationGate.usable())) return
  const copy = currentHostCatalog().notifications.authExpired
  const notification = new Notification({
    title: copy.title,
    body: copy.body,
  })
  notification.once('failed', (_event, error) => {
    notificationLogger.warn({ error: String(error) }, `[notification] 登录过期提示被系统拒绝: ${error}`)
  })
  notification.show()
}

// @@@6295 界面是否已开始加载 —— 启动链失败时「还有没有可挽救的界面」只看它:启动链开头就建了一个**隐藏、
// 未加载**的主窗口(见 createWindow(false)),窗口在 ≠ 用户看得见。
let mainWindowContentsRequested = false

function loadMainWindowContents(): void {
  if (!mainWindow || mainWindow.isDestroyed()) return
  mainWindowContentsRequested = true
  // In dev mode, vite-plugin-electron sets VITE_DEV_SERVER_URL
  if (process.env.VITE_DEV_SERVER_URL) {
    mainWindow.loadURL(process.env.VITE_DEV_SERVER_URL)
    if (!IS_TEST_MODE && process.env.GUGU_DEVTOOLS === '1') {
      mainWindow.webContents.openDevTools()
    }
  } else {
    // @@@gugu-app-scheme - 生产从自定义协议加载(见 registerSchemesAsPrivileged 注释);
    // renderer output 打包在 app root 的 dist/,由 whenReady 里的 protocol.handle 供给。
    mainWindow.loadURL('gugu-app://app/index.html')
  }
}

/**
 * @@@touchid-passkey 内置浏览器的 Touch ID 通行密钥(前提与边界见 macWebAuthn.ts 头注释)。只在包里嵌着描述文件时打开;
 * 要在界面语言定下之后调用 —— 系统指纹框里那句「正在尝试…」用的是它。
 */
function enableMacTouchIdPasskeys(): void {
  if (process.platform !== 'darwin' || !app.isPackaged) return
  const logger = createLogger('webauthn')
  const profilePath = join(dirname(process.execPath), '..', 'embedded.provisionprofile')
  // 描述文件是 CMS 包着的 plist,按 latin1 读,里面那段 XML 原样可见(只取 ASCII 的应用 ID)。
  const keychainAccessGroup = webAuthnKeychainGroup(existsSync(profilePath) ? readFileSync(profilePath, 'latin1') : null)
  if (!keychainAccessGroup) {
    logger.info('包里没有嵌描述文件(开发版 / 验收包 / ad-hoc 包),不开 Touch ID 通行密钥')
    return
  }
  // 指纹框里那句交给系统后就定了,改界面语言要下次启动才跟上;选账号的对话框每次弹时现取(见下)。
  app.configureWebAuthn({ touchID: { keychainAccessGroup, promptReason: currentHostCatalog().webAuthn.touchIdReason } })
  logger.info({ keychainAccessGroup }, 'Touch ID 通行密钥已开')

  // 同一网站存着多把:不接这个事件,请求就被当成取消(恰好回调一次、看不见就不问,见 createSelectAccountHandler)。
  // 事件挂在 session 上,而内置浏览器每个档案一个 session、用到才建 ⇒ 默认那个现在挂,之后建的在 session-created 里挂。
  const handle = createSelectAccountHandler<BrowserWindow, Electron.WebFrameMain>({
    parentFor: (frame) => {
      const contents = frame ? webContents.fromFrame(frame) : undefined
      if (!contents || contents.isDestroyed()) return null
      // 内置浏览器的网页是摆在咕咕窗口上(或停在看不见的停放窗里)的 view ⇒ 由会话页说它此刻露在哪扇窗上;
      // 其余网页(咕咕自己的窗口)就是拥有它的那扇窗。
      const page = loadEmdashBridge()?.emdashVisibleHostOfPage(contents)
      if (page !== undefined) return page
      const owner = BrowserWindow.fromWebContents(contents)
      return owner && !owner.isDestroyed() && owner.isVisible() && !owner.isMinimized() ? owner : null
    },
    copy: () => currentHostCatalog().webAuthn.chooseAccount,
    ask: async (parent, options) => (await dialog.showMessageBox(parent, { type: 'question', ...options, defaultId: 0 })).response,
    warn: (message, error) => logger.warn({ err: error }, message),
  })
  const onSelectAccount = (
    _event: Electron.Event,
    details: Electron.SelectWebauthnAccountDetails,
    callback: (credentialId?: string | null) => void,
  ): void => handle(details, callback)
  session.defaultSession.on('select-webauthn-account', onSelectAccount)
  app.on('session-created', (created) => created.on('select-webauthn-account', onSelectAccount))
}

/**
 * 连着崩到上限:当面问 —— 重新载入还是退出。窗口可能正收在托盘里,先让它露面:
 * ❌ 把对话框挂在看不见的窗口上,那等于没问,本机 agent 的令牌也一直签不出来。
 */
async function askAfterRepeatedRendererCrashes(count: number): Promise<CrashDialogChoice> {
  if (!mainWindow || mainWindow.isDestroyed()) return 'no-window'
  mainWindow.show()
  mainWindow.focus()
  const copy = currentHostCatalog().rendererCrash
  const { response } = await dialog.showMessageBox(mainWindow, {
    type: 'error',
    message: copy.title,
    detail: copy.detail.replace('{count}', String(count)),
    buttons: [copy.reload, copy.quit],
    defaultId: 0,
    // 退出会停掉所有本机 agent,必须明确点它 ⇒ ❌ 让 Esc 落到「退出」(不传 cancelId 时 Electron 44 就这么配:
    // dialog.ts 里 defaultId=0 ⇒ cancelId=1)。也 ❌ cancelId=0:mac 上它把默认按钮的回车换成 Esc,
    // 那颗按钮就不再是默认的,被排到左边,右边那颗主按钮变成「退出」(message_box_mac.mm;实测点右边 = 退出)。
    // -1 = 不绑 Esc:mac 上 Esc 什么都不做;Windows / Linux 关掉对话框回 -1,下面按「重新载入」算。
    cancelId: -1,
  })
  return response === 1 ? 'quit' : 'reload'
}

// 主窗口渲染进程没了:说出来并重新载入,连着崩就停下来当面问(renderer-crash-recovery.ts)。
const handleMainRendererGone = createMainRendererGoneHandler({
  isQuitting: () => isQuitting,
  now: () => Date.now(),
  reload: () => loadMainWindowContents(),
  ask: askAfterRepeatedRendererCrashes,
  quit: () => {
    isQuitting = true
    app.quit()
  },
  log: processGoneLogger,
})
const mainRendererResponsiveness = createMainRendererResponsivenessLog({
  now: () => Date.now(),
  rendererPid: () => mainWindow?.webContents.getOSProcessId() ?? -1,
  gpuProcess: () => {
    const gpu = app.getAppMetrics().find((metric) => metric.type === 'GPU')
    return gpu ? { pid: gpu.pid, workingSetKb: gpu.memory.workingSetSize, cpuPercent: gpu.cpu.percentCPUUsage } : null
  },
  log: processGoneLogger,
})

function createWindow(loadContents = true): void {
  const { width: defaultWidth, height: defaultHeight } = mainWindowSize(screen.getPrimaryDisplay().workAreaSize)
  const winState = windowStateStore({ defaultWidth, defaultHeight })
  const display = winState.x == null || winState.y == null
    ? screen.getPrimaryDisplay()
    : screen.getDisplayMatching(winState)
  const isMac = process.platform === 'darwin'
  mainWindow = new BrowserWindow({
    x: winState.x,
    y: winState.y,
    ...mainWindowSize(display.workArea, winState),
    // @@@desktop-never-mobile (#3566): a small work area still uses the desktop shell.
    show: false,
    // @@@822 frameless 统一标题栏(跨平台一致): Mac 用 hiddenInset 保留原生交通灯并对齐 68px 导航栏
    //   ({x:5,y:14});三颗灯右侧留出少量呼吸。Windows/Linux 完全无边框(frame:false),
    //   由 renderer 的 <WindowControls> 自绘 min/max/close — 不再露原生 GTK/系统标题栏。
    //   (titleBarStyle:hiddenInset 仅 mac 生效;旧版无条件设 → Win/Linux 回落原生边框 = 本 issue 根因。)
    ...(isMac
      ? {
          titleBarStyle: 'hiddenInset' as const,
          trafficLightPosition: TRAFFIC_LIGHT_POSITION,
          vibrancy: 'sidebar' as const,
          visualEffectState: 'active' as const
        }
      : {
          frame: false,
          // @@@window-tone — 见上面那段:默认浅色,渲染层落 data-theme 后同步改写。
          backgroundColor: WINDOW_TONE_BG[readWindowTone()]
        }),
    // @@@devtools-lock — 锁定态下把 devTools 关到 Electron 层(openDevTools 直接不生效)。
    webPreferences: hardenWebPreferences({
      preload: join(__dirname, 'preload.js'),
      sandbox: false,
      contextIsolation: true,
      nodeIntegration: false,
      webviewTag: true,
      // @@@renderer-is-auth-server — the renderer is not just UI: it holds the Supabase session and the
      // main-process device-runtime gets owner tokens only from what it pushes (human-auth-session:write, refreshed
      // on the renderer's timers). Chromium's default backgroundThrottling pauses a hidden/occluded/
      // minimized renderer's timers+event loop → the refresh stalls, the pushed token expires → the runtime loses auth,
      // its agent_runtime_state writes RLS-fail as "not writable", and #1609 reaps (SIGTERMs) the live
      // codex. So the agent the user is actively talking to silently dies whenever the window isn't
      // foreground (minimize / occlude / headless test). The renderer must stay responsive regardless of
      // window visibility → never throttle it.
      backgroundThrottling: false,
      // @@@ui-zoom — 全局界面缩放因子。当聊天工具时 owner 实测取 110%（125% 偏大）；
      // 2026-07-21 owner 改把它当生产力工具用，要更高信息密度 → 收到 100%（默认 1.0）。
      // 应用级缩放，不动逐像素核对过的设计稿 px；Cmd/Ctrl +/- 仍可临时调（菜单自带 zoom roles）。
      // 注:已装机用户若之前 Cmd+ 调过、Chromium 会按 origin 持久化那个值 → 需 Cmd+0 归位到此默认。
      zoomFactor: 1.0
    })
  })

  // #7274 只在开窗那一次露面:Electron 在窗里的网页(会话浏览器页签,agent 在后台会话里打开 / 跳转网页时)画出第一帧
  // 时会再报一次 ready-to-show,`show()` 在 macOS 上会把整个咕咕拉到最前台 —— 人正在用的别的 App 就被抢走了(实测)。
  mainWindow.once('ready-to-show', () => {
    if (!IS_TEST_MODE) {
      mainWindow?.show()
    }
  })

  // 关窗就是收进托盘,只有 isQuitting 立起来才放行。
  // 托盘没建出来时,关窗就是退出。
  mainWindow.on('close', (e) => {
    const intercepted = !isQuitting && tray !== null
    // @@@5793 探针:更新那条路全靠这个 close 真的关得掉(Electron 关完所有窗口才调 app.quit())。
    // 上一轮只能从「进程没退」反推它被拦了,拿不到直接读数。留一行,下次快慢都一眼定位:
    // 没有这行 = 关窗事件根本没来(那就不是拦截的问题);有且 intercepted=false = 放行了。
    if (updateQuit.forUpdate) {
      updaterLogger.info({ intercepted, isQuitting }, '[updater] 主窗口收到关闭请求')
    }
    if (intercepted) {
      e.preventDefault()
      mainWindow?.hide()
      void maybeShowCloseToTrayHint()
    } else if (!isQuitting) {
      app.quit()
    }
  })
  winState.manage(mainWindow)

  // @@@ui-zoom — 强制把界面缩放钉到 100%。webPreferences.zoomFactor 只是「初始值」,一旦用户
  // Cmd+/- 调过、Chromium 会按 origin 持久化那个值并**覆盖** zoomFactor(经典 Electron 坑)——所以
  // 单改 zoomFactor 对「之前手动放大到 125% 的老用户」无效。这里在每次页面加载完成后显式 setZoomFactor(1)
  // 覆盖持久值,确保基准恒为 100%(owner 从聊天工具→生产力工具、要更高信息密度)。Cmd/Ctrl +/- 仍可
  // 会话内临时调,只是整窗重载/重启会回到 100%。
  mainWindow.webContents.on('did-finish-load', () => mainWindow?.webContents.setZoomFactor(1))
  // 页面正被导航换掉时报上来的「会话页资源没载入」不是资源坏了(sessionpage/fatal-boot.ts)。
  watchNavigations(mainWindow.webContents)
  mainWindow.webContents.on('render-process-gone', (_event, details) => {
    void handleMainRendererGone(details.reason, details.exitCode)
  })
  mainWindow.webContents.on('unresponsive', mainRendererResponsiveness.onUnresponsive)
  mainWindow.webContents.on('responsive', mainRendererResponsiveness.onResponsive)

  // @@@822 frameless: 向 renderer 同步最大化状态,自绘控制按钮据此切换 最大化/还原 图标。
  mainWindow.on('maximize', () => mainWindow?.webContents.send('window:maximized-changed', true))
  mainWindow.on('unmaximize', () => mainWindow?.webContents.send('window:maximized-changed', false))
  // 上面关了 backgroundThrottling,最小化、收进托盘时页面照样「看得见」、rAF 照跑:由这里告诉界面,小鸟据此停画。
  // macOS 实测遮挡不触发 windowSeen，最小化才触发；不能拿 show / hide 当遮挡检测。

  // window.open:咕咕子窗口(一块会话 / 一个 App 单独成窗、快速聊天小窗)放行,其余交给系统浏览器。
  quickChat ??= installQuickChat({ mainWindow: () => mainWindow, focusMain: focusMainWindow, supported: !SERVER_MODE })
  attachAuxWindows(mainWindow, () => WINDOW_TONE_BG[readWindowTone()], [quickChat.auxWindow, resourceMonitorWindow])

  setMainWindow(mainWindow)
  // A real sleep emits powerMonitor.resume, while a stopped process resumed by the OS/test
  // harness may only regain the foreground. Both signals represent the same user-visible wake
  // boundary, so feed focus through the existing wall-clock reconciliation path as well.
  mainWindow.on('focus', () => {
    const reconcile = reconcileSessionpagePlatformOnResume
    if (reconcile) {
      void reconcile().catch((error) => {
        createLogger('sessionpage/platform').error({ err: error }, '平台凭据前台恢复对账失败')
      })
    }
  })
  if (loadContents) loadMainWindowContents()
}

/**
 * #6264 账号主人在「设置 → 设备」里移除了这台 server:退出这个账号的登录、结束这个账号的进程。
 * 守护进程看到它没有登录态就不再拉起;这台机器上别的账号不受影响(各是各的设备行与进程)。
 */
function serverDeviceRemovedHandler(auth: ServerAuthProvider): (message: string) => void {
  return (message) => {
    createLogger('server/auth').warn({ message }, '这台机器已被账号主人从「设置 → 设备」移除,退出这个账号的登录')
    void auth.revokeAndSignOut()
      // 被移除 ≠ 退出登录:这个账号留在 tmux 里的 agent / 终端也要结束,❌ 在后台接着跑。
      .finally(() => killAccountTmuxServer(process.env))
      .finally(() => {
        setTimeout(() => process.kill(process.pid, 'SIGTERM'), 500)
      })
  }
}

/**
 * 主账号这台机器的设备 RPC 处理表:咕咕云频道(createDesktopDeviceRpcSubscription)与 SSH 设备连接
 * (server/device-link-host.ts)共用这一份 —— 两条通道只差字节走哪。
 */
function createPrimaryDeviceRpcHandlers(io?: { openTopicPublisher: OpenTopicPublisher }) {
  // 桥拿不到 = 会话页后端没起来 ⇒ 响亮失败。❌ 别退回一个空 handler 集:
  // 那会让手机端「正在读取会话…」永远转下去,而日志里一个字都没有。
  const bridge = loadEmdashBridge()
  if (!bridge) throw new Error('任务页桥未加载,设备 RPC 的会话处理器装不上')
  // MessagePreview(#6357)只挂咕咕云频道:它往 realtime topic 推,SSH 设备连接没有这条路。
  const base = bridge.createSessionpageSessionDeviceRpcHandlers(io ? { preview: messagePreviewHostDeps(io) } : undefined)
  // #7199 第二步:别的机器上的 agent 调这台电脑的单个动作(请执行 / 结果收到)。
  return { ...base, handlers: { ...base.handlers, ...assistantWorkDeliveryHost().rpcHandlers(), ...deviceActionsRuntime().rpcHandlers(), ...tunnelRpcHandlers(), ...desktopFiles.handlers(io ? 'realtime' : 'ssh') } }
}

let assistantWorkOutbox: AssistantWorkOutboxHost | null = null
function assistantWorkDeliveryHost(): AssistantWorkOutboxHost {
  if (assistantWorkOutbox) return assistantWorkOutbox
  const context = async () => {
    const lease = deviceRuntimeHost?.getRuntimeLease()
    const auth = await desktopAuthProvider().getAuth()
    if (!lease || !auth?.accessToken || lease.ownerId !== auth.userId) return null
    return { ...lease, client: makeIdentityClient(auth.accessToken) as unknown as AssistantWorkRpcClient }
  }
  let assistantCache: {ownerId:string;until:number;value:ReturnType<typeof pickAssistant>} | null = null
  const resolveAssistant = async (current:import('./assistant-work-outbox').AssistantWorkHostContext) => {
      if (assistantCache?.ownerId === current.ownerId && assistantCache.until > Date.now()) return assistantCache.value
      const auth = await desktopAuthProvider().getAuth()
      if (!auth?.accessToken || auth.userId !== current.ownerId) return null
      const {data,error} = await makeIdentityClient(auth.accessToken).from('agent_provisions').select('agent_user_id,device_id,member_key,phase,created_at')
        .eq('owner_user_id',current.ownerId).eq('member_key','assistant')
      if (error) throw error
      const value = pickAssistant((data ?? []) as AssistantProvisionRow[])
      assistantCache = {ownerId:current.ownerId,until:Date.now()+60000,value}
      return value
  }
  const reconciler = createDesktopAssistantWorkReconciler({
    context,assistant:async current=>{
      const value=await resolveAssistant(current)
      if(!value||value.deviceId!==current.deviceId) return null
      const target=await readSessionpageOpenTarget(value.agentId)
      return target?.sessionId ? {...value,sessionId:target.sessionId} : null
    },
    inspect: async (current, work, target) => {
      const bridge = loadEmdashBridge()
      if (!bridge) return null
      const coordinator=assistantWorkCoordinator(work)
      if (!coordinator) return null
      const caller: RemoteSessionCaller = {deviceId:current.deviceId,deviceLabel:null,sessionId:coordinator.session_id,
        agentUserId:current.assistantId,name:'个人助理',harness:null,transport:'acp',model:null,platformModel:null}
      const signal = AbortSignal.timeout(5000)
      if (target.device_id === current.deviceId) return bridge.runRemoteSessionAction(caller,{action:'get',session_id:target.session_id},signal) as Promise<import('@gugu/core/cloud/assistantWorkReconciliation').ExecutorDeliveryProof>
      const devices = await crossMachine().listDeviceRows()
      if (!devices.find(row => row.device_id === target.device_id)?.online) return null
      return crossMachine().runOnDevice(target.device_id,caller,{action:'get',session_id:target.session_id},signal) as Promise<import('@gugu/core/cloud/assistantWorkReconciliation').ExecutorDeliveryProof>
    },
    ownerReceipts: async (current,work,events) => {
      const pending=events.filter(event=>isOwnerReceiptEvent(event)&&event.assistant_admitted_at&&!event.owner_delivered_at)
      if(!pending.length) return []
      const bridge=loadEmdashBridge()
      const auth=await desktopAuthProvider().getAuth()
      if(!bridge||!auth?.accessToken||auth.userId!==current.ownerId) return []
      const coordinator=assistantWorkCoordinator(work)
      if(!coordinator) return []
      const chatId=await openOwnerDirectChatForAgent(current.assistantId,auth.accessToken,process.env)
      return bridge.readAssistantWorkOwnerReceipts(coordinator.session_id,pending,{chatId,ownerId:current.ownerId})
    },
    notify: async (current,key,text) => {
      const auth = await desktopAuthProvider().getAuth()
      if (!auth?.accessToken || auth.userId !== current.ownerId) throw new Error('Account changed')
      const chatId = await openOwnerDirectChatForAgent(current.assistantId,auth.accessToken,process.env)
      const {error} = await makeChatClient(auth.accessToken).rpc('send_message_idempotent',{
        p_message_id:key,p_chat_id:chatId,p_sender_user_id:current.assistantId,p_to_user_ids:[current.ownerId],p_content:text,p_content_type:'text',
        p_reply_to_message_id:null,p_thread_root_id:null,p_is_thread_root:false,p_is_whisper:false,
      })
      if (error) throw error
      return {chatId,messageId:key}
    },
    verifyOwnerPost: async (current,posted) => {
      const auth=await desktopAuthProvider().getAuth()
      if(!auth?.accessToken||auth.userId!==current.ownerId) return false
      const {data,error}=await makeChatClient(auth.accessToken).from('messages_view').select('id')
        .eq('id',posted.messageId).eq('chat_id',posted.chatId).eq('sender_user_id',current.assistantId)
        .is('deleted_at',null).is('retracted_at',null).not('deleted_for_user_ids','cs',JSON.stringify([current.ownerId])).maybeSingle()
      if(error) throw error
      return data?.id===posted.messageId
    },
    clean: work => assistantWorkForAgent(work.assistant_user_id)?.remove(work.work_id),
    warn: detail => createLogger('assistant-work/reconcile').warn(detail,'Task handoff reconciliation will retry'),
  })
  const history=createDesktopAssistantWorkHistory({context,
    checkpoint:assistantWorkHistoryPosition(resolveGuguHome(process.env)),
    receipts:async (after,retry)=>loadEmdashBridge()?.readAssistantWorkReceipts(after,retry)??{entries:[],cursor:after,hasMore:false},
    identity:async(session,owner)=>{
      const record=await localAgentForSession(session,process.env,owner)
      return record?.gugu_user_id ? {id:record.gugu_user_id,createdAt:record.created_at*1000} : null
    },
    assistant:async current=>(await resolveAssistant(current))?.agentId??null,
    warn:detail=>createLogger('assistant-work/history').warn(detail,'Historical work will be checked on the next host cycle'),
  })
  const noticeWake=createAssistantWorkNoticeWakePump({
    context,
    rpc: async (name,args,claimed) => {
      const live=await context()
      if(!live||live.ownerId!==claimed.ownerId||live.runtimeInstanceId!==claimed.runtimeInstanceId) throw new Error('Notice account changed')
      return live.client.rpc(name,args)
    },
    wake: (home,signal) => crossMachine().ensureReachable(home,signal),
    request: async (home,signal) => {
      const response=await crossMachineRequester!.call(home,'assistantWork.reconcile',{}, {timeoutMs:5000,signal})
      if(response.error) throw response.error
    },
    warn: detail => createLogger('assistant-work/notice').warn(detail,'Task notice home could not be reached'),

  })
  const host = createAssistantWorkOutboxHost({
    context,
    unavailable: createAssistantWorkAvailabilityNotifier({
      context,
      assistant: async claimed => {
        const current = await context()
        if (!current || current.ownerId !== claimed.ownerId || current.runtimeInstanceId !== claimed.runtimeInstanceId) throw new Error('Task notice account changed')
        return (await resolveAssistant(current))?.agentId ?? null
      },
      rpc: async (current, name, args, signal) => {
        const auth = await desktopAuthProvider().getAuth()
        if (!auth?.accessToken || auth.userId !== current.ownerId) throw new Error('Task notice account changed')
        return makeChatClient(auth.accessToken).rpc(name, args).abortSignal(signal)
      },
      visible: async (current, post, signal) => {
        const auth = await desktopAuthProvider().getAuth()
        if (!auth?.accessToken || auth.userId !== current.ownerId) return false
        const {data, error} = await makeChatClient(auth.accessToken).from('messages_view').select('id')
          .eq('id', post.messageId).eq('chat_id', post.chatId).eq('sender_user_id', post.assistantId)
          .is('deleted_at', null).is('retracted_at', null).not('deleted_for_user_ids', 'cs', JSON.stringify([current.ownerId]))
          .abortSignal(signal).maybeSingle()
        if (error) throw error
        return data?.id === post.messageId
      },
    }),
    afterDrain: async () => {
      void history.kick()
      await reconciler.kick()
      await noticeWake.kick()
    },
    prepareRemote: (deviceId, signal) => crossMachine().ensureReachable(deviceId, signal),
    requestRemote: (deviceId, type, payload, signal) => crossMachineRequester!.call(deviceId, type, payload, { timeoutMs: 45_000, signal }),
    deliverLocal: async (event, signal) => {
      const bridge = loadEmdashBridge()
      if (!bridge) throw Object.assign(new Error('Session host is not ready'), { code: 'SESSION_HOST_NOT_READY' })
      const status = event.kind === 'dispatch' ? undefined
        : ['completed', 'cancelled', 'question'].includes(event.kind) ? event.kind : 'progress'
      const caller: RemoteSessionCaller = {
        deviceId: event.from_device_id, deviceLabel: null, sessionId: event.from_session_id,
        agentUserId: null, name: event.kind === 'dispatch' ? '个人助理' : '任务',
        harness: null, transport: 'acp', model: null, platformModel: null,
      }
      const result = await bridge.runRemoteSessionAction(caller, {
        action: 'message', session_ids: [event.to_session_id], text: event.content!,
        client_message_id: event.message_id, client_message_at: event.platform_received_at,
        attachments: event.attachment_refs as SessionAttachmentRef[] | undefined,
        ...(status ? { work_result: { work_id: event.work_id, status } } : {}),
      } as SessionAction, signal) as { recipients: UnifiedRecipientResult[] }
      const receipt = result.recipients.find(row => row.message_id === event.message_id)
      const agentId = receipt?.status === 'delivered' ? await guguAgentUserIdForSession(event.to_session_id, process.env) : null
      return { admitted: receipt?.status === 'delivered', messageId: event.message_id, ...(agentId ? {receipt: {agent_user_id: agentId}} : {}) }
    },
    subscribe: async (ownerId, changed) => {
      const createChannel = () => supabase.channel(`gugu:user:${ownerId}:events`, { config: { private: true } })
        .on('broadcast', { event: 'assistant_work_changed' }, changed)
      const off = await subscribeAuthenticatedElectronRealtimeChannel({
        realtime: supabase.realtime, removeChannel: channel => supabase.removeChannel(channel as ReturnType<typeof createChannel>),
      }, createChannel(), {
        label: `assistant-work:${ownerId}`, createChannel,
        onStatus: status => { if (String(status).endsWith('SUBSCRIBED')) changed() },
      })
      return () => { void off() }
    },
    warn: detail => createLogger('assistant-work/outbox').warn(detail, 'Task delivery will reconcile from the cloud queue'),
  })
  const offLedger = installAssistantWorkLedgerHost({ context, kick: () => host.kick() })
  app.once('will-quit', () => { offLedger(); history.stop(); reconciler.stop(); noticeWake.stop(); host.stop() })
  return (assistantWorkOutbox = host)
}

/**
 * 远程隧道 · 这台 server 这一头(server/tunnel-endpoint.ts):账号进程起来后起一次。没起成(这个构建没配中转、
 * 包里没有 frpc、端口开不出来)就把原因留着,别的电脑来要 `tunnel.open` 时如实答 —— ❌ 装作没有这个动作。
 */
let tunnelEndpoint: TunnelEndpoint | null = null
let tunnelEndpointProblem = '远程隧道还在启动'

function tunnelRpcHandlers(): DeviceRpcHandlers {
  if (!SERVER_MODE) return {}
  return {
    [TUNNEL_OPEN_RPC_TYPE]: (payload, ctx) => {
      const handler = tunnelEndpoint?.rpcHandlers()[TUNNEL_OPEN_RPC_TYPE]
      return handler ? handler(payload, ctx) : { error: { code: 'tunnel_unavailable', message: tunnelEndpointProblem } }
    },
  }
}

async function startServerTunnelEndpoint(): Promise<void> {
  const log = createLogger('server/tunnel')
  if (!REMOTE_TUNNEL_OPEN) return
  const relay = resolveRelayEndpoint(process.env)
  if (!relay) {
    tunnelEndpointProblem = '这个版本的咕咕 server 没有配远程隧道的中转'
    log.warn({}, tunnelEndpointProblem)
    return
  }
  const frpcBinary = findFrpc(frpcCandidates({
    env: process.env,
    platform: process.platform,
    arch: process.arch,
    isPackaged: app.isPackaged,
    resourcesPath: process.resourcesPath,
    appPath: app.getAppPath(),
  }))
  if (!frpcBinary) {
    tunnelEndpointProblem = '咕咕 server 的安装包里缺 frpc'
    log.error({}, tunnelEndpointProblem)
    return
  }
  const accountUserId = process.env.GUGU_SERVER_ACCOUNT
  if (!accountUserId) {
    tunnelEndpointProblem = '账号进程不知道自己是谁(GUGU_SERVER_ACCOUNT)'
    log.error({}, tunnelEndpointProblem)
    return
  }
  try {
    tunnelEndpoint = await startTunnelEndpoint({
      dataDir: app.getPath('userData'),
      accountUserId,
      deviceId: () => localDeviceId(),
      relay,
      frpcBinary,
      log: { info: (message, fields) => log.info(fields ?? {}, message), warn: (message, fields) => log.warn(fields ?? {}, message) },
    })
    // 中转通 / 断:当场跑一轮心跳,别的电脑据 capabilities.tunnel_relay 决定开不开终端那条路(❌ 等下一个 30 秒)。
    onTunnelRelayChange(() => {
      void deviceRuntimeHost?.tickOnce().catch((error: unknown) => log.warn({ err: String(error) }, 'heartbeat after tunnel relay change failed'))
    })
  } catch (error) {
    tunnelEndpointProblem = `远程隧道起不来:${(error as Error).message}`
    log.error({ err: error }, tunnelEndpointProblem)
  }
}

/**
 * #7199 第二步:这台电脑能被调用的动作(授权、Mac 动作、被调用方的收发)。一个进程一份,第一次用到时装。
 * 授权一变就立刻跑一轮心跳,把新的动作清单登记上去(❌ 等下一个 30 秒)。
 */
let deviceActionsRuntimeInstance: DeviceActionsRuntime | null = null
/** 咕咕自己的 bundle id(Mac 打包后读 Contents/Info.plist);读不到回 null。 */
let selfBundleIdCache: string | null | undefined
function selfBundleId(): string | null {
  if (selfBundleIdCache !== undefined) return selfBundleIdCache
  selfBundleIdCache = null
  if (process.platform === 'darwin') {
    try {
      const plist = readFileSync(join(dirname(process.execPath), '..', 'Info.plist'), 'utf8')
      selfBundleIdCache = /<key>CFBundleIdentifier<\/key>\s*<string>([^<]+)<\/string>/.exec(plist)?.[1] ?? null
    } catch {
      selfBundleIdCache = null
    }
  }
  return selfBundleIdCache
}

/** 电脑控制认得出的「咕咕自己」:主进程(窗口都归它)、bundle id、App 名、可执行文件名。 */
function selfAppForComputerControl(): { pids: ReadonlySet<number>; names: ReadonlySet<string> } {
  const exe = (process.execPath.split(/[\\/]/).pop() ?? '').replace(/\.exe$/i, '')
  const names = [app.getName(), exe, selfBundleId()].filter((n): n is string => !!n).map((n) => n.trim().toLowerCase())
  return { pids: new Set([process.pid]), names: new Set(names) }
}

/**
 * #7317 Computer Use 装着、启用着(它的程序能跑)没有。会话主进程起来之前、server 模式下都是「没有」:那时这台电脑没有
 * 电脑控制。起来以后由那边接上(见注册 `computer-use` 原生程序处),App 每变一次就 `switchChanged()`。
 */
let computerUseOn: () => boolean = () => false

function deviceActionsRuntime(): DeviceActionsRuntime {
  if (deviceActionsRuntimeInstance) return deviceActionsRuntimeInstance
  const log = createLogger('device-actions')
  const runtime = createDeviceActionsRuntime({
    deviceId: async () => { const id = await localDeviceId(); if (!id) throw new Error("Local device identity is unavailable"); return id },
    userData: app.getPath('userData'),
    deps: {
      clipboardRead: async () => await clipboard.readText(),
      // @@@electron44-clipboard (#4394) — electron 44 起 clipboard.writeText 返回 Promise。
      clipboardWrite: async (text) => { await clipboard.writeText(text) },
      // electron 44 的剪贴板是 W3C 那套:read() 拿 ClipboardItem,图片在 image/png 那一项里。
      clipboardReadImage: async () => {
        for (const item of await clipboard.read()) {
          if (!item.types.includes('image/png')) continue
          const blob = (await item.getType('image/png')) as Blob
          const png = Buffer.from(await blob.arrayBuffer())
          const size = nativeImage.createFromBuffer(png).getSize()
          return { mimeType: 'image/png', data: png.toString('base64'), width: size.width, height: size.height }
        }
        return null
      },
      notify: (title, body) => { new Notification({ title, body }).show() },
      openExternal: (url) => shell.openExternal(url),
      trashItem: (target) => shell.trashItem(target),
      sampleImage: data => sampleCuaImage(nativeImage.createFromBuffer, data),
      shrinkImage: async (image, { maxEdge, quality }) => {
        const source = nativeImage.createFromBuffer(Buffer.from(image.data, 'base64'))
        if (source.isEmpty()) throw new Error(`读不懂这张图(${image.mimeType})`)
        const size = source.getSize()
        const scale = Math.min(1, maxEdge / Math.max(size.width, size.height))
        const resized = scale < 1 ? source.resize({ width: Math.round(size.width * scale), height: Math.round(size.height * scale), quality: 'good' }) : source
        const out = resized.getSize()
        return { mimeType: 'image/jpeg', data: resized.toJPEG(quality).toString('base64'), width: out.width, height: out.height }
      },
      // 截主屏一张,长边缩到 maxEdge(模型看图的甜区);macOS 上要「屏幕录制」权限,没有时系统只给桌面背景。
      captureScreen: async ({ maxEdge }) => {
        const primary = screen.getPrimaryDisplay()
        const scale = Math.min(1, maxEdge / Math.max(primary.size.width, primary.size.height))
        const width = Math.round(primary.size.width * scale)
        const height = Math.round(primary.size.height * scale)
        const sources = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: { width, height } })
        const source = sources.find((s) => s.display_id === String(primary.id)) ?? sources[0]
        if (!source || source.thumbnail.isEmpty()) throw new Error('截不到屏幕：系统没给咕咕「屏幕录制」权限')
        return { mimeType: 'image/jpeg', data: source.thumbnail.toJPEG(72).toString('base64'), width, height, displays: sources.length }
      },
    },
    nativeDir: nativeComponentsDir({ isPackaged: app.isPackaged, resourcesPath: process.resourcesPath, appPath: app.getAppPath() }),
    isPackaged: app.isPackaged,
    appVersion: app.getVersion(),
    serverMode: SERVER_MODE,
    openSystemSettings: (url) => shell.openExternal(url),
    // 电脑控制:agent 不许操作咕咕自己;提示跟随实际目标窗口。
    selfApp: () => selfAppForComputerControl(),
    // #7317 电脑控制的开关是 Computer Use 这个 App(behavior tab-extensions):它开着这台电脑才有电脑控制。
    appSwitch: { group: 'computer', app: 'Computer Use', on: () => computerUseOn() },
    ...(selfBundleId() ? { hostBundleId: selfBundleId()! } : {}),
    ...(SERVER_MODE
      ? {}
      : {
          computerControlView: (cua) => createComputerControlWindow({
            readWindows: (pid, signal) => cua().callTool('list_windows', { pid, on_screen_only: true }, { signal, timeoutMs: 2_000, lane: 'gugu-computer-indicator' }),
            strings: () => {
              const bar = (hostLocaleStore?.current() === 'en-US' ? enDeviceStrings : zhDeviceStrings).devices.deviceActions.computerBar
              const fill = (template: string, name: string, app?: string) => template.replace('{{name}}', name).replace('{{app}}', app ?? '')
              return {
                driving: (name, app) => fill(app === undefined ? bar.drivingComputer : bar.drivingApp, name, app),
                paused: (name, app) => fill(app === undefined ? bar.pausedComputer : bar.pausedApp, name, app),
                someApp: bar.someApp,
                stop: bar.stop,
                resume: bar.resume,
                someone: bar.someone,
              }
            },
            onStop: () => deviceActionsRuntime().computerControl?.stop(),
            onResume: () => deviceActionsRuntime().computerControl?.resume(),
            log,
          }),
        }),
    log,
  })
  runtime.onGrantsChanged(() => deviceRuntimeHost?.notifyDeviceActionsChanged())
  return (deviceActionsRuntimeInstance = runtime)
}

function messagePreviewHostDeps({ openTopicPublisher }: {
  openTopicPublisher: OpenTopicPublisher
}): Omit<MessagePreviewHostDeps, 'now' | 'idleMs'> {
  const previewLog = createLogger('sessionpage/message-preview')
  return {
    // agent → 会话与「打开会话页」同一映射。
    resolveSessionId: async (agentId) =>
      (await readSessionpageOpenTarget(agentId))?.sessionId ??
      emdashAgentRegistry.liveSessionIdByAgent(agentId),
    openPublisher: (topic) => openTopicPublisher(topic, MESSAGE_PREVIEW_EVENT),
    warn: (message, meta) => previewLog.warn(meta ?? {}, message),
  }
}

// 免费额度跟设备走(官方会员口径):owner 确立时认领一次,结果记在本机;失败静默,下次启动再试。
const deviceClaimStorePath = () => join(app.getPath('userData'), 'device-free-credits.json')
async function claimFreeCreditsForOwner(provider: RuntimeAuthProvider, ownerUserId: string): Promise<void> {
  if (!officialServicesEnabled()) return
  const auth = await provider.getAuth().catch(() => null)
  if (!auth || auth.userId !== ownerUserId) return
  const log = createLogger('billing/device-claim')
  const status = await claimDeviceFreeCredits({
    machineId: resolveMachineHardwareId,
    claim: async (accessToken, deviceHash) => {
      const { data, error } = await makeIdentityClient(accessToken).schema('billing')
        .rpc('claim_device_free_credits', { p_device_hash: deviceHash })
      if (error) throw new Error(error.message)
      return data
    },
    storePath: deviceClaimStorePath(),
    warn: (message) => log.warn({ ownerUserId }, message),
  }, auth)
  if (status) log.info({ ownerUserId, status }, 'device free credits claim')
}
ipcMain.handle('device:free-credits-status', async () => {
  const auth = await authProvider?.getAuth().catch(() => null)
  return auth ? readDeviceClaimStatus(deviceClaimStorePath(), auth.userId) : null
})

function startDeviceRuntimeWhenRendererReady(): void {
  if (!mainWindow && !SERVER_MODE) return
  const hostAuthProvider = desktopAuthProvider()
  primaryGuguMcpHost ??= createDesktopGuguMcpHost(stableMcpPersistence('gugu-mcp'))
  // 一个收口:任何一家拿得到咕咕自己那台 MCP,就同样拿得到已连接的集成(见 setSessionIntegrationBridge)。
  setSessionIntegrationBridge(integrationMcpServersFor)
  setSessionWebSearchBridge(platformWebSearchForSession)
  // #7210 连上的官方命令行带的 skills,同一个收口:会话要能开,读不出来只让它们缺席、在日志里说出来。
  setSessionIntegrationSkillBridge(() =>
    connectedCliSkills(
      (integrationId) => integrationCredentialStore.isConfigured(integrationId),
      (message) => integrationMcpLogger.warn({ message }, 'integration skill left out of the session'),
    ).catch((error: unknown) => {
      integrationMcpLogger.warn({ error: (error as Error).message }, 'integration skills skipped for this session')
      return []
    }),
  )
  // #7199 浏览器只有 Browser Use App 一条路:会话开场读这台机器装没装它(Codex 的浏览器插件;server 上还有开场提示,见 setBrowserUseApp)。
  setBrowserUseApp({
    server: SERVER_MODE,
    installed: () => {
      const emdash = loadEmdashBridge()
      if (!emdash) throw new Error('the session page is unavailable, so the installed Apps cannot be read')
      return browserUseAppInstalled(emdash.emdashExtensionPrograms())
    },
  })
  deviceRuntimeHost ??= createDeviceRuntimeHostLoop({
    env: process.env,
    onRuntimeLeaseRenewed: () => { void assistantWorkDeliveryHost().kick() },
    authProvider: hostAuthProvider,
    makeIdentityClient: (accessToken) =>
      makeIdentityClient(accessToken) as unknown as DeviceRuntimeIdentityClient,
    subscribeCommandWake: createDesktopDeviceCommandWakeSubscription({ supabase }),
    // 会话页会话时间线只挂**主账号**这条频道:任务本地库是这个桌面实例自己的库,
    // 而多账号 host 的频道属于另一个人的 device id —— 给它装等于把本机会话开给别的账号读写。
    // ⚠️ 经桥拿,❌ 别静态 import `session-timeline/device-rpc`:那会把整条链一起打进
    // electron main 的 rollup,于是同一份模块在两个 bundle 里各有一份实例。读侧(只读磁盘)
    // 看不出问题,写侧要的运行时状态(session message router、conversation provider 手里的 pty)
    // 只装在桥那一份里 ⇒ 手机发消息恒报 `no session message router is installed`。
    subscribeDeviceRpc: createDesktopDeviceRpcSubscription({
      supabase,
      createHandlers: (io) => createPrimaryDeviceRpcHandlers(io),
      askerLimits: deviceRpcAskerLimitsFromEnv(process.env),
      broadcastEvents: { 'files.transfer': () => drainProjectFiles(), 'files.handoff': () => drainVersionHandoffs() },
      onSubscribed: () => { drainProjectFiles(); drainVersionHandoffs() },
    }),
    ...heartbeatRowSources,
    // server 首次注册报的名字(deviceLabelOption):经远程 SSH 装上的报人填的 SSH 别名 / 主机(登录时记在 connect-via.json);
    // 没有就报空名,库里的 BEFORE INSERT 触发器按这个账号同平台已有设备取不撞号的 `Linux 1` / `Mac 2`
    // (gugu_devices_default_label)。服务器的 hostname 多是 `ip-172-31-…` 这类认不出的串,不拿它当默认名。
    // 之后的心跳改不动名字(preserve 触发器),只有用户在界面上改名才改。桌面沿用 hostname。
    ...deviceLabelOption,
    // 心跳带的终端 / 运行时清单用这份一次探测的结果:不传的话每 30 秒的心跳都在主进程里再起十来个子进程
    // 探一遍(which tmux / codex …),每次 spawn 都同步卡住 PTY 所在的事件循环。
    capabilities: localCapabilitiesOnce,
    runtimeBridge: createDeviceSessionpageBridge(),
    onAgentRosterRemoved: onLocalAgentRosterRemoved,
    // #4277 日志按账号分文件:owner 一确立,主进程与会话页两份日志都切到 logs/users/<id>/。
    onOwnerEstablished: (ownerUserId) => {
      switchLogFileForOwner(ownerUserId)
      void claimFreeCreditsForOwner(hostAuthProvider, ownerUserId)
      // @@@4467 上一轮退出(或中途撤销失败)没结清的平台票,在属主身份就绪时结清。会话页的平台票只由主账号签发。
      // #6264 等开机认回(还在 tmux 里跑的那几张已改记本进程)落定,再结清其余的 —— 顺序反了,结清会把正在用的票撤掉。
      void platformRelaySessionsRestored()
        .then(() => settleResidualPlatformModelAccess(hostAuthProvider, liveTmuxSessionIds)).then((result) => {
        const log = createLogger('sessionpage/platform-model')
        if (result.failed.length) log.error({ ownerUserId, ...result }, '上一轮残留平台票结清失败,账本保留,下次启动再试')
        else log.info({ ownerUserId, ...result }, '上一轮残留平台票结清')
      }, (error: unknown) => {
        createLogger('sessionpage/platform-model').error({ ownerUserId, err: error }, '上一轮残留平台票结清失败')
      })
      const sessionLog = emdashBridge?.setSessionpageLogFileOwner?.(ownerUserId)
      if (sessionLog && !sessionLog.includes(ownerUserId)) {
        createLogger('logger').warn({ ownerUserId, sessionLog }, '#4277 任务页日志没能切到账号文件,继续写原文件')
      }
    },
    runScheduledTasks: (ctx) => runDueScheduledTasksForOwner(ctx),
    warn: (message) => console.warn(message),
    onAuthExpired: (message) => { void showAuthExpiredNotification(message) },
    ...(serverAuth ? { onDeviceRemoved: serverDeviceRemovedHandler(serverAuth) } : {}),
    onAgentDeliverFailure: (failure) => {
      console.error(
        `[agent-turn] deliver ${failure.commandId} failed terminally (agent=${failure.agentUserId} chat=${failure.chatId} thread=${failure.threadRootId ?? 'main'}): ${failure.error}`
        + (failure.cause ? ` (cause: ${failure.cause})` : '')
      )
      sendUiEvent(MAIN_UI_EVENTS.agentStream, {
        agentUserId: failure.agentUserId,
        conversationId: failure.chatId,
        threadRootId: failure.threadRootId,
        event: { type: 'error', message: failure.error, commandId: failure.commandId }
      } satisfies AgentStreamPayload)
      // @@@no-auto-dm — 判据是「这个 agent 是不是会话页 agent」,那是 liveSessionIdByAgent 的
      // 定义(非 null = 投递归会话页)。曾经拿 chatIdForAgent 顶替:私聊一律在 provision 时开,于是
      // 「有 chatId」恰好等价于「是会话页 agent」—— 现在私聊只找不建,没开过私聊的会话页 agent
      // chatId 就是 null,再按它判就会把该报给会话页的投递失败**静默吞掉**。
      const sessionpageSessionId = emdashAgentRegistry.liveSessionIdByAgent(failure.agentUserId)
      if (sessionpageSessionId) {
        sendUiEvent(MAIN_UI_EVENTS.sessionpageDeliverFailed, {
          agentUserId: failure.agentUserId,
          messageId: failure.messageId,
          error: failure.error,
        })
      }
    },
  })
  // server 没有窗口可等:登录态在主进程手里,设备循环直接起。
  if (SERVER_MODE || !mainWindow) {
    deviceRuntimeHost?.start()
    return
  }
  mainWindow.webContents.once('did-finish-load', () => {
    deviceRuntimeHost?.start()
  })
}

/**
 * 这台机器那一行里,只有心跳写得出的几样:每个写这一行的心跳都带齐(行是整块覆盖的:`capabilities`、`session_digest`
 * 少带一样,就把别的写者刚登记的抹掉)。#7317 真机:`liveResolveLocalDeviceId` 那一次登记心跳没带动作清单,
 * 开机后第一次 device_actions 之后,紧接着的 device_call 读到一行没有动作的记录 ⇒ 报「版本太旧」,直到下一次心跳。
 */
const heartbeatRowSources = {
  // 会话摘要随心跳上云:机器离线后手机就只剩它可读了(product spec 的验收)。
  // 经桥拿,与设备 RPC 同一条规矩。桥没起来就报空 —— 那时这台机器上确实一条会话页会话
  // 都还没有,❌ 不为此把心跳判失败(心跳是 presence 的唯一写者,拿主要的换次要的)。
  sessionDigest: () => loadEmdashBridge()?.sessionpageSessionDigest?.() ?? [],
  // #7199 第二步:这台电脑能被调用的动作随心跳登记(没授权的也登记、标不可用)。
  deviceActions: () => deviceActionsRuntime().capability(),
}

// @@@cached-capabilities - Probing terminal/runtime availability forks several subprocesses
let cachedLocalCapabilities: Promise<DeviceCapabilities> | null = null
function localCapabilitiesOnce(): Promise<DeviceCapabilities> {
  // 只记成功的那次:探测超时 / 失败时下一次重探,❌ 把一次失败钉成这个进程的永久结论(心跳会从此写不进去)。
  return (cachedLocalCapabilities ??= detectDeviceCapabilities().catch((error: unknown) => {
    cachedLocalCapabilities = null
    throw error
  }))
}

interface LocalDeviceSelfSnapshot {
  device_id: string
  label: string
  hostname: string
  platform: string
  status: 'online'
  last_seen_at: string
  capabilities: DeviceCapabilities
}

// 本机在当前账号下的设备 id:按 owner 记一次,第一次先登记心跳(createLocalDeviceIdResolver)。设备自查、会话页身份供给、
// 设备动作、跨机器、server 隧道都问这一个;❌ 先等设备运行时一轮 tick(#4181 / #4320② 的等待环)。
const resolveLocalDeviceId = createLocalDeviceIdResolver({
  getAuth: async () => (authProvider ? authProvider.getAuth() : null),
  heartbeatClient: (accessToken) => makeIdentityClient(accessToken) as unknown as DeviceHeartbeatTableClient,
  capabilities: () => localCapabilitiesOnce(),
  ...heartbeatRowSources,
  ...deviceLabelOption,
  warn: (message) => deviceHeartbeatLogger.warn({}, message),
})
// 认出来的那一刻告诉各个窗口(device:self-identified):登录交过来之前读的设备表分不出哪行是本机,要重读。
const localDeviceId = announceLocalDeviceIdentity(resolveLocalDeviceId, (deviceId) => {
  for (const window of BrowserWindow.getAllWindows()) {
    if (!window.isDestroyed()) window.webContents.send('device:self-identified', deviceId)
  }
})

async function getLocalDeviceSelfSnapshot(): Promise<LocalDeviceSelfSnapshot | null> {
  if (!deviceRuntimeHost) return null
  const deviceId = await localDeviceId()
  if (!deviceId) return null
  return {
    device_id: deviceId,
    label: machineDisplayName(),
    hostname: hostname(),
    platform: platform(),
    status: 'online',
    last_seen_at: new Date().toISOString(),
    // @@@fleet-version (#663) - self 快照会在 listDevices 里整行盖掉云端行（label 除外），不带
    // app_version 的话本机行永远显示「版本未知」——本机版本恰恰是最确定的，直接取运行时真值。
    capabilities: { ...(await localCapabilitiesOnce()), app_version: app.getVersion() },
  }
}

// IPC: 渲染层报「未读聊天消息数」,它就是角标的全部(#6433)。
// ❌ 别在这里直接 setBadgeCount —— 托盘图、任务栏 overlay 与角标开关都在 applyUnreadBadge 里一起算。
ipcMain.on('set-badge', (_event, count: number) => {
  unreadChatMessages = Number.isFinite(count) && count > 0 ? Math.floor(count) : 0
  applyUnreadBadge()
})

// @@@5295 托盘角标开关(app 设置 · 通用)。关掉 = 角标一律不画,计数照常在内存里跟着走,
// 重新打开立刻显示当前真值,❌ 不需要等下一条消息来触发。
ipcMain.on('set-tray-badge-enabled', (_event, enabled: unknown) => {
  trayBadgeEnabled = enabled !== false
  applyUnreadBadge()
})

// @@@822 frameless 自绘标题栏的窗口控制 —— Windows/Linux 无原生边框时,renderer 的 <WindowControls> 经此驱动。
// 用事件来源窗口(BrowserWindow.fromWebContents)而非全局 mainWindow,兼容多窗(widget)。
ipcMain.on('window:minimize', (event) => BrowserWindow.fromWebContents(event.sender)?.minimize())
ipcMain.on('window:maximize', (event) => {
  const win = BrowserWindow.fromWebContents(event.sender)
  if (!win) return
  if (win.isMaximized()) win.unmaximize()
  else win.maximize()
})
ipcMain.on('window:close', (event) => BrowserWindow.fromWebContents(event.sender)?.close())
ipcMain.handle('window:isMaximized', (event) => BrowserWindow.fromWebContents(event.sender)?.isMaximized() ?? false)
// @@@app-active 「App 在前台」= 咕咕有一扇窗口拿着焦点(快速聊天小窗也是主窗渲染层画的,它在前台也算)。
// 渲染层的 visibilityState 答不了这个:主窗关了 backgroundThrottling,最小化、被遮住、切到别的应用时页面照样 visible,
// 眼前那条会话就永远不弹通知、新消息一到就被标成已读(lib/onScreenChat.ts 读的就是这里)。
const isAppActive = (): boolean => BrowserWindow.getFocusedWindow() !== null
ipcMain.handle('app:is-active', () => isAppActive())
const sendAppActive = (): void => { mainWindow?.webContents.send('app:active-changed', isAppActive()) }
app.on('browser-window-focus', sendAppActive)
app.on('browser-window-blur', sendAppActive)
// @@@win-titlebar-row — Windows 标题栏「编辑 / 视图」菜单的命令(清单与理由见 window-menu-commands.ts)。
ipcMain.on('window:menu-command', (event, command: unknown) => {
  const window = BrowserWindow.fromWebContents(event.sender)
  if (!window) return
  if (!isWindowMenuCommand(command)) {
    windowMenuLogger.error({ command }, '标题栏菜单送来了清单外的命令,已拒收')
    return
  }
  runWindowMenuCommand(command, { contents: event.sender, window })
})
ipcMain.on('window-chrome:get-labels', (event) => {
  event.returnValue = currentHostCatalog().windowChrome
})
ipcMain.handle('locale:sync-resolved', (_event, locale: unknown) => {
  syncResolvedHostLocale(locale)
})
// @@@window-tone — 渲染层是主题真值的唯一写入者,落属性时顺带告诉主进程,主进程只被告知。
ipcMain.on('window:sync-tone', (_event, tone: unknown) => {
  syncWindowTone(tone)
})
// @@@host-system-languages — renderer 判定「跟随系统」的唯一真值源。**不能**让 renderer 自己读
// navigator.languages:Electron 把 Chromium 界面语言排在那个列表首位(中文 macOS 实测 ['en-US',
// 'zh-Hans-CN']),会把中文系统解析成 en-US。同步应答,因为 renderer 首帧前就要用。
ipcMain.on(HOST_SYSTEM_LANGUAGES_CHANNEL, (event) => {
  event.returnValue = app.getPreferredSystemLanguages()
})
// @@@logging (#2382) - renderer 的日志回传到主进程,和主进程日志同流、同脱敏、同落盘:
// 渲染侧崩在用户机器上时,`console` 只活在 devtools 里,拿不回来。
ipcMain.handle(RENDERER_LOG_CHANNEL, (_event, payload: unknown) => {
  writeRendererLog(payload)
})

// @@@4899 用户在反馈里勾了「附带日志」才走这条。读不到就让它抛到 renderer —— 界面当场取消
// 勾选并说明,❌ 不许悄悄附一个空的(用户以为给了线索,排查方以为用户没日志)。
ipcMain.handle('feedback:log-tail', () => readLogTailForFeedback())
// #7199 个人助理住在这台电脑上时,它的家在本机准备(工作目录、说明、禁用的工具、开通时主人留的那条记忆)。
installAssistantHome()

ipcMain.handle('updates:check', () => checkForUpdates())
// @@@5837 界面随时可以来问「现在是什么状态」—— 横幅与「设置→关于」挂载时各问一次,所以
// 整窗重载、用户关掉横幅、下好那一刻窗口不在,都不会让「包已下好、等你按一下」这条事实消失。
// 渲染层那一侧是可选能力(AppPlatform.updateState):web/移动端没有更新这件事,答不上来就跳过。
ipcMain.handle('updates:state', () => updaterState)
ipcMain.handle('updates:download', () => downloadUpdate()) // @@@1578 用户点「更新」才下
ipcMain.handle('updates:install', () => installUpdate())
// @@@5758 更新说明**由主进程去取**。渲染层的 origin 是 gugu-app://app(corsEnabled),去下载站属于
// 跨源,而下载站一个 Access-Control-Allow-Origin 都不发 —— 浏览器层当场拦掉,产品里就是那句
// 「暂时取不到更新说明」。2026-09-18 在同样的 scheme 下实测:渲染层 TypeError: Failed to fetch,
// 主进程 net.fetch 200。主进程没有同源策略,这条路本来就不该走渲染层。
// 取不到返回 null(调用方回落本机缓存,❌ 不当成「没有更新说明」),但原因必须进日志 ——
// 之前渲染层那个空 catch 把它吞了,查了一轮才找到。
ipcMain.handle('updates:changelog', async (): Promise<unknown> => {
  // @@@5813 按**运行时**的平台取 —— 站上每个端一条自己的版本线。
  const url = changelogUrl(process.platform)
  if (url === null) {
    updaterLogger.warn({ platform: process.platform }, '[updater] 这个平台在帮助中心里没有发布说明页')
    return null
  }
  try {
    const res = await net.fetch(url, { cache: 'no-cache' })
    if (!res.ok) {
      updaterLogger.warn({ url, status: res.status }, '[updater] 更新说明取回来了但状态码不对')
      return null
    }
    return await res.json()
  } catch (error) {
    updaterLogger.warn({ url, err: error instanceof Error ? error.message : String(error) }, '[updater] 更新说明取不回来')
    return null
  }
})
ipcMain.handle('app:get-version', () => app.getVersion())
const remoteFileTempRoot = join(app.getPath('userData'), 'cache', 'remote-files')
const remoteFileOpenDirectories = new Set<string>()
const desktopFiles = createDesktopFileAccess({ auth: () => desktopAuthProvider().getAuth(), tempRoot: remoteFileTempRoot,
  rpc: async (name, args) => { const auth = await desktopAuthProvider().getAuth(); if (!auth) throw new Error('File reader is not signed in'); const { data, error } = await makeChatClient(auth.accessToken).rpc(name, args); if (error) throw error; return data },
  downloads: join(resolveGuguHome(process.env), 'attachments'), fetch: electronFetch, links: () => sshLinks,
  root: async projectId => { const bridge = loadEmdashBridge(); if (!bridge) throw new Error('Project registry is unavailable'); return bridge.emdashProjectRoot(projectId) },
})
function drainProjectFiles() { void desktopFiles.drain().catch(error => createLogger('files').warn({ error: String(error) }, 'Project transfer reconciliation failed')) }
function drainVersionHandoffs() { void desktopFiles.handoffs().catch(error => createLogger('files').warn({ error: String(error) }, 'Next version handoffs failed')) }
const nativeFiles = createNativeFileHost({ root: remoteFileTempRoot,
  owner: async () => (await desktopAuthProvider().getAuth())?.userId ?? null,
  alive: scope => !!webContents.fromId(scope) && !webContents.fromId(scope)!.isDestroyed(),
  local: desktopFiles.providers.local, ssh: desktopFiles.providers.ssh, publish: (chat, file, actor, message) => desktopFiles.publish(chat, file, null, actor, undefined, { message }), publication: desktopFiles.publish.local,
  openPath: path => shell.openPath(path), published: directory => trackRemoteFileDirectory(remoteFileOpenDirectories, directory),
})
registerNativeFileIpc(ipcMain, nativeFiles, error => createLogger('files').warn({ error: String(error) }, 'Native file operation failed'))
app.on('will-quit', () => { void nativeFiles.drop().catch(error => createLogger('files').warn({ error: String(error) }, 'File handle cleanup failed')) })

// @@@payment-window (#1907) - 支付在专用 BrowserWindow 原生 POST 落地,主窗不再被支付页顶掉。
// @@@local-runtime-open - Opening a terminal window is strictly local, so it bypasses cloud device commands.
// The renderer's harness selectors consume this exact main-process reachability decision.
ipcMain.handle('agent-creation-tools:list', () => listAgentCreationTools())
function requiredIpcString(value: unknown, field: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${field} is required`)
  return value.trim()
}

function requiredSessionpageLeg(value: unknown): 'acp' | 'tui' {
  if (value === 'acp' || value === 'tui') return value
  throw new Error('surface must be acp or tui')
}

// #6264 别的电脑经设备连接打开这台机器上的会话时,壳那几条(device-session-host.ts 的 REMOTE_SHELL_CHANNELS)
// 问的是这里注册的同一个 handler。Electron 的 ipcMain 不交出已注册的 handler ⇒ 注册时另记一份。
const remoteShellHandlers = new Map<string, Parameters<typeof ipcMain.handle>[1]>()
function handleShellChannel(channel: string, handler: Parameters<typeof ipcMain.handle>[1]): void {
  ipcMain.handle(channel, handler)
  remoteShellHandlers.set(channel, handler)
}

// @@@2503 会话页 composer 的「咕咕提供的模型」分组。走通用 electronAPI.invoke(会话页渲染层与咕咕
// 共用同一座桥),按将要启动的 provider 过滤,顺带回该会话的预选默认值。
handleShellChannel(SESSIONPAGE_PLATFORM_CATALOG_CHANNEL, async (_event, input: unknown) => {
  const row = (input ?? {}) as { providerId?: unknown; surface?: unknown; sessionId?: unknown }
  // The composer can ask for its first catalog before the device-runtime bootstrap reaches
  // startDeviceRuntimeWhenRendererReady. Lazily create the same renderer-backed auth provider
  // here so an early request cannot be cached as an empty catalog until the user changes agents.
  const catalogAuthProvider = desktopAuthProvider()
  return sessionpagePlatformCatalog({
    authProvider: catalogAuthProvider,
    providerId: requiredIpcString(row.providerId, 'providerId'),
    surface: requiredSessionpageLeg(row.surface),
    sessionId: typeof row.sessionId === 'string' ? row.sessionId : null,
    sessionSelectionResolver: sessionPlatformModel,
    env: process.env,
  })
})

// 会话页一侧(App 文件、App 发消息)的账号令牌来源:与上面那个平台模型目录同一个 provider,❌ 不另造一条问法。
setAccountAccessTokenReader(async () => {
  const provider = desktopAuthProvider()
  const auth = await provider.getAuth()
  return auth?.accessToken ?? null
})
setAccountFileResolver(desktopFiles.resolveAccount, desktopFiles.publish)

// #7337 设置页「用模型给会话起名」的候选:这个账号能在 Chat Completions 上用的在售平台模型(起名走的就是这条协议)。
ipcMain.handle(SESSION_TITLE_MODELS_CHANNEL, async () => {
  const models = await listPlatformModels(desktopAuthProvider())
  return models
    .filter((model) => model.enabled && !model.hidden && model.protocols.includes('openai-chat-completions'))
    .map((model) => ({ id: model.id, displayName: model.displayName, requiresMembership: model.requiresMembership }))
})

// #7199 语音笔记:转写一段(以个人助理的名义签平台票,按积分计费)、结票、麦克风授权。只在本机问(录音在这台电脑上)。
ipcMain.handle(VOICE_NOTE_TRANSCRIBE_CHANNEL, (_event, input: unknown) => {
  const row = (input ?? {}) as Partial<VoiceNoteTranscribeRequest>
  return transcribeVoiceNoteSegment(desktopAuthProvider(), {
    agentUserId: requiredIpcString(row.agentUserId, 'agentUserId'),
    audioBase64: requiredIpcString(row.audioBase64, 'audioBase64'),
    prompt: requiredIpcString(row.prompt, 'prompt'),
  })
})
ipcMain.handle(VOICE_NOTE_RELEASE_CHANNEL, (_event, agentUserId: unknown) =>
  releaseVoiceNoteTicket(desktopAuthProvider(), requiredIpcString(agentUserId, 'agentUserId')))
ipcMain.handle(VOICE_NOTE_MICROPHONE_CHANNEL, (_event, action: unknown) =>
  voiceNoteMicrophone(action === 'open-settings' ? 'open-settings' : 'request'))
ipcMain.handle(VOICE_NOTE_MEETINGS_CHANNEL, () => {
  // 实测 / e2e:用一份 JSON(calendar.events.list 回的那个形状)冒充这台电脑的日历,不碰真日历、不弹授权框。只在开发包里认。
  const fakeCalendar = process.env.GUGU_FAKE_CALENDAR_FILE?.trim()
  if (fakeCalendar && !app.isPackaged)
    return upcomingMeetings(async () => ({ ok: true, data: JSON.parse(readFileSync(fakeCalendar, 'utf8')) as unknown }))
  return upcomingMeetings((args) => deviceActionsRuntime().readLocal('calendar.events.list', args))
})

// #7103 人点的重试:这条会话下一次签咕咕额度真去问一次(自动唤醒照旧被取票退避挡着)。
handleShellChannel(SESSIONPAGE_PLATFORM_RETRY_CHANNEL, (_event, sessionId: unknown) => {
  if (typeof sessionId !== 'string' || !sessionId.trim()) throw new Error('session id is required for a platform retry')
  clearPlatformIssueBackoff(sessionId.trim())
})

/**
 * 会话重开 —— 换了一个这条会话「活着换不了」的东西之后(咕咕的另一个模型 #5160 / MCP 开关 #5157)，
 * 或用户从标题菜单手动发起，确认框确认后才走到这里。
 *
 * ⚠️ 这条通道**不带注入内容**:调用方先把新选择落进会话记录,主进程按记录重算整份。
 * 失败原话原样回给渲染层 —— ❌ 不折成一句「重开失败」:「同工作区还有另一条会话attach在同一个
 * 适配器上」与「恢复原 provider 会话失败」是两种事故,用户的下一步不同。
 */
handleShellChannel(SESSIONPAGE_SESSION_RELOAD_CHANNEL, async (_event, input: unknown) => {
  const row = (input ?? {}) as {
    sessionId?: unknown
    reason?: unknown
    model?: unknown
    modelSource?: unknown
    effort?: unknown
    mcpDisabledServers?: unknown
  }
  const reason = row.reason === 'mcp-toggle'
    ? 'mcp-toggle'
    : row.reason === 'manual'
      ? 'manual'
      : 'model-switch'
  const emdash = loadEmdashBridge()
  // 桥没装载 = 会话页模块根本没起来。❌ 不静默返回 ok:那会让确认框显示「重开完成」,
  // 而实际上一个字节都没发生。
  if (!emdash) return { ok: false, error: 'session page module is not loaded; cannot reload the session' }
  try {
    const reloaded = await emdash.reloadEmdashSession({
      sessionId: requiredIpcString(row.sessionId, 'sessionId'),
      reason,
      ...(typeof row.model === 'string' && row.model.trim()
        ? {
            model: row.model.trim(),
            // 计费路与模型同进同出。❌ 不给默认值:猜错的两个方向都是「界面说换了、实际没换」,
            //    而宿主这一侧没有目录,猜不出来。缺就让 reloadEmdashSession 响亮拒。
            modelSource: row.modelSource === 'platform' || row.modelSource === 'own'
              ? row.modelSource
              : undefined,
          }
        : {}),
      // 思考档位三态:`null` = 回默认,与缺席不同,❌ 不归一。
      ...(row.effort === null || typeof row.effort === 'string'
        ? { effort: typeof row.effort === 'string' ? row.effort.trim() || null : null }
        : {}),
      // ⚠️ `Array.isArray` 判在场,❌ 不按长度:`[]` = 用户决定过但一台没关,
      //    它仍要让这条会话独占适配器。按长度判会把那一刻悄悄退回池化。
      ...(Array.isArray(row.mcpDisabledServers)
        ? { mcpDisabledServers: row.mcpDisabledServers.filter((v): v is string => typeof v === 'string') }
        : {}),
    })
    // 从没起来过的会话只记下了选择(#7092):告诉渲染层接着正常首启,❌ 让它去重挂一条不存在的会话。
    return reloaded.nativeSession === 'not-started' ? { ok: true, notStarted: true } : { ok: true }
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) }
  }
})

// @@@electron44-clipboard (#4394) — electron 44 起 clipboard.writeText 返回 Promise。
// 必须 await 再 return true:否则 renderer 那句 await 会在剪贴板真正写好之前就拿到「成功」。
ipcMain.handle('clipboard:write-text', async (_event, value: unknown) => {
  await clipboard.writeText(typeof value === 'string' ? value : String(value ?? ''))
  return true
})
ipcMain.handle('notifications:show', (_event, params: unknown) => showAppNotification(params))
// #5906 —— 登录态的变化是**事件**,设备 runtime 靠它当场重新确立 owner 边界 / 订上命令 wake / 登出时撤订阅。
// 宿主不再有 2 秒一轮的 tick 去「碰巧发现」登录了;不通知的话,要等一个对账周期(30 s)设备才跟上。
function onHumanAuthSessionChanged(): void {
  void nativeFiles.ownerChanged(typeof pushedHumanAuth === 'object' ? pushedHumanAuth?.userId ?? null : null).catch(error => createLogger('files').warn({ error: String(error) }, 'File handle cleanup failed'))
  void refreshElectronSupabaseAuth().catch((error: unknown) => {
    createLogger('device-runtime/auth').warn({ error: String(error) }, 'Realtime account auth update failed')
  })
  deviceRuntimeHost?.notifyAuthChanged()
  deviceProjectsPublisher?.notify()
  // 登录一到就认本机(认出即通知窗口重读设备表);登出时答 null,下次登录认出来会再通知一次。
  void localDeviceId()
  void handOffWechatIfAny()
}
// 「设置 → 聊天渠道 → 微信」的收发在云电脑管家上(#7199,桌面关了照样能聊);界面直接调管家。
// 主进程只剩一件事:桌面第一版在本机连过的微信,登录后交给管家、交完删掉本机那份(owner 不用重扫)。
let wechatHandOff: Promise<unknown> | null = null
function handOffWechatIfAny(): void {
  if (SERVER_MODE || wechatHandOff) return
  wechatHandOff = (async () => {
    const auth = await desktopAuthProvider().getAuth()
    if (!auth?.accessToken || !auth.userId) return
    const baseUrl = cloudComputerBaseUrl({ enabled: cloudComputerEnabled(), override: process.env.GUGU_CLOUD_COMPUTER_URL ?? null, supabaseUrl: getSupabaseUrl() })
    await handOffLegacyWechat({
      userId: auth.userId,
      store: new LegacyWechatStore(join(app.getPath('userData'), 'wechat-channel'), { decrypt: (data) => safeStorage.decryptString(data) }),
      client: baseUrl
        ? createChatChannelsClient({ baseUrl, accessToken: async () => auth.accessToken, anonKey: getSupabaseAnonKey() })
        : null,
      log: createLogger('wechat-channel'),
    })
  })()
    .catch((error: unknown) => createLogger('wechat-channel').warn({ error: error instanceof Error ? error.message : String(error) }, 'wechat hand-off crashed'))
    .finally(() => {
      wechatHandOff = null
    })
}
// F33 渲染进程的协调器每接受一次会话(登录、每次续期)都写这份镜像,登出 / 会话永久丢失时清掉 ——
// 这就是它把令牌推给主进程的那一条路,主进程记下来,平时的 getAuth 就不再问渲染进程。
// 先记再写盘:落盘失败也不该让主进程继续用续期前的那份。
ipcMain.handle('human-auth-session:write', async (_event, session: unknown) => {
  try {
    const mirror = session as Parameters<typeof writeHumanAuthSession>[0]
    pushedHumanAuth = undefined
    pushedHumanAuth = runtimeAuthFromSupabaseTokens({ accessToken: mirror.access_token, refreshToken: mirror.refresh_token })
    return await writeHumanAuthSession(mirror)
  } finally {
    onHumanAuthSessionChanged()
  }
})
ipcMain.handle('human-auth-session:clear', async (_event, reason: unknown) => {
  try {
    pushedHumanAuth = reason === 'lost' ? 'lost' : null
    return await clearHumanAuthSession()
  } finally {
    onHumanAuthSessionChanged()
  }
})
// #5906 —— 渲染层刚把一条设备命令放回了 pending(失败条的「重试」)。那是 UPDATE,库那侧的 `command_created`
// 广播只挂在 INSERT 上 ⇒ 没有任何事件会叫醒宿主;由发起方在这里说一声。
ipcMain.on('device-runtime:commands-changed', () => {
  deviceRuntimeHost?.notifyCommandsChanged()
})
// #6396 这个账号的 agent 有变动(常见是另一台设备刚建了一个,用掉了一个号)。服务端给本账号每台设备推
// agent_changed,收它的是渲染层的修订总线;主进程不另开一条订阅,由渲染层转一声。本机下一条会话页会话起名时
// 「用到几号」就已跟上 —— ❌ 否则要等它落地被服务端改名,会话起来一秒就换名字。
ipcMain.on('owned-agents:changed', () => {
  void authProvider?.getAuth()
    .then((auth) => {
      if (auth?.accessToken && auth.userId) refreshAgentNamingFacts({ accessToken: auth.accessToken, userId: auth.userId })
    })
    .catch((error: unknown) => {
      createLogger('sessionpage/provision').warn(
        { error: error instanceof Error ? error.message : String(error) },
        '#6396 owned-agents changed: auth unavailable — naming facts refresh on the next change or session',
      )
    })
})
// @@@local-device-self - The renderer should not ask the cloud whether its own machine
ipcMain.handle('device:get-self-snapshot', () => getLocalDeviceSelfSnapshot())

// @@@4526 owner 删除一个自己的 agent 之后,释放它在这台机器上的足迹(花名册 / runtime session / 投递注册),
// 并立一块按 conversation 记账的墓碑,让那条仍然活着的会话页会话不再被重新开户。
//
// 渲染层在 `remove_owned_agent` **成功之后**调它:云端身份确认没了,才轮得到"本机永久不可达"这个结论。
// ❌ 不吞错。本机足迹没释放干净却让 UI 继续说「Agent deleted」,正是这张票要修的那个形状。
ipcMain.handle('owned-agent:release-local-footprint', async (_e, arg: unknown) => {
  const agentUserId = (arg as { agentUserId?: unknown } | null)?.agentUserId
  if (typeof agentUserId !== 'string' || !agentUserId.trim()) {
    throw new Error('owned-agent release 缺 agentUserId')
  }
  // @@@4526B ① 先取消在飞的那一轮。删除是用户唯一能想到的「停下它」的动作,UI 也确实回了
  // `Agent deleted` —— 而实测里那一轮一路跑到 61.8s 正常回了 DONE,继续烧上游配额、产出写进一条
  // 用户已经看不见的会话。取消走 conversation 键控 resolver(❌ 宿主不按 provider 名分支);
  // 空闲时它是 no-op。❌ 不 catch:没停下来却回报已删除,正是这条缺陷本身。
  // 进出各记一行。理由不是调试顺手:这条 IPC 一旦不生效,产品表现与"删干净了"**完全同形**——
  // 联系人照样从通讯录消失(那是云端 RPC 删掉 identity.users 造成的,与本机这半无关),
  // 于是"没释放足迹"就成了一次看不见的失败。这正是本票的形状,所以它必须留下痕迹。
  const log = createLogger('sessionpage/turn-cancel')
  log.info({ agentUserId }, 'owner delete: release-local-footprint entered')
  try {
    const result = await releaseDeletedOwnedAgent(agentUserId, { env: process.env })
    log.info({ agentUserId, ...result }, 'owner delete: release-local-footprint done')
    return result
  } catch (error) {
    log.error(
      { agentUserId, error: (error as Error).message },
      'owner delete: local footprint released, but the in-flight turn could NOT be cancelled',
    )
    throw error
  }
})

// @@@share-card-rename 改名也有两半,云端与本机 —— 与删除(release-local-footprint)对称。
// 云端那半是 identity.users.display_name(聊天页 / 通讯录 / 名片海报读它);本机那半是花名册 agents.json
// 上的 name,会话页读它(分享按钮的提示、分享卡片里那个名字、按名字寻址)。provisioning 复用花名册上的
// existing.name 且**从不**回读云端,所以只改云端 = 同一个 agent 在两页叫两个名字,而这正是
// sessionpage-agent-card 注释里写明要避免的那件事。
// 渲染层在云端改名**成功之后**调它(同 release 的次序:云端认了,才轮得到本机跟上)。
// 本机没有花名册记录不是失败(那个 agent 是在别的设备上开的户,这台机器上本来就没有它的那一半)→ 回 false。
ipcMain.handle('owned-agent:rename-local-footprint', async (_e, arg: unknown) => {
  const input = (arg ?? {}) as { agentUserId?: unknown; name?: unknown }
  const agentUserId = typeof input.agentUserId === 'string' ? input.agentUserId.trim() : ''
  const name = typeof input.name === 'string' ? input.name.trim() : ''
  if (!agentUserId) throw new Error('owned-agent rename 缺 agentUserId')
  // 空名不是「不改」,是一个会把花名册写坏的值 —— 调用方本就不该发出来,发出来就响亮拒绝。
  if (!name) throw new Error('owned-agent rename 缺 name')
  const { listAgents, updateAgent } = await import('@gugu/core/local/state/agents')
  // includeGuests:会话页会话的身份可能还挂在 guest 记录上,漏掉它就等于「这台机器上没有」而静默不改。
  const roster = await listAgents(process.env, { includeGuests: true })
  const existing = roster.find((agent) => agent.gugu_user_id === agentUserId)
  if (!existing) return false
  await updateAgent({ guguUserId: agentUserId }, { name }, process.env)
  // 分享按钮 / 侧栏身份卡的名字是查一次存下来的,不播这一下就还挂着旧名。按 conversationId 认领(同一个 task 里
  // N 条会话 N 个 agent,按 agent 认领会让兄弟会话跟着改名);花名册上没记会话绑定(还没起会话)就没人要听,不播。
  const sessionId = existing.cache?.[SESSION_CACHE_KEY]
  if (typeof sessionId === 'string' && sessionId) {
    sendSessionpageIdentityEvent(sessionpageAgentRenamedEvent, { conversationId: sessionId, agentUserId, displayName: name })
    if (existing.name !== name) tellRenamedAgentsSession({ agentUserId, displayName: name })
  }
  return true
})


ipcMain.handle('dialog:select-file', async () => {
  const options: OpenDialogOptions = { properties: ['openFile'] }
  const result = mainWindow
    ? await dialog.showOpenDialog(mainWindow, options)
    : await dialog.showOpenDialog(options)
  if (result.canceled) return null
  return result.filePaths[0] ?? null
})
ipcMain.handle('dialog:select-directory', async () => {
  const options: OpenDialogOptions = {
    properties: ['openDirectory', 'createDirectory']
  }
  const result = mainWindow
    ? await dialog.showOpenDialog(mainWindow, options)
    : await dialog.showOpenDialog(options)
  if (result.canceled) return null
  return result.filePaths[0] ?? null
})

// ── Auto-updater ──────────────────────────────────────────────────────────────
// @@@5576 更新方式(product spec,owner 2026-09-13 改的是「下载」这一步):
//   下载静默、安装仍归用户 —— 发现新版后台把包下好,界面出「重启更新」,用户点一下才装。
// autoDownload 依然是 false:它由库在 update-available 后立刻触发,而「这台机器能不能走原生
// Squirrel」要等拿到 feed 的 files 才判得出(见 maybeAutoDownload)。策略握在我们自己手里,
// 不交给这个开关。
// autoInstallOnAppQuit 也仍是 false:那是「退出时偷偷装」,owner 这次没有改这一条,安装动作
// 必须由用户按下「重启更新」发起。
autoUpdater.autoDownload = false
autoUpdater.autoInstallOnAppQuit = false
// @@@5747 装完必须自己起来 —— 这是「按一次就完事」的后半截。库的默认值就是 true,但原来有**第二套**
// 更新子系统(会话页那套,#5747 已删)也在设它,两处同时拨同一个单例的开关,谁最后跑谁说了算。
// 显式写在这里:这一条属于产品承诺,不能靠默认值、更不能靠另一个模块的副作用。
autoUpdater.autoRunAppAfterInstall = true

// @@@5747 启动时清掉过期的 pending 和弃用的预解压目录,
// 差分下载的底留着(updaterCache.ts @@@diff-base):装完常驻一份 —— Windows ≈200MB、mac ≈172MB;
// 下好待装那段时间是底 + pending 两份。
// 取的是 electron-updater 自己那套路径规则:baseCachePath + app-update.yml 里的 updaterCacheDirName。
// best-effort:读不到配置、删不掉,都只记一行,❌ 不挡启动。
function purgeUpdaterCacheOnce(): void {
  if (!app.isPackaged) return
  try {
    const configPath = join(process.resourcesPath, 'app-update.yml')
    if (!existsSync(configPath)) return
    const dirName = /^updaterCacheDirName:\s*(\S+)\s*$/m.exec(readFileSync(configPath, 'utf8'))?.[1]
    if (!dirName) return
    purgeStaleUpdaterCache({
      cacheDir: join(updaterCacheBaseDir(), dirName),
      runningVersion: app.getVersion(),
      log: (message, meta) => updaterLogger.info(meta, message),
    })
  } catch (error) {
    updaterLogger.warn({ error: String(error) }, '[updater] 清更新缓存时出错(不影响启动)')
  }
}

// @@@5576 本地包的签名身份:决定 mac 能不能走 Squirrel 原生静默路径(ad-hoc 老包不能,见
// macDmgUpdater.ts)。探测要 spawn 一次 codesign,所以惰性求值 + 只算一次;非 mac 无此概念。
let cachedLocalSigning: LocalSigning | null = null
function localSigning(): LocalSigning {
  if (process.platform !== 'darwin') return 'developer-id'
  if (cachedLocalSigning === null) {
    cachedLocalSigning = detectLocalSigning(macAppBundlePath())
    updaterLogger.info({ localSigning: cachedLocalSigning }, `local signing: ${cachedLocalSigning}`)
  }
  return cachedLocalSigning
}

/** exe 在 <bundle>/Contents/MacOS/<name>;回溯三段拿 .app 本体,拿不到就退回 exe(codesign 同样认)。 */
function macAppBundlePath(): string {
  const exe = app.getPath('exe')
  const marker = '/Contents/MacOS/'
  const at = exe.lastIndexOf(marker)
  return at > 0 ? exe.slice(0, at) : exe
}

const updaterLogger = createLogger('updater')
// @@@5737 这个包跟哪条通道,由它自己的 tier 决定 —— 正式版追正式版,Beta 追 Beta,验收包谁也不追。
const updateChannel = resolveUpdateChannel(__GUGU_TIER__)
const updateFeed = updateFeedUrl(updateChannel)
const updateFeedConfig = updateFeedOptions(updateChannel, process.platform)

// #6264「从桌面用 SSH 一步装好」(设置 → 设备 → 添加一台机器)。server 模式没有窗口、也没人在界面上点,不挂。
// 装哪条通道跟这台桌面连的库走:连生产库装正式版,别的库装 Beta(❌ 跟 tier 走:开发构建的 tier 也是 production)。
const serverChannel = __GUGU_SERVER_CHANNEL__
// #6264「别的机器上的编程只给用 SSH 装上的机器」:这台桌面上用 SSH 装上的机器(本机映射,不上云)。
const sshMachineStore = SERVER_MODE ? null : createSshMachineStore(defaultSshMachinesFile(app.getPath('userData')))
// 这台桌面到远程 SSH 机器的设备连接,一台机器一条:窗口(经 ssh-link-ipc)与主进程(agent 的 session_* 跨机器)共用。
let sshLinks: ReturnType<typeof registerSshLinkIpc> | null = null
// 远程隧道:经中转连到「只经咕咕云连着」的机器(server/tunnel-machines.ts),连通了就与远程 SSH 的机器同一套。
let tunnelMachines: TunnelMachines | null = null
// 收掉这台电脑上每条远程隧道(frpc 访问端 + ssh 共享连接)与问 tunnel.open 的频道;同步,停机两条路都调它。
let closeTunnelMachines: (() => void) | null = null
if (sshMachineStore) {
  // #6264 一台机器一条认证过的连接,咕咕开着就一直在(照 VS Code Remote-SSH):套接字按这个咕咕的数据目录分开,
  // 启动时收掉上次没正常退出留下的,退出时收掉自己的(见 ssh-machines.ts closeSshMasters)。
  configureSshControlScope(app.getPath('userData'))
  setImmediate(() => closeSshMasters(undefined, runSshInBackground))
  app.on('will-quit', () => closeSshMasters())
  // 桌面此刻登着的账号:映射只认同一个账号装上的机器(附件直传、卸载都按它挑机器)。
  const currentUserId = async () => {
    const auth = await desktopAuthProvider().getAuth().catch(() => null)
    return auth?.userId ?? null
  }
  registerSshMachinesIpc({ ipcMain, getWindow: () => mainWindow, store: sshMachineStore, currentUserId }) // #6264 远程 SSH 的机器:一切走设备连接(server/ssh-link.ts)
  if (REMOTE_TUNNEL_OPEN) {
    const tunnelLog = createLogger('server/tunnel')
    const requireAuth = async () => {
      const auth = await desktopAuthProvider().getAuth()
      if (!auth?.accessToken || !auth.userId) throw new Error('this machine is not signed in to 咕咕')
      return auth
    }
    // 问 tunnel.open 只走咕咕云(要建的正是另一条路);一台机器一条频道,与窗口那条各订各的。
    const cloud = createDeviceRpcRequester({
      userId: async () => (await requireAuth()).userId,
      openPipe: async (deviceId, handlers) => openCloudDeviceRpcPipe({ supabase, deviceId, userId: async () => (await requireAuth()).userId, ...handlers }),
    })
    const machines = createTunnelMachines({
      currentUserId,
      callCloud: (deviceId, type, payload, timeoutMs) => cloud.call(deviceId, type, payload, { timeoutMs }),
      ensureKey: () => ensureGuguKey({ dir: guguKeyDir(app.getPath('userData')), comment: guguKeyComment(computerName()) }),
      frpcBinary: () => findFrpc(frpcCandidates({
        env: process.env,
        platform: process.platform,
        arch: process.arch,
        isPackaged: app.isPackaged,
        resourcesPath: process.resourcesPath,
        appPath: app.getAppPath(),
      })),
      // known_hosts 与 frpc 配置放共享连接那个目录(短、只有本用户进得去、路径没有空格);Windows 没有就放数据目录。
      stateDir: () => sshControlDir() ?? join(app.getPath('userData'), 'tunnel'),
      controlPath: terminalControlPath,
      log: (message, fields) => tunnelLog.info(fields ?? {}, message),
    })
    tunnelMachines = machines
    ipcMain.handle(TUNNEL_MACHINES_CHANNELS.want, (_event, list: unknown) => {
      const wants = Array.isArray(list)
        ? list.filter((w): w is TunnelWant => !!w && typeof (w as TunnelWant).deviceId === 'string' && typeof (w as TunnelWant).label === 'string')
        : []
      machines.want(wants)
      return machines.state()
    })
    ipcMain.handle(TUNNEL_MACHINES_CHANNELS.state, () => machines.state())
    machines.onChange((state) => {
      if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send(TUNNEL_MACHINES_CHANNELS.changed, state)
    })
    closeTunnelMachines = () => {
      machines.closeAll()
      cloud.closeAll()
    }
  }
  // #7199 第二步:设置 → 设备 → 这台电脑能做的事。
  deviceActionsRuntime().registerIpc(ipcMain, () => BrowserWindow.getAllWindows())
  const links = registerSshLinkIpc({
    ipcMain,
    getWindow: () => mainWindow,
    store: sshMachineStore,
    currentUserId,
    installKey: createMachineKeyInstaller({
      store: sshMachineStore,
      keyDir: guguKeyDir(app.getPath('userData')),
      log: (message, detail) => createLogger('server').info(detail ?? {}, message),
    }),
    log: (message, fields) => createLogger('server/ssh-link').info(fields ?? {}, message),
    // 那台机器的 server 太旧、连不上:当场替它升级(与添加时装同一条通道);#6264 换成和这台桌面(按设备 id 报)匹配的那一版。
    upgradeChannel: serverChannel,
    published: parseBuildDistribution(__GUGU_BUILD_DISTRIBUTION__) === 'published',
    desktopId: async () => (await getLocalDeviceSelfSnapshot())?.device_id ?? null,
    ...(tunnelMachines ? { tunnels: tunnelMachines } : {}),
  })
  sshLinks = links
  app.on('will-quit', () => links.closeAll())
  // 「设置 → 设备 → 从这台机器上卸载咕咕 server」:只对这台桌面用 SSH 装上的机器。
  registerServerSshUninstallIpc({ ipcMain, getWindow: () => mainWindow, store: sshMachineStore, currentUserId })
}
if (!SERVER_MODE && sshMachineStore) {
  registerServerSshInstallIpc({
    getWindow: () => mainWindow,
    getAuth: () => desktopAuthProvider().getAuth(),
    channel: serverChannel,
    rememberMachine: (machine) => sshMachineStore.remember(machine),
    keyDir: guguKeyDir(app.getPath('userData')),
    sharedControlPath: terminalControlPath,
    machineTarget: (deviceId) => {
      const machine = sshMachineStore.list().find((m) => m.deviceId === deviceId)
      return machine ? sshTargetOf(machine) : null
    },
  })
}

const updaterPolicy = resolveUpdaterPolicy({
  isPackaged: app.isPackaged,
  distribution: parseBuildDistribution(__GUGU_BUILD_DISTRIBUTION__),
  channel: updateChannel,
})

// @@@5737 两道闸,缺一不可:
//  ① 源:查**自己这条通道**的 feed(正式↔正式、Beta↔Beta)。打包期 app-update.yml 烧的就是同一个值,
//     不再运行期覆盖 —— 覆盖成别条通道正是 #5737 那个洞:拿另一个应用的包去原地换,签名判据必不过。
//  ② 目标:正式通道拒收预发布版(即便 feed 被误发,#2177 最初就是照这条假设查的);Beta 通道整条
//     都是预发布版,只挡形状不对的。见 rejectPrereleaseTarget。
// allowDowngrade 保持默认 false:feed 比本地旧时(如 Windows feed 尚停在 0.0.1)只是不提示。
// 只在打包版设:dev 下 electron-updater 本就因缺 app-update.yml 报错(开发者不该被线上 feed 打扰),
// 设了反而会让 dev 的手动「检查更新」真去查线上 feed —— 保持 dev 行为不变。
if (!updaterPolicy.enabled) {
  if (app.isPackaged) updaterLogger.warn({ reason: updaterPolicy.reason }, updaterPolicy.messageKey)
} else if (updateFeedConfig) {
  autoUpdater.setFeedURL(updateFeedConfig)
} else {
  // 不可达:没有通道的 tier 在 resolveUpdaterPolicy 里就被关掉了。真走到这儿说明那两处判断分叉了 ——
  // 而分叉的表现会是「更新器起来了但查的是空地址」,静默失败,所以在这里喊出来。
  updaterLogger.error(
    { channel: updateChannel },
    '[updater] 通道已启用却没有 feed 地址 —— resolveUpdateChannel 与 resolveUpdaterPolicy 判断分叉'
  )
}

type UpdateCheckResult = {
  success: boolean
  // downloaded-manual = mac dmg 半自动路径(#663):安装包已下载并打开,等用户拖装,无 quitAndInstall
  // idle = 这个进程还没查过 —— 只作为状态源的初值出现,不由任何一次检查产生。
  status: 'idle' | 'available' | 'downloading' | 'not-available' | 'downloaded' | 'downloaded-manual' | 'disabled' | 'error'
  updateInfo: unknown | null
  /** 只给 `downloading` 用:0–100;还没有第一条进度时不带。 */
  percent?: number
  /**
   * 渲染层拿来查词表的 key。⚠️ 这里**不放成品文案** —— 主进程没有界面语言这个概念
   * (用户随时可切),发成品串等于用打包时的语言钉死运行时的界面,英文壳下就漏中文
   * (owner 2026-09-05 实测的正是这一类)。文案在 `i18n/locales/<locale>/settings.ts` 的 `about.*` 段。
   */
  messageKey?: string
  /** 只给 `error` 用:updater 吐的原始报错,不是产品文案,不进词表。 */
  message?: string
}

/**
 * @@@5837 更新状态是主进程的一个**值**,不是一串发过就没的事件。
 *
 * 出事的形状:「包已经下好、等你按一下」只在 update-downloaded 那一刻推一次,之后就只活在
 * 渲染层攒的 React state 里。整窗重载、用户关掉横幅、下好的那一刻窗口不在 —— 任意一条都会把它
 * 弄丢,而**唯一的安装入口**(横幅的「立即重启更新」/ 关于页的「重启以安装」)全挂在它上面。
 * owner 2026-09-18 实测:包 10:01 就下好躺在本地,11:24 连按三次「检查更新」,三次都答
 * 「发现新版本」,界面上一个能按的东西都没有,更新做不下去。
 *
 * 所以现在它是一个可以**问**的值(`updates:state`):主进程记着,界面什么时候上来都能取到。
 * 推送照旧,但推送只是「顺便告诉你一声」,不再是这条事实唯一的载体 —— 因此也不必在每一个
 * 「界面可能丢了」的地方各补一次推送。
 */
let updaterState: UpdateCheckResult = { success: true, status: 'idle', updateInfo: null }

/** 状态源的**唯一写入口**:先落到值上,再顺便推一条给界面。退不回去的东西也不推。 */
function emitUpdateStatus(payload: UpdateCheckResult): void {
  if (!updateStateAdvances(updaterState.status, payload.status)) {
    updaterLogger.info(
      { kept: updaterState.status, dropped: payload.status },
      `已经有下好的包在等用户按下,忽略 ${payload.status}`,
    )
    return
  }
  updaterState = payload
  sendUiEvent(MAIN_UI_EVENTS.updateStatus, payload)
}

// @@@2177 第二道闸:更新目标必须是稳定版。命中预发布版 = 稳定 feed 被误发了 beta(发布事故),
// 此时按 spec 不向任何人提示它;告警留痕(fail loud),对用户呈现「已是最新版本」——没有可更新的
// 稳定目标,与 spec「最新发布的是测试版 → 不提示任何人」一致。返回 true 表示已拦截。
function rejectPrereleaseTarget(updateInfo: unknown, where: string): boolean {
  if (!shouldRejectUpdateTarget(updateInfo, updateChannel)) return false
  const version = (updateInfo as { version?: unknown } | null)?.version
  console.warn(
    `[updater] 拒绝把这条当更新目标(${where}): ${String(version)} — ${updateChannel} 通道的 feed ${String(updateFeed)} 疑似被误发`
  )
  return true
}

async function checkForUpdates(): Promise<UpdateCheckResult> {
  if (!updaterPolicy.enabled) {
    updaterLogger.warn(
      { reason: updaterPolicy.reason },
      `check blocked (${updaterPolicy.reason}): ${updaterPolicy.messageKey}`,
    )
    return {
      success: false,
      status: updaterPolicy.status,
      updateInfo: null,
      messageKey: updaterPolicy.messageKey,
    }
  }
  try {
    const result = await autoUpdater.checkForUpdates()
    const updateInfo = result?.updateInfo ?? null
    // @@@2177 同一道闸也盖住手动检查(About 页「检查更新」直接吃这个返回值,不经 update-available 事件)
    // @@@5837 界面该看到什么,**以状态源为准**:去问一声 feed 并不比主进程已经知道的更权威。
    // 包下好了在等他按一下,却答「发现新版本」就是把人送进死路 —— 静默路径下「发现新版本
    // [更新]」那条横幅根本不会出现(见 startSilentDownload),关于页于是只剩一行字。
    // 关于页早就认得 'downloaded'(会显示「重启以安装」),只是以前没人给得出这个值。
    // 正在下也一样:答「发现新版本」等于说「还没开始」,而包正下到一半。
    if (
      updaterState.status === 'downloading' ||
      updaterState.status === 'downloaded' ||
      updaterState.status === 'downloaded-manual'
    ) {
      return updaterState
    }
    const isUpdateAvailable =
      result?.isUpdateAvailable === true && !rejectPrereleaseTarget(updateInfo, 'checkForUpdates')
    return {
      success: true,
      status: isUpdateAvailable ? 'available' : 'not-available',
      updateInfo,
      messageKey: isUpdateAvailable ? 'about.updateAvailable' : 'about.updateUpToDate'
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    console.warn('[updater] check failed:', message)
    return {
      success: false,
      status: 'error',
      updateInfo: null,
      message
    }
  }
}

// 下载进度/完成经状态值回流渲染层(update-flow.ts);两个入口:静默下载(@@@5576)与用户点「更新」(@@@1578)。
// @@@663 mac 老包走 dmg 半自动:下载 dmg(按架构+sha512 校验)→ shell.openPath 打开,用户拖装+系统
// 授权。@@@5576 起这条路只留给 ad-hoc 存量包,签名包走原生 Squirrel(判据见 shouldUseDmgPath)。
let dmgDownloadInFlight = false // 重入闸:双击/双窗口重复触发时后到的直接忽略,不并发下同一包

function startMacDmgDownload(): void {
  if (dmgDownloadInFlight) return
  dmgDownloadInFlight = true
  void downloadMacDmgUpdate()
    .catch((err) => {
      const message = err instanceof Error ? err.message : String(err)
      console.warn('[updater] mac dmg download failed:', message)
      emitUpdateStatus({ success: false, status: 'error', updateInfo: null, message })
    })
    .finally(() => { dmgDownloadInFlight = false })
}

function downloadUpdate(): void {
  if (!updaterPolicy.enabled) {
    emitUpdateStatus({
      success: false,
      status: updaterPolicy.status,
      updateInfo: null,
      messageKey: updaterPolicy.messageKey,
    })
    return
  }
  updateFlow.download()
}

async function downloadMacDmgUpdate(): Promise<void> {
  // 快照:30min 周期 check 可能在下载中途覆写 lastUpdateInfo,完成事件必须报实际下的那个版本
  const info = updateFlow.lastUpdateInfo
  const files = info?.files
  if (!files?.length) throw new Error('没有可用的更新文件信息(先等 update-available)')
  const file = pickMacDmgFile(files, process.arch)
  // @@@2177 base 必须与 setFeedURL 覆盖后的源同一个:feed yml 里的 url 是相对文件名,拿打包内
  // app-update.yml 的 base(beta 包=beta 目录)去拼稳定包名只会 404。改读同一常量,两者不可能错位。
  const dmgPath = await downloadDmg({
    // dmg 的 base 必须与 setFeedURL 用的同一个 —— feed yml 里的 url 是相对文件名。
    fileUrl: new URL(file.url, updateFeed ?? '').toString(),
    expectedSha512: file.sha512,
    destDir: app.getPath('temp'),
    // @@@1961 dmg 手动下载也报进度(原生路径靠 autoUpdater download-progress)。
    onProgress: (received, total) => updateFlow.markDownloading(total > 0 ? (received / total) * 100 : 0)
  })
  const openError = await shell.openPath(dmgPath)
  if (openError) throw new Error(`打开安装包失败: ${openError}`)
  emitUpdateStatus({
    success: true,
    status: 'downloaded-manual',
    updateInfo: info,
    messageKey: 'about.updateDownloadedManual'
  })
}

// @@@5747 安装这一步曾经整个卡死过(owner 2026-09-17 实测):包下好了、Squirrel 的 ShipIt 也备好了,
// 但进程从没退出,界面永远停在「正在重启…」。事后翻现场只能靠 ShipIt 自己的日志 —— 我们这侧一条都没有。
// 所以这条路径现在满足三件事:
//   ① 每一步都留痕(下面的 updaterLogger),下次再卡有得查;
//   ② 有看门狗,库那条路若卡在「等一个不会再来的事件」上,到点我们自己走停机退出 ——
//      ShipIt 已经备好包,退出即安装。宁可少一次自动重开,也不能让人对着「正在重启…」干等;
//   ③ 退出时**不用硬杀**(见 before-quit 里的 exit 分支):硬杀会连 Squirrel 的「装完重开」一起跳过。
// @@@5793 Squirrel 备好包了没。退出那一刻据此决定还要不要留交接余量 —— 备好了就没什么可等的。
let squirrelStagedUpdate = false
if (process.platform === 'darwin') {
  try {
    nativeAutoUpdater.on('update-downloaded', () => {
      squirrelStagedUpdate = true
    })
  } catch (error) {
    updaterLogger.warn({ error: String(error) }, '[updater] 订不上原生 update-downloaded,交接按兜底路径走')
  }
}

// 顺序、看门狗、重复按下这三件事在 ./update-quit 里,连同 #5793 的根因一起写在那个文件的头注释。
const updateQuit = createUpdateQuit({
  markQuitIntent: () => {
    isQuitting = true
  },
  // NSIS shows installation progress and relaunches the app when installation finishes.
  handOff: () => autoUpdater.quitAndInstall(false, true),
  quitApp: () => app.quit(),
  logInfo: (detail, message) => updaterLogger.info(detail, message),
  logWarn: (detail, message) => updaterLogger.warn(detail, message),
  logError: (detail, message) => updaterLogger.error(detail, message),
})

// 发现 → 静默下载 → 下好 → 按下安装的接线在 ./update-flow(检查失败与下载失败的分界写在那个文件头)。
const updateFlow = createUpdateFlow({
  updater: {
    onUpdateAvailable: (listener) => { autoUpdater.on('update-available', listener) },
    onUpdateNotAvailable: (listener) => { autoUpdater.on('update-not-available', listener) },
    onDownloadProgress: (listener) => { autoUpdater.on('download-progress', listener) },
    onUpdateDownloaded: (listener) => { autoUpdater.on('update-downloaded', listener) },
    onError: (listener) => {
      autoUpdater.on('error', (error) => {
        console.warn('[updater] error:', error.message)
        listener(error)
      })
    },
    checkForUpdates: () => autoUpdater.checkForUpdates(),
    downloadUpdate: () => autoUpdater.downloadUpdate(),
  },
  enabled: updaterPolicy.enabled,
  getStatus: () => updaterState.status,
  emit: emitUpdateStatus,
  onReady: () => sendUiEvent(MAIN_UI_EVENTS.updateReady),
  rejectTarget: (info) => rejectPrereleaseTarget(info, 'update-available'),
  dmg: {
    applies: (info) => process.platform === 'darwin' && shouldUseDmgPath(info?.files, localSigning()),
    start: startMacDmgDownload,
  },
  updateQuit,
  logInfo: (message, detail) => updaterLogger.info(detail ?? {}, message),
  logWarn: (message, detail) => updaterLogger.warn(detail ?? {}, message),
})

function installUpdate(): Promise<void> {
  return updateFlow.install()
}

// @@@2177 tier 不参与门控是有意的:beta 包也 check,但查的是稳定 feed(见上 setFeedURL),所以它只会在
// 出了新稳定版时提示——正是 product spec 要的「本地装 beta 也照常提示更新到新稳定版」。
// @@@1560/#1578 自动检测（仅检测，不自动下载）：仅打包版(packaged 且非 test)自动 check —— 启动后延迟 10s
// (避开冷启高峰) + 每 30min 定时。autoDownload=false → 命中只发 update-available(经 preload 推渲染层
// banner「更新/稍后」)，用户点「更新」才 downloadUpdate()。dev / IS_TEST 不 check。check 失败仅告警、不阻断。
const AUTO_UPDATE_INTERVAL_MS = 30 * 60 * 1000
const AUTO_UPDATE_INITIAL_DELAY_MS = 10 * 1000
function startAutoUpdateChecks(): void {
  if (!updaterPolicy.enabled || IS_TEST_MODE) return
  setTimeout(() => { void checkForUpdates() }, AUTO_UPDATE_INITIAL_DELAY_MS)
  setInterval(() => { void checkForUpdates() }, AUTO_UPDATE_INTERVAL_MS)
}

/**
 * @@@5301 等系统给出真的结论,而不是「我调用了 show() 就算弹了」。
 *
 * macOS 从 Electron 42 起走 UNNotification:`show()` 只是把请求交给系统,系统可能当场拒掉
 * (未签名、未授权……),这时 Electron 发的是 `failed`,并带着系统给的原因;成功入列才发 `show`。
 * 原来的代码在 `.show()` 之后无条件写 `displayed = true` —— 那是个**假读数**:通知没弹时,
 * 产品这一侧一个字都说不出来(owner 2026-09-09:「现在失败都不知道失败在那」)。
 *
 * ⚠️ `shown` 只代表**系统收下了这条请求**,不等于用户眼前真的出现了横幅 —— 提醒样式是「无」时,
 * 它会被直接归档进通知中心,而这一层 Electron 读不到。所以 ❌ 不要把 `shown` 讲成「用户看见了」。
 */
const NOTIFICATION_OUTCOME_TIMEOUT_MS = 5000

type NotificationOutcome =
  | { outcome: 'shown' }
  | { outcome: 'rejected'; error: string }
  | { outcome: 'unknown' }

function awaitNotificationOutcome(notification: Notification): Promise<NotificationOutcome> {
  return new Promise((resolve) => {
    let settled = false
    const settle = (result: NotificationOutcome): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve(result)
    }
    // 超时不叫成功也不叫失败:这条路上没有第三个事件,读不到就如实说读不到。
    const timer = setTimeout(() => settle({ outcome: 'unknown' }), NOTIFICATION_OUTCOME_TIMEOUT_MS)
    notification.once('show', () => settle({ outcome: 'shown' }))
    notification.once('failed', (_event, error) => settle({ outcome: 'rejected', error: String(error) }))
    notification.show()
  })
}

async function showAppNotification(params: unknown): Promise<{
  success: boolean
  displayed: boolean
  unsupported?: boolean
  error?: string
}> {
  const input = params as { title?: unknown; body?: unknown; chatId?: unknown; silent?: unknown } | null
  if (typeof input?.title !== 'string' || input.title.trim().length === 0) {
    throw new Error('Notification title is required')
  }

  const payload: AppNotification = {
    title: input.title.trim(),
    body: typeof input.body === 'string' ? input.body : '',
    chatId: typeof input.chatId === 'string' && input.chatId.length > 0 ? input.chatId : null,
    createdAt: new Date().toISOString(),
    displayed: false
  }
  if (!(await notificationGate.usable())) {
    return { success: true, displayed: false, unsupported: true }
  }
  if (IS_TEST_MODE) {
    return { success: true, displayed: false }
  }

  // @@@5301 提示音开关。从前不传 `silent`,走操作系统默认 = 一律响,用户在 app 里关不掉。
  // 缺省仍是响(`silent: false`),只有渲染层显式说了静音才静音。
  const notification = new Notification({
    title: payload.title,
    body: payload.body,
    silent: input.silent === true
  })
  notification.on('click', () => clickNotification(payload))
  const result = await awaitNotificationOutcome(notification)
  if (result.outcome === 'rejected') {
    notificationLogger.warn(
      { title: payload.title, error: result.error },
      `[notification] 系统拒绝显示: ${result.error}`
    )
    return { success: false, displayed: false, error: result.error }
  }
  payload.displayed = result.outcome === 'shown'
  return { success: true, displayed: payload.displayed }
}

function clickNotification(notification: AppNotification): void {
  mainWindow?.show()
  mainWindow?.focus()
  sendUiEvent(MAIN_UI_EVENTS.notificationClicked, { chatId: notification.chatId })
}

app.setAboutPanelOptions({
  applicationName: '咕咕',
  applicationVersion: app.getVersion(),
  copyright: `© ${new Date().getFullYear()} 咕咕`
})

/** 兜底路径上给 Squirrel 写盘 + 起 ShipIt 的余量。正常路径不走这里(见 exit 里的判断)。 */
const SQUIRREL_HANDOFF_GRACE_MS = 5_000

const shutdownLogger = createLogger('shutdown')
const reportShutdownPhase = (event: ShutdownPhaseEvent): void => {
  const error = event.error ? ` error=${JSON.stringify(event.error)}` : ''
  shutdownLogger.info(event, `[shutdown] phase=${event.phase} state=${event.state} elapsedMs=${event.elapsedMs}${error}`)
}

// 正常退出:留一句,下次开机收残据此说「重启打断了这一轮」,❌ 说成没正常退出。
app.on('before-quit', () => noteExitReason(app.getPath('userData'), 'restart'))
app.on('before-quit', createRuntimeBeforeQuitHandler({
  getHost: () => deviceRuntimeHost,
  setQuitting: (value) => {
    isQuitting = value
    // @@@5793 停机已经开始,看门狗的使命结束 —— 别在停机中途再捅一次 app.quit()。
    if (value) updateQuit.noteShutdownStarted()
  },
  exit: (code) => {
    const hardExit = (): never =>
      (process as NodeJS.Process & { reallyExit: (exitCode: number) => never }).reallyExit(code)
    // @@@5747 为更新而退出时,最后一步**不能**一上来就硬杀:reallyExit 绕过 Electron 的退出流程,
    // 而 Squirrel 的「装完并重新打开」正挂在那条被绕开的路上 —— 这就是「装完不会自己起来」的成因。
    // 停机三段此刻已经跑完(agent、PTY 都收干净了),剩下的只是让 Squirrel 接手。
    // 交给 Squirrel 只是 mac 的事。Windows / Linux 上 electron-updater 的 quitAndInstall 早在按下时
    // 就已经起好了安装器(NSIS `Executing … --updated`),这里再调原生 autoUpdater 只会抛
    // 「No update available, can't quit and install」再落到硬退(owner 的 Chole 上每次更新都是这样)。
    if (!updateQuit.forUpdate || process.platform !== 'darwin') hardExit()
    updaterLogger.info({ squirrelStagedUpdate }, '[updater] 停机完成,交给 Squirrel 安装并重新打开')
    try {
      nativeAutoUpdater.quitAndInstall()
    } catch (error) {
      updaterLogger.error({ error: String(error) }, '[updater] 交接失败,硬退 —— 包已备好,退出即安装')
      hardExit()
    }
    // @@@5793 包已经备好时,这里**没有任何东西可等**:ShipIt 从收到安装请求起就在等我们退
    // (owner 实测:我们一退,它 91 毫秒后就开装)。原先无条件等的那 5 秒,两次更新两次都是等到
    // 超时才走 —— 纯粹的空等。只有在 Squirrel 还没备好包的兜底路径上,上面那一句才是真正在备包,
    // 那时才需要给它写盘的余量。
    if (squirrelStagedUpdate) hardExit()
    const handoff = setTimeout(() => {
      updaterLogger.error({}, '[updater] Squirrel 未在交接余量内接管,硬退兜底')
      hardExit()
    }, SQUIRREL_HANDOFF_GRACE_MS)
    handoff.unref()
  },
  warn: (message) => console.warn(message),
  reportPhase: reportShutdownPhase,
  stopOwnedResources: stopDesktopOwnedResources,
  flushDurableStorage: () => session.defaultSession.flushStorageData(),
}))

// 崩溃/信号路径同步回收 Desktop 自己拥有的**每一条**原生腿的进程组。
//
// @@@5163 - 这里原来只收 Codex app-server —— 那是它写下时的实情(那时 codex 是唯一的原生腿)。
// 之后 opencode serve/attach(#4607)与 droid daemon 各自又拉起一个 sidecar,却没被加进来,
// 于是 gugu 被 TERM / 崩溃退出时它们**活下来**:mac1 实测停掉 app 之后 serve pid 84374 仍在,
// 日积月累攒到 45 个常驻 `opencode serve`,每个还占着一个 loopback 端口。
// 各腿自己那条 `process.once('exit')` 挡不住这一格 —— 信号路径不保证走到它。
// ⇒ 这个回收点按「Desktop 拥有的原生腿」逐条收,加一条腿就在这里加一行,
//    ❌ 不要再让某条腿只靠自己的 exit 钩子。
const killEnginesOnCrash = (label: string): void => {
  const reap = (leg: string, run: () => void) => {
    try {
      run()
    } catch (err) {
      shutdownLogger.error({ err, label, leg }, 'native leg process-group reap failed')
    }
  }
  // @@@5163 回收点必须留下一条**同步**痕迹。用 logger 记不行 —— 它是异步写,
  // 而这里离进程真正死掉只剩几毫秒,那行日志永远 flush 不到盘(本仓在 #4965 上吃过同一个亏)。
  // 所以这里 appendFileSync 一行:它在 kill(2) 之前落地,能回答「这个回收点有没有被调到」。
  try {
    appendFileSync(join(logDir, 'reap-probe.log'), `${new Date().toISOString()} reap-begin label=${label}\n`)
  } catch { /* 探针不许反噬关停 */ }
  shutdownLogger.info({ label }, 'native leg reap: begin')
  reap('codex-app-server', killAllCodexAppServerProcessGroupsSync)
  reap('opencode-serve-attach', () => opencodeServeAttachSessionDelivery.disposeSync())
  reap('droid-daemon', () => droidDaemonSessionDelivery.disposeSync())
  reap('extension-programs', () => emdashBridge?.emdashExtensionPrograms().killAllSync())
  reap('remote-tunnel', () => {
    closeTunnelMachines?.()
    tunnelEndpoint?.stop()
  })
  shutdownLogger.info({ label }, 'native leg reap: done')
  try {
    appendFileSync(join(logDir, 'reap-probe.log'), `${new Date().toISOString()} reap-done  label=${label}\n`)
  } catch { /* 同上 */ }
}
// #156 server 模式下这两个信号就是「停掉服务」(`gugu-server stop`、systemd、守护进程收账号进程):先停设备循环 ——
// 它最后把设备行标成离线,名下别的设备当场看见,❌ 等两分钟租约过期、看起来和崩溃一样 —— 再同步收组退出。
// 有上限(停不下来照样退);再来一个信号 = 不等了。桌面上信号仍是立即终止(正常退出走 before-quit)。
const SERVER_SIGNAL_STOP_TIMEOUT_MS = 5_000
let signalStopping = false
const exitOnSignal = (label: 'SIGINT' | 'SIGTERM', code: number): void => {
  // 有人要它停(stop / systemd / 守护进程收账号进程):留一句,开机收残据此说「重启打断了这一轮」(守护进程换版时先写了 update,不改)。
  noteExitReason(app.getPath('userData'), 'restart')
  const finish = (): void => {
    killEnginesOnCrash(label)
    process.exit(code)
  }
  const host = deviceRuntimeHost
  if (!SERVER_MODE || !host || signalStopping) return finish()
  signalStopping = true
  void stopRuntimeHostWithTimeout(host, SERVER_SIGNAL_STOP_TIMEOUT_MS)
    .catch((error: unknown) => shutdownLogger.warn({ label, error: String(error) }, 'device runtime stop on signal failed'))
    .finally(finish)
}
process.on('SIGINT', () => exitOnSignal('SIGINT', 130)) // 128 + SIGINT(2)
process.on('SIGTERM', () => exitOnSignal('SIGTERM', 143)) // 128 + SIGTERM(15)
process.on('SIGCONT', () => {
  // Node timers resume with wall-clock debt after SIGSTOP. Provider turn
  // completion waiters must not consume that debt as a lost turn.
  resumeAllCodexAppServerTurnWaiters()
})
process.on('uncaughtException', (err) => {
  // @@@logging(#2382)- 就地升级成结构化,❌ 不另起一对处理器(那会让每次崩溃出现两行两套措辞)。
  // @@@4965 - 先同步落盘再决定去留:pino 是异步写,`process.exit(1)` 之后永远 flush 不到,
  // 那正是 #4965 里堆栈丢失、根因查不动的原因。
  const verdict = classifyFatal(err)
  recordFatalSync({ dir: logDir, verdict, source: 'uncaughtException', err })
  if (verdict === 'environment') {
    // @@@4965 - 合盖睡眠/断网抛出的 net::ERR_* 与超时不是「程序坏了」,杀进程只会让用户
    // 「合一下盖软件全退了」。fail loud 照旧(响亮记账 + 崩溃文件留痕),但❌ 不再拿进程陪葬。
    createLogger('process').error({ err }, '未捕获异常判为环境故障(网络/电源)— 已记账,进程继续')
    return
  }
  createLogger('process').error({ err }, '未捕获异常 — 收引擎进程组后退出')
  killEnginesOnCrash('uncaughtException')
  process.exit(1) // fail loud:非零退出,别把崩溃咽下装没事
})
process.on('unhandledRejection', (reason) => {
  // 不退出(未必致命),仅让原本静默的 rejection 可见(fail loud);引擎清扫留给真正的致命/信号路径。
  // 落盘同样走 crash 文件:退出登录会重启进程,主日志会被下次启动轮转掉,而这些拒绝是排障的第一现场。
  recordFatalSync({ dir: logDir, verdict: classifyFatal(reason), source: 'unhandledRejection', err: reason })
  createLogger('process').error({ reason }, '未处理的 Promise 拒绝')
})
// will-quit:before-quit 之后、真退出前的最后兜底(优雅路径已 stopAll → sessions 空 → no-op)。
app.on('will-quit', () => {
  killEnginesOnCrash('will-quit')
})

app.on('second-instance', (_event, argv) => {
  // A re-launch while running (e.g. `open -a 咕咕`, double-click) hits this instead of starting a new
  // process — bring the hidden-to-tray window back.
  focusMainWindow()
  // #6387 Windows / Linux 上点一条咕咕链接 = 系统用链接当参数再启动一次咕咕,链接就在 argv 里。
  const link = argv.find((arg) => arg.startsWith(`${GUGU_LINK_SCHEME}://`))
  if (link) handleGuguLink(link)
})

// #6387 macOS 把链接交给 open-url(冷启动时也是,所以要在 ready 之前就挂上)。
app.on('open-url', (event, url) => {
  event.preventDefault()
  handleGuguLink(url)
})

/**
 * #6387 这个版本认的链接前缀:正式版 gugu://,Beta gugu-beta://,源码起的开发版 gugu-dev://。
 * 与 electron-builder.cjs 的 protocols、扩展侧 linkTo 用的是同一条规则(core 的 linkScheme.mjs)。
 */
const GUGU_LINK_SCHEME = guguLinkScheme({ tier: process.env.GUGU_TIER, devLaunch: Boolean(process.defaultApp) })
/** 会话页后端还没起来时到的链接,起来后按到达顺序处理。 */
const pendingGuguLinks: string[] = []
let guguLinksReady = false

function handleGuguLink(url: string): void {
  if (!url.startsWith(`${GUGU_LINK_SCHEME}://`)) return
  if (!guguLinksReady || !emdashBridge) {
    pendingGuguLinks.push(url)
    return
  }
  focusMainWindow()
  void emdashBridge.openEmdashLink(url).then(
    (outcome) => {
      if (outcome.kind !== 'failed') return
      // 人点了链接、在等:打不开要当面说清为什么,❌ 只记日志。
      const copy = currentHostCatalog().extensionLinks
      const detail = {
        'not-installed': copy.notInstalled,
        disabled: copy.disabled,
        'no-such-tab': copy.noSuchTab,
        'no-session': copy.noSession,
        'open-failed': copy.openFailed,
      }[outcome.reason]
        .replace('{name}', outcome.name)
        .replace('{detail}', outcome.detail ?? '')
      const options = { type: 'warning' as const, message: copy.title, detail }
      void (mainWindow && !mainWindow.isDestroyed()
        ? dialog.showMessageBox(mainWindow, options)
        : dialog.showMessageBox(options))
    },
    (error: unknown) => {
      createLogger('extension-link').error({ err: error, url }, 'opening an extension link failed')
    },
  )
}

function flushPendingGuguLinks(): void {
  guguLinksReady = true
  // Windows / Linux 冷启动:链接是这一次启动的参数。
  const coldStart = process.argv.find((arg) => arg.startsWith(`${GUGU_LINK_SCHEME}://`))
  if (coldStart) pendingGuguLinks.push(coldStart)
  for (const url of pendingGuguLinks.splice(0)) handleGuguLink(url)
}

// The bundled session-page bridge owns its database, workers, and task runtime lifecycle. Its type is the module itself
// (B2, 10-17): a hand-written shape beside it drifted, and the compiler checks the real exports at every call.
type EmdashBridgeModule = typeof import('./sessionpage/emdash-main-bridge')
let sessionpageLocalSessionSource: HostLocalSessionSource | null = null

async function localSessionPeers(
  emdash: EmdashBridgeModule,
  auth: RuntimeAuth,
  sessionId?: string,
): Promise<LocalSessionPeer[]> {
  return resolveSessionpageSessionPeers({
    listRoster: () => listAgents(process.env, { includeGuests: true }),
    ownerUserId: auth.userId,
    sessionId,
    lookupIdentities: (agentUserIds) => loadSessionpageCanonicalAgentIdentities(auth, agentUserIds, Boolean(sessionId)),
    listSessionFacts: () => emdash.emdashSessionpageSessionFacts(),
  })
}
// #5048 信封的 `from` 一格是 producer 的义务(spec delivery-envelope):拿得到 owner token 就解析发信人的
// 昵称/咕咕号再拼壳。这里曾有三处传空 map(聊天页首轮、roster 直投、agent.create 首句),owner 自己的
// 第一条消息在会话页就显示成 `user:<uuid>`。解析失败只降级为「省略 from + warn」,❌ 阻塞投递。
async function envelopeSenderIdentities(
  senderUserId: string,
  accessToken: string | undefined,
): Promise<Map<string, GuguIdentity>> {
  try {
    return await resolveGuguIdsForInbox([senderUserId], accessToken)
  } catch (error) {
    createLogger('sessionpage/envelope').warn(
      { senderUserId, err: error instanceof Error ? error.message : String(error) },
      'envelope sender identity lookup failed; delivering with from_id only',
    )
    return new Map<string, GuguIdentity>()
  }
}
/**
 * 起会话时那一侧递过来的全部事实 —— **认真身,不再手抄**(#5192)。
 *
 * ## 为什么这里只剩两行别名
 *
 * 这两个类型曾是 `emdash-mcp-injector.ts` 里那份的**手抄副本**,而副本会静默停在旧形状:
 * 真身加了字段、副本不加,**typecheck 照样绿** —— 属性是**展开**进去的(`{ ...info }`),
 * 而 TS 的多余属性检查只管对象字面量、不管展开。这个坑咬过三次:
 *   ① `EmdashPlatformInjection` 的副本漏了 `contextWindow`;
 *   ② `mcpDisabledServers` 加进真身、副本没加 ⇒ `/mcp` 关掉的那台照样被装载,
 *      端到端症状是「界面说关了、工具表纹丝不动」;
 *   ③ 删这份副本时才发现它**当时已经又停在旧形状**:真身有 `permissionMode`,副本没有。
 * 副本旁边一直有一条写着上一次事故的警告,它没挡住第二次 —— 因为那条警告长在**副本**旁,
 * 而加字段的人眼睛在**真身**上。⇒ 唯一关得掉这个坑的是删掉副本。
 *
 * ## 为什么是 `Omit<…, 'lifecycle'>` 而不是直接用真身
 *
 * 真身里 `lifecycle` 是**必填**,而本文件的 `ptySessionCallerContext()` 只投影六个 id 字段
 * (它构造的是「PTY 那条腿的调用方坐标」,那时还没有 lifecycle 这回事)。
 * 直接用真身会让那个投影编译不过 —— 而它不该被迫编一个 lifecycle 出来。
 */
type EmdashSessionStartInfo = Omit<EmdashStartInfo, 'lifecycle'>
// ❌ 这里曾是 EmdashPlatformInjection 的一份手抄副本。它与 emdash-platform-injector 的真身、与
// acpPlatformInjectionSchema 三处各写一遍同一个载荷,而副本停在了旧字段集上 —— 本 PR 给载荷加
// `contextWindow` 时就漏了它,typecheck 照样绿:属性是**展开**进去的,而 TS 的多余属性检查只管
// 字面量、不管展开,所以那条边界上一个编译期保护都没有。删掉副本、认真身,才谈得上「加字段会被编译器拦住」。
type LocalSessionBridgeContext = EmdashSessionStartInfo
// 会话页那侧把 override.env 合进 Record<string, string> 再交给 pty;NodeJS.ProcessEnv 的值类型是
// string | undefined,过不了编译期契约(@@@4865 之前被运行时 createRequire 的 cast 掩住)。
// 运行时 process.env 从不含 undefined 值(赋 undefined 会被转成字符串),这里只是把类型说实。
function definedEnv(env: NodeJS.ProcessEnv): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [key, value] of Object.entries(env)) if (value !== undefined) out[key] = value
  return out
}
let emdashBridge: EmdashBridgeModule | null = null
let reconcileSessionpagePlatformOnResume: (() => Promise<void>) | null = null
let sessionpagePlatformRecovery: SessionpagePlatformRecoveryCoordinator | null = null
let sessionpagePlatformRecoveryHooks: SessionpagePlatformHooks | null = null
// @@@4865 会话页主进程图是本次 rollup 的一个入口 chunk(dist-electron/emdash-main-bridge.js),不再是
// closeBundle 里另起 esbuild 的外部产物。它在 app.whenReady 里被动态 import 一次、存到这里;
// 之后 loadEmdashBridge 同步取用。类型就是模块本身(typeof import),「桥过期」由编译器在每个调用点判。
let emdashBridgeModule: EmdashBridgeModule | null = null
let localSessionActionDispatcher: ((
  auth: RuntimeAuth,
  context: LocalSessionBridgeContext,
  action: unknown,
  signal: AbortSignal,
) => Promise<unknown>) | null = null
let crossMachineSessions: CrossMachineSessions | null = null
let crossMachineRequester: ReturnType<typeof createDeviceRpcRequester> | null = null
let deviceActionCallerInstance: DeviceActionCaller | null = null
/** #7317 每个任务的 agent 用电脑的画面与每一步,给 Computer Use 的「电脑」页签(咕咕 server 上没有:那里没有窗口)。 */
let computerUsePreviewInstance: ComputerUsePreview | null = null

/**
 * #7317 agent 的一步电脑控制(`device_call computer.*`)开始了:记给这个任务的「电脑」页签,返回「它怎么结束的」那一下。
 * 预览出了什么事都只记一笔(step 两头都不抛),❌ 挡 agent 这一步、❌ 让它多等:那台设备是不是这台电脑,查到再补。
 */
function computerStepStarted(
  context: { projectId: string; sessionId: string; cursorSession?: string },
  call: { device: string; name: string; args: Record<string, unknown> },
): ((ended: DeviceActionResult | Error) => void) | null {
  const preview = computerUsePreviewInstance
  if (!preview || !call.name.startsWith('computer.')) return null
  const local = crossMachine().isThisDevice(call.device).catch((error: unknown) => {
    createLogger('computer-use').warn({ err: String(error) }, 'could not tell whether a computer step is on this computer; no live picture for it')
    return false
  })
  return preview.step({ ...context, device: call.device, local, tool: call.name.slice('computer.'.length), args: call.args })
}

/**
 * 设备动作结果里的图(截图、剪贴板里的图)在 data.pictures:提到顶层 `pictures`,交给 MCP 那层变成图片块给 agent 看
 * (withPictures),❌ 让 base64 以文字进上下文。
 */
function hoistDevicePictures(result: DeviceActionResult): unknown {
  if (!result.ok || !result.data || typeof result.data !== 'object' || Array.isArray(result.data)) return result
  const { pictures, ...data } = result.data as { pictures?: unknown }
  if (!Array.isArray(pictures) || pictures.length === 0) return result
  return { ...result, data, pictures }
}

/**
 * Agent native actions stay on this computer; other devices are discovery-only.
 * Local calls go directly to this host. Receiver-side rejection also protects against remote RPC bypasses.
 */
function deviceActionCaller(): DeviceActionCaller {
  if (deviceActionCallerInstance) return deviceActionCallerInstance
  const machines = crossMachine()
  const caller = createDeviceActionCaller({
    listDevices: async () => {
      const auth = await desktopAuthProvider().getAuth()
      if (!auth?.accessToken || !auth.userId) throw new Error('this machine is not signed in to 咕咕')
      const thisId = await localDeviceId()
      // 直接读 gugu_devices 全部行(❌ 经 listDevices:手机行会被「在哪跑」那一份滤掉,而手机正是能被调用的设备)。
      const { data, error } = await makeIdentityClient(auth.accessToken)
        .from('gugu_devices')
        .select('device_id, label, platform, status, last_seen_at, capabilities')
        .eq('user_id', auth.userId)
      if (error) throw new Error(`list devices failed: ${error.message}`)
      return ((data ?? []) as Array<{ device_id: string; label: string | null; platform: string | null; status: string; last_seen_at: string | null; capabilities: Record<string, unknown> | null }>)
        .map((d) => ({
          device_id: d.device_id,
          label: d.label ?? d.device_id,
          platform: d.platform,
          online: d.status === 'online',
          last_seen_at: d.last_seen_at,
          actions: d.capabilities?.actions,
          this_machine: d.device_id === thisId,
        }))
    },
    rpc: async (deviceId, type, payload, options) => {
      if (await machines.isThisDevice(deviceId)) return deviceActionsRuntime().callLocal(type, payload)
      if (!crossMachineRequester) throw new Error('device RPC requester is not ready')
      return crossMachineRequester.call(deviceId, type, payload, options)
    },
  })
  deviceActionsRuntime().setLocalEventSink((payload) => {
    void localDeviceId().then((id) => { if (id) caller.onEvent(id, payload) }, () => undefined)
  })
  return (deviceActionCallerInstance = caller)
}

/** 跨机器的发起方,第一次用到时才装。通道与渲染层同一条规矩:这台桌面用 SSH 装上的机器走 SSH,其余走咕咕云。 */
function crossMachine(): CrossMachineSessions {
  if (crossMachineSessions) return crossMachineSessions
  const requireAuth = async () => {
    const auth = await desktopAuthProvider().getAuth()
    if (!auth?.accessToken || !auth.userId) throw new Error('this machine is not signed in to 咕咕')
    return auth
  }
  const store = sshMachineStore
  const sshMachine = async (deviceId: string) => (store ? findSshMachine(store.list(), deviceId, (await requireAuth()).userId) : null)
  const requester = createDeviceRpcRequester({
    userId: async () => (await requireAuth()).userId,
    openPipe: async (deviceId, handlers) => (sshLinks && ((await sshMachine(deviceId)) || tunnelMachines?.linkMachine(deviceId))
      ? openSshDeviceRpcPipe(sshLinks, deviceId, handlers)
      : openCloudDeviceRpcPipe({ supabase, deviceId, userId: async () => (await requireAuth()).userId, ...handlers })),
    // #7199 第二步:设备推回来的「还在跑」与结果。「收到」之后管道本来就留着(只有超时且没有在途请求才拆),
    // 拆了也无妨:重发同一个 call_id 会重开管道,设备每 5 秒重推结果。
    onEvent: (deviceId, payload) => { deviceActionCallerInstance?.onEvent(deviceId, payload) },
  })
  crossMachineRequester = requester
  app.on('will-quit', () => requester.closeAll())
  return (crossMachineSessions = createCrossMachineSessions({
    thisDeviceId: async () => {
      const id = await localDeviceId()
      if (!id) throw new Error('this machine is not registered as a 咕咕 device yet')
      return id
    },
    listDevices: async () => {
      const auth = await requireAuth()
      return listDevices(makeIdentityClient(auth.accessToken) as unknown as DeviceTableClient, auth.userId, { includePhones: true })
    },
    lookupAgents: async ({ userIds, numbers }) => {
      const auth = await requireAuth()
      const query = (column: 'id' | 'gugu_number', values: Array<string | number>) => makeIdentityClient(auth.accessToken)
        .from('users').select('id, device_id, gugu_number')
        .eq('type', 'agent').eq('owner_user_id', auth.userId).in(column, values)
      const results = await Promise.all([userIds.length ? query('id', userIds) : null, numbers.length ? query('gugu_number', numbers) : null])
      return results.flatMap((result) => {
        if (result?.error) throw new Error(`agent identity lookup failed: ${result.error.message}`)
        return ((result?.data ?? []) as Array<{ id: string; device_id: string | null; gugu_number: number | null }>)
          .map((row) => ({ userId: row.id, deviceId: row.device_id ?? null, guguNumber: row.gugu_number ?? null }))
      })
    },
    requester,
    // #7199 云电脑管家:地址同渲染层(开发实例的 GUGU_CLOUD_COMPUTER_URL,否则这套库的云端函数),带这台桌面登着的用户 JWT。
    cloudComputerState: async () => {
      try {
        const client = await cloudComputerClient()
        return client ? await client.state() : null
      } catch (error) {
        // 这里没开放(云端函数还没配管家,503 not_open):和没配地址一样 = 没有云电脑这回事。
        if (isCloudComputerNotOpen(error)) return null
        createLogger('cloud-computer').warn({ err: String((error as Error)?.message ?? error) }, 'cloud computer state unavailable')
        throw error
      }
    },
    wakeCloudComputer: async (deviceId, signal) => {
      signal?.throwIfAborted()
      const client = await cloudComputerClient()
      if (!client) return false
      // 先认它是不是这个账号的云电脑:问不到管家 = 不知道 ⇒ 照普通离线说(❌ 把一台离线的笔记本说成「云电脑醒不来」)。
      try {
        if ((await client.state(signal)).deviceId !== deviceId) return false
      } catch (error) {
        createLogger('cloud-computer').warn({ deviceId, err: String((error as Error)?.message ?? error) }, 'cloud computer state unavailable; treating the device as plainly offline')
        return false
      }
      const auth = await requireAuth()
      signal?.throwIfAborted()
      const outcome = await wakeCloudComputerUntilOnline({
        client,
        deviceId,
        signal,
        isOnline: async (id) => (await listDevices(makeIdentityClient(auth.accessToken) as unknown as DeviceTableClient, auth.userId))
          .some((row) => row.device_id === id && row.is_online),
      })
      return outcome === 'online'
    },
  }))
}

/** #7199 主进程到云电脑管家的那一条;拿不到地址 = null(这个功能不在)。 */
async function cloudComputerClient() {
  const baseUrl = cloudComputerBaseUrl({ enabled: cloudComputerEnabled(), override: process.env.GUGU_CLOUD_COMPUTER_URL ?? null, supabaseUrl: getSupabaseUrl() })
  if (!baseUrl) return null
  return createCloudComputerClient({
    baseUrl,
    accessToken: async () => {
      const auth = await desktopAuthProvider().getAuth()
      if (!auth?.accessToken) throw new Error('this machine is not signed in to 咕咕')
      return auth.accessToken
    },
    anonKey: getSupabaseAnonKey(),
  })
}

/**
 * S2b 读者触发装配:四个触发(nudge 在 device runtime 里;这里接②回合结束/③唤醒完成/④开机扫)
 * 都收敛到同一个 core 读者入口。deps 每次现装(token 会轮换);没登录就不拉(loud debug,不静默)。
 */
function kickInboxForAgent(agentUserId: string, trigger: string): void {
  // #7225 不等它的一脚:拿不到登录态(含续期被拒的 RuntimeAuthExpiredError)由 kickInboxWhenAuthed 记一行收掉。
  void kickInboxWhenAuthed({
    agentUserId,
    trigger,
    getAuth: () => authProvider?.getAuth(),
    log: createLogger('agent-inbox'),
    kick: (auth) => {
      const accessToken = auth.accessToken
      const deps = agentInboxDepsFromBridge({
        accessToken,
        ownerUserId: auth.userId,
        env: process.env,
        runtimeBridge: createDeviceSessionpageBridge(),
        resolveGuguIds: resolveGuguIdsForInbox,
        fetchThreadMessages: (chatId, threadRootId) => fetchThreadMessagesViaRest(chatId, threadRootId, accessToken),
        overrides: {
          onBatch: ({ agentUserId: batchAgentUserId, rows, units }) => {
            if (process.env.GUGU_SESSION_TEST_HOOKS === '1') {
              createLogger('agent-inbox').info({
                agentUserId: batchAgentUserId,
                rows,
                units,
                trigger,
              }, 'injectBatch')
            }
          },
        },
      })
      kickAgentInboxPull(agentUserId, deps, trigger)
    },
  })
}

const inheritedOwnerTimeZone = ownerTimeZoneFromEnvironment()
if (inheritedOwnerTimeZone) applyOwnerTimeZoneContext(inheritedOwnerTimeZone)

const resumeAccountMessaging = createAccountResumeHandler({
  kickInbox: kickInboxForAgent,
  reconnect: resumeElectronSupabaseRealtime,
  reconcile: async () => { await reconcileSessionpagePlatformOnResume?.() },
  notifyCommands: () => deviceRuntimeHost?.notifyCommandsChanged(),
})

function recordDeviceSleep(sleep: { since: number; until: number; source: 'native-power' | 'fc-confirmed' }): void {
  try { loadEmdashBridge()?.recordConfirmedDeviceSleep(sleep) } catch (error) {
    createLogger('host-resume').error({ error }, 'confirmed sleep could not be recorded')
  }
}

/**
 * spec delivery-routing「session-live 的产地」(#4896):一条会话转为**可投递就绪**时宿主只做这两件事 ——
 * 读者拉一次(云端账本)+ 排一次该会话的本机 outbox(本机账本)。两份账本、同一个就绪时刻;各腿在各自的
 * 就绪点调它(ACP:运行时启动成功;local-session:PTY 注册 live;claude:gugu MCP 送出 tools/list),身份就绪
 * (provisioned)时再调一次,❌ 各配一套。
 * 预算到点(claude overdue)也走这里:让在等的消息经同一条路响亮失败,而不是静默 queued。
 *
 * 为什么 outbox 也要在这里排:收件箱那一脚**够不到用户刚打的那句话**——本机投影只捞 `session-direct` 行,
 * 而新建任务的第一句是 `ordinary`,躺在这条会话的 outbox 里等一次 drain。以前那次 drain 排在 startSession
 * **之后**(session-orchestration),对 codex 就成了死锁 —— 它的 startSession 要等首轮投递到达才返回,
 * 而投递首轮的人排在它后面,双方互等,90s 超时(实测 outbox 里 `{kind:"ordinary",state:"pending"}` 一直没动)。
 * ❌ 不能用收件箱那一脚代替:两者取的不是同一批行。
 */
function onSessionpageSessionLive(agentUserId: string, sessionId: string, trigger = 'session-live'): void {
  kickInboxForAgent(agentUserId, trigger)
  void (async () => {
    const emdash = loadEmdashBridge()
    if (!emdash) return
    await emdash.drainSessionMessageOutboxById(sessionId)
  })().catch((error: unknown) => {
    // 排不动就是首轮送不出去 = 会话会僵在启动态。❌ 不静默吞。
    createLogger('sessionpage/deliver').error(
      { sessionId, agentUserId, trigger, err: error instanceof Error ? error.message : String(error) },
      '会话可用时排 outbox 失败:排队的首轮送不出去,这条会话会僵在启动态',
    )
  })
}

function runLocalSessionAction(
  auth: RuntimeAuth,
  context: LocalSessionBridgeContext,
  action: unknown,
  signal: AbortSignal,
): Promise<unknown> {
  if (!localSessionActionDispatcher) throw new Error('local session actions are unavailable')
  return localSessionActionDispatcher(auth, context, action, signal)
}

// @@@session-graph PTY caller coordinates — the session coordinates a session-page TUI's gugu tools bind to.
// Same five ids the ACP path binds; the PTY start info now CARRIES workspaceId rather than the host
// filling in '' (which every workspace check downstream then read as "workspace not ready", refusing
// spawn/open_in_tab on a session that had a perfectly good workspace). A projection, not a defaults site:
// a missing id must fail where it is missing, not be papered over here.
function ptySessionCallerContext(info: EmdashPtySessionpageStartInfo): EmdashSessionStartInfo {
  return {
    sessionId: info.sessionId,
    projectId: info.projectId,
    workspaceId: info.workspaceId,
    providerId: info.providerId,
    cwd: info.cwd,
  }
}

/**
 * 会话页那条会话的咕咕格子号。
 *
 * 一条 conversation 一个格子（不是一个 agent 一个）：同一个会话页会话可能先后走 claude TUI、
 * codex app-server 与 GUI ACP 三条腿，它们说的是同一条会话，工具面也该是同一个。
 *
 * 前缀故意还叫 `taskpage:`(PR-2 没改):这个 key 是 `<name>-grants.json` 里每一行的主键。tmux 里跑着的 agent 手上的卡
 * 只有地址(slot)和 capability,宿主重启后靠 capability 找回盘上那一行(gugu-mcp-host.ts dormantFor),再从这个 key
 * 认出是哪条会话(stable-mcp-persistence.ts)。改前缀就得迁 grants 文件,不迁的话跑着的卡就认不回来。
 */
function sessionpageSurfaceKey(sessionId: string): string {
  return `taskpage:${sessionId}`
}

// @@@fail-loud(owner 拍板 2026-07-24):会话页起不来(桥缺件/资产损坏/boot 失败)= 应用级
// 顶级错误,App 直接拒绝启动并显式报错——❌ 半残运行(聊天活着、会话页永远转)。
// 诊断日志必须先打(冒烟/CI 靠 FAILED 行断言)再退。错误框挂在主窗口上、不堵主线程,被导航打断的不算
// (sessionpage/fatal-boot.ts)。
const fatalBootDeps: FatalBootDeps = { window: () => mainWindow, dialog, exit: (code) => app.exit(code), log: createLogger('sessionpage') }
function fatalSessionpageBoot(err: unknown): void {
  showFatalSessionpageBoot(err, fatalBootDeps)
}
// 退出登录 = 重启 app(owner 拍板 2026-08-26)。
// 
// 为什么不是「把任务运行时拆掉再装回来」:那个边界看着可拆(bootEmdashModule /
// disposeEmdashModule),实际是**一次性闩** —— dispose 用 `??=` 缓存 promise,第二次调
// 什么都不做;它也不注销 IPC handler(该文件 removeHandler 0 处命中),拆的是模块级单例,
// 还 closeDatabase 却没有对应的再开。硬做成可重入是这个子系统里的立项级改造。
// 
// 不重启会怎样(都实测过,不是推演):
//   1. 会话页整页停在骨架屏 —— 退出登录把它拆了,随后的登录没装回来,只有整页重载能救
//      (同账号同 localStorage,只重载:testid 7→20、骨架 20→0)
//   2. MCP grant 谁先 hydrate 谁盖章 —— grant 表在主进程内存里,重载渲染层碰不到它,
//      换回原账号也解不开,只能重启应用
// 
// 新进程把这两样一起清干净。代价是切账号会看到 app 重启一次,这是明面上的取舍。
/** 退出登录重启时,等 before-quit 走完的上限。三段停机各 5s,留一倍余量后硬杀。 */
const RELAUNCH_EXIT_WATCHDOG_MS = 12_000

ipcMain.handle('app:relaunch', () => {
  // 先让这次 invoke 正常返回再退 —— 否则渲染层那个 await 挂在一个永远不会回的调用上,
  // 日志里只会看到一次无声中断,分不清是重启还是崩了。
  setImmediate(() => {
    // dev 下 vite-plugin-electron 拥有这个进程:Electron 一退,dev server 就跟着收摊,
    // relaunch 起来的新进程会撞上 ERR_CONNECTION_REFUSED。这里不因此改成「dev 不重启」——
    // 那会让开发态走一条产品态永远不走的路径,bug 只在打包后现形。响亮说清楚,让人重跑 pnpm dev。
    if (process.env.VITE_DEV_SERVER_URL) {
      authLogger.warn(
        {},
        'dev 模式:退出登录会重启应用,但 vite dev server 会随本进程一起结束,' +
          '新窗口连不上 —— 这是 dev 独有的,打包产物正常。重新 `pnpm dev` 即可。',
      )
    }
    authLogger.info({}, 'relaunching after logout')
    app.relaunch()
    // ❌ 不用 app.exit():它强制退出、**跳过 before-quit**,于是既错过了优雅停机,又把退出
    //    交给 Node 的正常销毁流程 —— 有活 PTY 时会永久卡死在 pty.node 的线程 join 上
    //    (实测栈:FreeEnvironment → uv_run → ThreadSafeFinalize(pty.node) → pthread_join)。
    //    进程退不掉,relaunch 的新进程也就永远不会 spawn,用户对着一个再也不回来的窗口等。
    //    app.quit() 走 before-quit:三段停机各 5s 超时,末尾 reallyExit 硬退、不进 finalize。
    app.quit()
    // 看门狗:即便 before-quit 那条路也没能让进程走掉,重启也必须真的发生
    // (product spec)。unref 让它自己永不拖住一次正常退出。
    const watchdog = setTimeout(() => {
      authLogger.error({}, '退出超时:before-quit 未能终结本进程,硬杀自己以保证重启真的发生')
      process.kill(process.pid, 'SIGKILL')
    }, RELAUNCH_EXIT_WATCHDOG_MS)
    watchdog.unref()
  })
})

ipcMain.handle(SESSION_SHELL_CHANNELS.fatalBoot, (event, message: unknown) => {
  reportFatalBoot(event, message, fatalBootDeps)
})

// This machine's rows of the canonical roster (same resolver as session_peers). The renderer adds the
// other machines' rows from the session directory and never invents a mapping.
handleShellChannel(SESSION_SHELL_CHANNELS.sessionPeers, async (_event, sessionId?: string) => {
  const auth = await authProvider?.getAuth()
  if (!auth?.accessToken || !auth.userId) throw new Error('任务页本机会话名册不可用：未登录')
  const emdash = loadEmdashBridge()
  if (!emdash) throw new Error('任务页运行时不可用')
  return localSessionPeers(emdash, auth, sessionId)
})

// @@@sessionpage TASKPAGE-FUSION 分享 — 会话页头部的分享入口需要两件事,都在这:
//  1) `sessionpage:agent-card`:当前**会话**绑定的是哪个 agent(名字用于按钮提示;null → 入口置灰,❌ 死按钮)。
//  2) `sessionpage:share-agent`:请 gugu 渲染层打开它**已有的** SharePosterDialog(contact QR 名片)。分享 UI
//     不在会话页后端重造,也不由 main 拼装 —— main 只转达「分享这个 agent」,渲染层用自己的通讯录数据
//     (咕咕号 / 头像)出卡片,单一数据源。
// 两条都按 conversationId 查:一个 task 里 N 条会话 N 个 agent,按 task 查没有确定答案(见 sessionpage-agent-card.ts)。
handleShellChannel(SESSION_SHELL_CHANNELS.agentCard, async (_event, sessionId: unknown) => {
  const auth = await authProvider?.getAuth()
  if (!auth?.accessToken || !auth.userId) return null
  return resolveSessionpageAgentCard(
    String(sessionId ?? ''),
    process.env,
    auth.userId,
    (agentUserIds) => loadSessionpageCanonicalAgentIdentities(auth, agentUserIds),
  )
})
// 侧栏逐行 hover 要说「这一行是谁」(#5818):就是本机名册(session_peers)那一份的投影,名字同样取自
// identity.users.display_name。
handleShellChannel(SESSION_SHELL_CHANNELS.agentNames, async () => {
  const auth = await authProvider?.getAuth()
  if (!auth?.accessToken || !auth.userId) return []
  const emdash = loadEmdashBridge()
  if (!emdash) throw new Error('任务页运行时不可用')
  return agentNamesFromPeers(await localSessionPeers(emdash, auth))
})
ipcMain.handle(SESSION_SHELL_CHANNELS.shareAgent, async (_event, sessionId: unknown, remoteCard?: unknown) => {
  const auth = await authProvider?.getAuth()
  if (!auth?.accessToken || !auth.userId) {
    sendUiEvent(MAIN_UI_EVENTS.sessionpageShareAgentUnavailable, '这个任务还没有可分享的 agent 身份')
    return false
  }
  // #6264 会话在别的机器上:名片由那台机器答过了(绑定记在那台机器上),这里只负责画;null = 那台机器说它还没有身份。
  const card = remoteCard !== undefined ? (remoteCard as Awaited<ReturnType<typeof resolveSessionpageAgentCard>>) : await resolveSessionpageAgentCard(
    String(sessionId ?? ''),
    process.env,
    auth.userId,
    (agentUserIds) => loadSessionpageCanonicalAgentIdentities(auth, agentUserIds),
  )
  if (!card) {
    // 点了必须有反应:说明为什么不能分享,而不是一个点下去毫无动静的入口(实机反馈「点击没反应」)。
    sendUiEvent(MAIN_UI_EVENTS.sessionpageShareAgentUnavailable, '这个任务还没有可分享的 agent 身份')
    return false
  }
  // 分享浮层里要摆会话 id(#6093),而名片本身是「会话 → agent」的答案,不带问题那一半 —— 这里补上。
  sendUiEvent(MAIN_UI_EVENTS.sessionpageShareAgent, { ...card, sessionId: String(sessionId ?? '') })
  return true
})

// 会话页里的「报障」入口(命令面板 / 应用菜单 / GitHub 登录弹窗的 Having trouble)。会话页侧不自建
// 反馈通路,main 只转达,由渲染层打开侧栏那一个问题反馈(product spec:落库 + 判重转 issue)。
ipcMain.handle(SESSION_SHELL_CHANNELS.openFeedback, async () => {
  sendUiEvent(MAIN_UI_EVENTS.sessionpageOpenFeedback)
  return true
})

function requiredSessionpageAgentId(value: unknown): string {
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error('Agent id 无效，无法解析任务会话')
  }
  return value.trim()
}

function requiredSessionpageFilePath(value: unknown): string {
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error('文件路径无效，无法打开任务文件')
  }
  return value
}

async function ensureSessionpageSessionReady(
  sessionId: string,
  trigger: string,
): Promise<{ status: 'ready' } | { status: 'failed'; error: string }> {
  return sessionpagePlatformRecovery?.ensureReady(sessionId, trigger)
    ?? { status: 'ready' }
}

/**
 * #5276 设备命令 `agent.set_model` 的宿主实现：校验（与目录、协议、引擎一致）→ 落本地 agent cache
 * （下次 spawn 用）→ 该 agent 此刻有活会话就当场应用（热切 / 重开续上）。三步顺序固定：校验不过
 * 什么都不写；活会话应用失败时本地默认已落下，如实回报 `next-session` 之外的失败原话 —— ❌ 不把
 * 「默认改了、活会话没换」报成成功。
 */
async function applyAgentModelSelectionOnDevice(input: {
  agentUserId: string
  engineId: string | null
  selection: AgentModelSelection
}): Promise<{ applied: 'hot' | 'reload' | 'next-session'; warning?: string; nativeSession?: 'preserved' | 'replaced' }> {
  const localAgent = await findLocalAgentByUserId(input.agentUserId, process.env)
  if (!localAgent) throw new Error('这个 Agent 不在当前设备上运行')
  const engineId = catalogEngineIdForAgent(localAgent, engineIdForAgentType) ?? input.engineId
  await assertAgentModelSelectionOpen({ authProvider, engineId, selection: input.selection })
  await setLocalAgentModelSelection(input.agentUserId, input.selection, process.env)

  let sessionId: string | null = null
  try {
    sessionId = getSessionpageLocalDelivery().sessionIdForAgent(input.agentUserId)
  } catch (error) {
    // 交接窗口里的结构歧义（两个认领者）：默认已落下，活会话这一步说不清该动哪条 —— 响亮报，❌ 不猜。
    throw new Error(
      `模型默认已更新，但此刻分不出该 Agent 的活会话（${error instanceof Error ? error.message : String(error)}）；`
      + '请稍后再试一次。',
    )
  }
  if (!sessionId) return { applied: 'next-session' }
  const emdash = loadEmdashBridge()
  if (!emdash) throw new Error('模型默认已更新，但任务页运行时不可用，活会话没能切换')
  const outcome = await emdash.applyEmdashSessionModelSelection({
    sessionId,
    selection: input.selection,
    runningOn: heldPlatformModelForSession(sessionId) ? 'platform' : 'own',
  })
  return outcome
}

/**
 * #7199 个人助理搬去了别的设备(agent.retire):这台拆它的运行时 —— 停会话、删会话行、撤它排的已安排、摘花名册与缓存、
 * 作废发给它的卡。❌ 删文件(工作目录、记忆都留着:搬坏了还有退路)。幂等:这台上本来就没有它 = `found:false`。
 * 顺序:先撤已安排(会话还在,才查得到它们挂在哪条会话上),再拆会话,最后摘名册记录(它是「这个绑定还看得见」的开关,留到最后让失败的一轮可重试)。
 */
async function retireSessionpageAgent(agentUserId: string): Promise<{ found: boolean; schedulesRemoved: number }> {
  const roster = await listAgents(process.env, { includeGuests: true })
  const agent = roster.find((entry) => entry.gugu_user_id === agentUserId)
  if (!agent) return { found: false, schedulesRemoved: 0 }
  const emdash = loadEmdashBridge()
  const sessionId = cacheString(agent.cache, SESSION_CACHE_KEY)
  const schedulesRemoved = emdash && sessionId ? await emdash.removeSessionSchedules(sessionId) : 0
  // 拆之前记一笔:花名册里它有没有会话 / 项目的记载,决定下面能不能真的拆掉会话与已安排(没有 = 只摘名册,会话与已安排留在原处)。
  assistantRetireLogger.info(
    { agentUserId, hasEmdash: !!emdash, sessionId: sessionId ?? null, projectId: cacheString(agent.cache, PROJECT_CACHE_KEY) ?? null, schedulesRemoved },
    'agent.retire: tearing down the assistant on this machine'
  )
  // 等它写完(它是 async):不等的话下面拆会话时登记表里这个 agent 还在,投递可能又落到刚要停的会话上。
  await unregisterSessionpageDeliveryOwners(agentUserId)
  // 先摘花名册(云端 presence 的周期写只遍历花名册),再停会话:停会话时冒出来的状态变化不会再被写成云端的「离线」。
  // 身份已经属于新家 —— 旧家 ❌ 报 offline、❌ 删云端身份(运行态按时间单调,后写的赢,旧家后写的 offline 会盖掉新家的 online)。
  await releaseAgentLocalFootprint({ agentUserId, identityRemoved: false, env: process.env })
  await disposeSessionpageAgentFromRoster(agent)
  await revokeAgentCards(agentUserId)
  return { found: true, schedulesRemoved }
}

async function stopSessionpageAgent(agentUserId: string): Promise<void> {
  const target = await readSessionpageOpenTarget(agentUserId)
  if (!target) throw new Error(`Agent ${agentUserId} has no session-page session mapping`)
  const emdash = loadEmdashBridge()
  if (!emdash) throw new Error('任务页运行时不可用')
  await emdash.emdashStopSession(target)
}

ipcMain.handle('sessionpage:agent-context', async (_event, agentUserId: unknown) => {
  const target = await readSessionpageOpenTarget(requiredSessionpageAgentId(agentUserId))
  if (!target) return null
  const emdash = loadEmdashBridge()
  // 这里只答「映射到哪条会话」与平台恢复;这个 agent 的状态与审阅门 / 阻塞走按 agent 的流(agent-status-feed),
  // ❌ 在这里再读一遍 —— 同一件事两条通道就会给出两个答案。
  // `view` = 这条会话现在以哪种展示开(编程 / 通用):私聊头部的模式按钮把它排前、写「使用中」(#7167)。
  if (!emdash) return { ...target, view: null, platformRecovery: null, projectionError: '任务页运行时不可用' }
  try {
    const view = await emdash.emdashSessionView(target)
    return {
      ...target,
      view,
      platformRecovery: sessionpagePlatformRecovery?.stateFor(target.sessionId) ?? null,
      projectionError: view !== null ? null : '映射的任务或 Session 已不存在',
    }
  } catch (error) {
    return {
      ...target,
      view: null,
      platformRecovery: null,
      projectionError: error instanceof Error ? error.message : String(error),
    }
  }
})

ipcMain.handle('sessionpage:ensure-session-ready', async (_event, agentUserId: unknown) => {
  const target = await readSessionpageOpenTarget(requiredSessionpageAgentId(agentUserId))
  return target ? ensureSessionpageSessionReady(target.sessionId, 'chat-send') : { status: 'ready' as const }
})

ipcMain.handle('sessionpage:retry-platform-recovery', async (_event, sessionId: unknown) => {
  if (typeof sessionId !== 'string' || !sessionId.trim()) {
    throw new Error('session id is required for platform recovery retry')
  }
  const normalized = sessionId.trim()
  clearPlatformIssueBackoff(normalized)
  const result = await (sessionpagePlatformRecovery?.retry(normalized)
    ?? Promise.resolve({ status: 'failed' as const, error: 'platform recovery coordinator is unavailable' }))
  if (result.status === 'ready') {
    const agentUserId = await guguAgentUserIdForSession(normalized, process.env)
    if (agentUserId) kickInboxForAgent(agentUserId, 'platform-recovery-retry')
  }
  return result
})

// (重)连接时的那一次对账:这台机器上每个 agent 此刻的条目。之后渲染层只吃 `agent-status-feed`。
ipcMain.handle('agent-status-feed:snapshot', () => agentStatusFeed.snapshot())

ipcMain.handle('sessionpage:open-agent-file', async (
  _event,
  agentUserId: unknown,
  filePath: unknown,
) => {
  const path = requiredSessionpageFilePath(filePath)
  const target = await readSessionpageOpenTarget(requiredSessionpageAgentId(agentUserId))
  if (!target) throw new Error('这个 Agent 在本机没有可打开的任务会话映射')
  const emdash = loadEmdashBridge()
  if (!emdash) throw new Error('任务页运行时不可用')
  if (!(await emdash.emdashSessionExists(target))) {
    throw new Error('映射的任务或 Session 已不存在')
  }
  // 会话已经由打开会话的那一条路(gugu-links.openLink)打开了,这里只开它工作区里的文件。
  await emdash.emdashOpenSessionFile(target, path)
  return target
})
// 主进程 → 界面的事件只经这一个口发,通道名取自 MAIN_UI_EVENTS(preload 按同一份定义转发),❌ 手写通道字符串。
function sendUiEvent<T>(event: EventDefinition<T>, ...payload: T extends void ? [] : [T]): void {
  mainWindow?.webContents.send(event.name, ...payload)
}
// 身份是会话启动后**才**到位的(云端 provision + roster 落盘),任务一创建就已渲染 → 分享入口第一次查必然是 null,
// 所以一落地就播一次(❌ 轮询)。播给本机窗口,也播给经设备连接看着这台机器的别的电脑(#6264:server 上只有后者)。
// 载荷形状由事件定义钉住(会话页按 conversationId 认领),❌ 原样转主进程自己那份事件(那边叫 sessionId)。
function sendSessionpageIdentityEvent(event: EventDefinition<SessionShellAgentName>, payload: SessionShellAgentName): void {
  sendUiEvent(event, payload)
  emdashBridge?.broadcastDeviceSessionHostEvent(event.name, payload)
}
// #7337 咕咕给新会话起名:建会话时记下,这条会话拿到 agent 身份(签票要挂在它名下)时以它的名义找设置里的模型要一个短名。
// 自动名先到先得:harness 先起了名 / 人先改了名,落库那一刻就不收(applyGeneratedTitle)。
const sessionTitleNamer = createSessionTitleNamer({
  authProvider: () => desktopAuthProvider(),
  awaitAgentIdentity: awaitSessionpageCloudIdentity,
  titleSettings: async () => {
    const sessions = await appSettingsService.get('sessions')
    return { model: sessions.titleModel, instructions: sessions.titleInstructions }
  },
  titleState: sessionTitleIsFallback,
  applyTitle: applyGeneratedTitle,
})
sessionEvents.on('session:created', (session) => sessionTitleNamer.sessionCreated(session))
onSessionpageAgentProvisioned((event) => {
  void sessionTitleNamer.agentProvisioned(event.sessionId, event.agentUserId).catch((error: unknown) => {
    createLogger('session-title-namer').error({ sessionId: event.sessionId, err: error }, 'session title: namer crashed')
  })
})

onSessionpageAgentProvisioned((event) => {
  sendSessionpageIdentityEvent(sessionpageAgentProvisionedEvent, {
    conversationId: event.sessionId,
    agentUserId: event.agentUserId,
    displayName: event.displayName,
  })
  // #6396 会话起来时的名字在登记时已经用过 ⇒ 服务端登记成了下一个。侧栏靠上面那条事件换名;
  // 对话里那一行告知在这里画。agent 不另行告知:名字不在它的上下文里,要知道就调 profile_whoami(#6490)。
  if (event.renamedFrom) announceSessionpageAgentRename({ ...event, previousName: event.renamedFrom })
  // S2b 读者触发③(身份就绪):可投递 = 身份就绪 + 各腿登记好,两个边界各踢一次,后到的那一次投得出去。
  // 各腿的登记点另踢(ACP:运行时启动成功;PTY:registerLive;codex:threadId;claude:tools/list)。
  onSessionpageSessionLive(event.agentUserId, event.sessionId)
})

/** #6396 在这条会话的对话里画「名字已被占用」那一行(见 sessionpage-rename-announcement.ts)。递不到只记一笔:名字本身已经换好了。 */
function announceSessionpageAgentRename(rename: SessionpageAgentNameTaken): void {
  const emdash = loadEmdashBridge()
  if (!emdash) return
  void emdash.announceEmdashSession(sessionpageRenameAnnouncement(rename))
    .then(({ delivered }) => {
      createLogger('sessionpage/provision').info(
        { sessionId: rename.sessionId, from: rename.previousName, to: rename.displayName, delivered },
        '#6396 agent rename announced to its session',
      )
    })
    .catch((error: unknown) => {
      createLogger('sessionpage/provision').warn(
        { sessionId: rename.sessionId, error: error instanceof Error ? error.message : String(error) },
        '#6396 agent rename could not be announced to its session',
      )
    })
}

/** #6593 主人改了 agent 的名字 ⇒ 告诉它自己的会话(见 agent-rename-notice.ts)。递不到只记一笔:名字本身已经改好了。 */
function tellRenamedAgentsSession(rename: AgentRenamed): void {
  void tellAgentItWasRenamed(getSessionpageLocalDelivery(), rename)
    .then((verdict) => {
      createLogger('sessionpage/provision').info(
        { agentUserId: rename.agentUserId, to: rename.displayName, verdict },
        '#6593 agent rename told to its session',
      )
    })
    .catch((error: unknown) => {
      createLogger('sessionpage/provision').warn(
        { agentUserId: rename.agentUserId, error: error instanceof Error ? error.message : String(error) },
        '#6593 agent rename could not be told to its session',
      )
    })
}

function loadEmdashBridge(): EmdashBridgeModule | null {
  if (emdashBridge) return emdashBridge
  try {
    if (!emdashBridgeModule) {
      throw new Error('session page module requested before app.whenReady preloaded it')
    }
    emdashBridge = emdashBridgeModule
    // @@@2374-webview-policy — <webview> 准入策略在**拿到模块的这一刻**就装,而不是等 bootEmdashModule。
    // boot 是可失败的(失败时宿主只 log 后继续,见下方调用点),把安全策略挂在它后面 =
    // 一旦出问题就从「默认拒绝」退化成「默认放行」。注册幂等,boot 里那次照旧。
    emdashBridge.registerWebviewAttachPolicy()
    // F14 (L7-b) 列出来就得能用:会话 MCP server 建出来之前就定下 app_check 列不列。
    setExtensionCheckAvailable(emdashBridge.emdashExtensionCheckAvailable())
    // 同理:guide_read apps-ui 的图只在能开隐藏页的地方有(咕咕 server 上那篇指南只有字)。
    const bridgeForPicture = emdashBridge
    setGuideLookPicture(bridgeForPicture.emdashExtensionCheckAvailable() ? () => bridgeForPicture.emdashLookPicture() : null)
    // @@@5301 同理,加载即注入:会话页 agent 通知的正文。不注入的后果是所有人收到英文兜底,
    // 而且不报错 —— 与上面那条 webview 策略同一类「失败时静默退化」的坑。
    publishSessionHostLocale()
    // @@@2374 — 同理,加载即注入:扩展的宿主动作(改标题/角标、开浏览器 tab、报错、投进对话)
    // 全要走宿主这个 renderer 通道,而通道的实现住在 main.js。传函数不传值,所以此刻窗口还没建
    // 也没关系——调用时才读。
    emdashBridge.setExtensionHostWindowChannel({
      invokeRendererExtensions,
      requestExtensionInstallConsent: (request, options) => {
        if (!mainWindow || mainWindow.isDestroyed()) {
          return Promise.reject(new Error('Renderer not ready'))
        }
        // 要人点头,窗口就得看得见 —— agent 替人干活时人多半在别的 app 里,弹窗画在后面
        // 等于没问(owner 实测:最前台是别的程序,他根本没看见)。❌ 别顺手抢焦点做别的事,
        // 只有「需要人当场决定」这一处配得上打断他。
        // D-31:只在人就在这台电脑前时才提(`raise`,判据见 consent-in-session 的 IN_USE_IDLE_SECONDS)——
        // 人在手机上、在另一台电脑上看着这条会话时,同一个问在那边当审批出现,这台不抢焦点。
        if (options?.raise) {
          if (!mainWindow.isVisible()) mainWindow.show()
          mainWindow.focus()
          // macOS 上光有 `mainWindow.focus()` 不够:它只在**应用内部**切焦点,应用本身还压在别的
          // app 后面。把应用提到最前要这一句。
          //
          // 它一度被我 revert 掉,理由是「实测没生效」—— 而那个「实测」是错的:CDP 里的
          // `document.hasFocus()` 和另开一条 ssh 去问 frontmost,都测不准 macOS 的应用级激活,
          // 何况那一跑还被污染(装的 id 撞了已装扩展、中途有人点了弹窗)。owner 肉眼验证的是
          // 「会跳到眼前」。❌ 别再用那两个探针去判它,要判就人看,或者用能读 app 激活的手段。
          app.focus({ steal: true })
        }
        return invokeRendererExtensions(
          EXTENSION_INSTALL_CONSENT_METHOD,
          request,
          mainWindow.webContents.id,
        ) as Promise<ExtensionInstallConsentResult>
      },
      closeExtensionInstallConsent: async (requestId) => {
        if (!mainWindow || mainWindow.isDestroyed()) return
        await invokeRendererExtensions(EXTENSION_INSTALL_CONSENT_CLOSE_METHOD, { requestId }, mainWindow.webContents.id)
      },
      notifyInstalledExtensionsChanged: async () => {
        if (!mainWindow || mainWindow.isDestroyed()) return
        await invokeRendererExtensions(
          EXTENSION_INSTALLED_CHANGED_METHOD,
          {},
          mainWindow.webContents.id,
        )
      },
      drawMemberFaces: (people) => {
        if (!mainWindow || mainWindow.isDestroyed()) return Promise.reject(new Error('Renderer not ready'))
        return invokeRendererExtensions(EXTENSION_MEMBER_FACES_METHOD, { people }, mainWindow.webContents.id) as Promise<Record<string, string>>
      },
      listedSession: (sessionId, hint) => {
        if (!mainWindow || mainWindow.isDestroyed()) return Promise.reject(new Error('Renderer not ready'))
        return invokeRendererExtensions(EXTENSION_LISTED_SESSION_METHOD, { sessionId, ...hint }, mainWindow.webContents.id) as Promise<string | null>
      },
      act: async (command) => {
        if (!mainWindow || mainWindow.isDestroyed()) throw new Error('Renderer not ready')
        const result = await invokeRendererExtensions(EXTENSION_HOST_ACTION_METHOD, command, mainWindow.webContents.id) as { opened?: import('../src/session/shared/extensions/host-actions').ExtensionHostActionResult }
        return result.opened
      },
      isHostWindowFullScreen,
      onHostWindowFullScreenChange,
      isHostWindowFocused,
      onHostWindowFocusChange,
      hostLocale: currentHostLocale,
      hostTone: readWindowTone,
      onHostPresentationChange: (listener) => {
        hostPresentationListeners.add(listener)
        return () => hostPresentationListeners.delete(listener)
      },
    })
    // 同理注入:登录 shell PATH 的取回住在宿主这边(shellPath.ts 有模块级状态 lastLoginShellPath,
    // 报错时要靠它说明「当时 PATH 补没补上」;会话页 import 只会拿到读不到的复制品)。
    // 装完之后要重来一次:安装脚本自己挑目录、再往用户 rc 追加 PATH 是正当做法(36 个 agent 里
    // 15 个走脚本安装),而启动时取的那份快照此刻已经过期 —— 不重来就是「装成功、当场找不到」。
    emdashBridge.setLoginShellPathRehydrator(() => {
      hydrateLoginShellPath()
    })
    // #5873 同一次采样的另一半:整份登录 shell 环境。传的是**取值函数**而非当下的值 ——
    // 注入发生在 loadEmdashBridge() 那一刻,而 hydrateLoginShellPath() 可能还没跑过、
    // 装完 agent 之后还会再跑一次;每次起会话现取才拿得到最新那份。
    // ⚠️ 只在 spawn 侧合并,❌ 不写回 process.env(污染 GUI 主进程,见 #2895)。
    emdashBridge.setLoginShellEnvProvider(() => loginShellEnvSnapshot())
    // #6264 终端会话跑在咕咕平台模型上时,它的登录被拒说的是平台令牌,❌ 用户自己那份登录(auth-expiry-from-turns.ts)。
    emdashBridge.setPlatformCredentialsProbe((sessionId) => heldPlatformModelForSession(sessionId) !== null)
    // 模型目录的第二遍探测:没登录这家 harness 的用户也要看得到推理强度(owner 08-26:每家都得有档位)。
    // 占位凭据由宿主算(要用 engine-injection-contract 与 capability-bundle),注进会话页那侧的探针。
    emdashBridge.setProbePlatformEnvResolver(buildProbePlatformCredentials)
    return emdashBridge
  } catch (err) {
    console.error('[sessionpage] FAILED to load session page module — session page backend disabled:', err)
    fatalSessionpageBoot(err)
    return null
  }
}

async function stopDesktopOwnedResources(): Promise<void> {
  const hostResults = await Promise.allSettled([
    runShutdownPhase(
      'gugu-mcp-host',
      async () => {
        localSessionActionDispatcher = null
        const host = primaryGuguMcpHost
        await host?.dispose()
        if (primaryGuguMcpHost === host) primaryGuguMcpHost = null
      },
      reportShutdownPhase,
    ),
    runShutdownPhase(
      'codex-app-servers',
      () => disposeAllCodexAppServerSessions(),
      reportShutdownPhase,
    ),
    // @@@5163 这一段是「Desktop 拥有的原生腿」的关停位,而它此前只列了 codex ——
    // 那是它写下时的实情。opencode serve/attach(#4607)与 droid daemon 之后各自又拉起一个
    // sidecar,却没被列进来;而优雅关停末尾是 `process.reallyExit()`,**绕过 will-quit 与
    // process 'exit' 钩子** ⇒ 那两条腿唯一的兜底也不会跑 ⇒ 进程留在用户机器上(实测:
    // 停掉 app 后 `opencode serve` ppid 变成 1,日积月累 45 个)。
    // ⇒ 每加一条原生腿就在这里加一段,❌ 不要指望进程级钩子替它收尾。
    runShutdownPhase(
      'opencode-serve-attach',
      () => opencodeServeAttachSessionDelivery.dispose(),
      reportShutdownPhase,
    ),
    runShutdownPhase(
      'droid-daemon',
      () => droidDaemonSessionDelivery.dispose(),
      reportShutdownPhase,
    ),
    // #7199 / #7317 电脑控制的 cua-driver 守护进程与代理、Mac 小助手:同一条规矩,漏了它们每重启一次就留一个孤儿
    // (真机实测:旧实例退出后 `cua-driver serve` ppid 变成 1)。守护进程自己也认 stdin EOF(见 cua-client),这里是正路。
    runShutdownPhase(
      'device-actions',
      () => deviceActionsRuntimeInstance?.dispose(),
      reportShutdownPhase,
    ),
    // 远程隧道的 frpc(两头各一条):server 模式经 SIGTERM 走上面的 killEnginesOnCrash,桌面走这里。
    runShutdownPhase(
      'remote-tunnel',
      async () => {
        closeTunnelMachines?.()
        tunnelEndpoint?.stop()
      },
      reportShutdownPhase,
    ),
  ])
  const hostFailures = hostResults
    .flatMap((result) => result.status === 'rejected' ? [result.reason] : [])
  const results = await Promise.allSettled([
    runShutdownPhase('local-session-index', async () => {
      const source = sessionpageLocalSessionSource
      sessionpageLocalSessionSource = null
      emdashBridge?.setEmdashLocalSessionSource(null)
      await source?.dispose()
    }, reportShutdownPhase),
    runShutdownPhase('session-main', () => emdashBridge?.disposeEmdashModule() ?? Promise.resolve(), reportShutdownPhase),
    runShutdownPhase('remote-open-files', async () => {
      const directories = [...remoteFileOpenDirectories]
      remoteFileOpenDirectories.clear()
      await Promise.all(directories.map(cleanupRemoteFileDirectory))
    }, reportShutdownPhase),
  ])
  // @@@4467 宿主是平台令牌唯一的续期者,宿主走了令牌也得结清 —— 只留 tmux 里仍在跑、凭据不经宿主供给的会话的票
  // (账本标 detached,下次启动接回或结清)。排在 session-main 拆除之后:tmux 快照要反映拆除之后的真相
  // (被 terminate 的会话已经不在),否则会把正被杀掉的会话的票留下。没撤完的账本还在,下次启动结清。
  const platformAccess = await Promise.allSettled([
    runShutdownPhase('platform-access', async () => {
      const live = await liveTmuxSessionIds().catch((error: unknown) => {
        createLogger('sessionpage/platform-model').error({ err: error }, '退出时读不出 tmux 会话;候选票全部保留交给下次启动判定')
        return null
      })
      await releasePlatformModelsAtExit(live)
    }, reportShutdownPhase),
  ])
  const failures = [
    ...hostFailures,
    ...results.flatMap((result) => result.status === 'rejected' ? [result.reason] : []),
    ...platformAccess.flatMap((result) => result.status === 'rejected' ? [result.reason] : []),
  ]
  if (failures.length === 1) throw failures[0]
  if (failures.length > 1) throw new AggregateError(failures, 'desktop cleanup failed')
}

app.whenReady().then(async () => {
  if (!hasSingleInstanceLock) return
  // #6264 重启前发出去的卡还有 agent 拿着(tmux 里的会话):开机**第一步**就把端口绑回来。agent 的 HTTP MCP 客户端在宿主
  // 一退就开始重连(claude:5 次、退避 1/2/4/8 s,15 s 内用完就永远放弃),而开机到会话页就绪要十几秒;端口晚绑,
  // 这段时间里它每一发都是「连接被拒绝」(10-08 ThinkPad 换版实测:端口在退出后约 20 s 才开,五条车道全部失联)。
  // 绑上以后,开机期间进来的请求挂在 restore 上,等会话页就绪再处理(见 stableMcpPersistence 的 wake)。集成那台、扩展网关同理。
  if (hasPersistedMcpGrants('gugu-mcp')) {
    primaryGuguMcpHost ??= createDesktopGuguMcpHost(stableMcpPersistence('gugu-mcp'))
    void primaryGuguMcpHost.start().catch((err: unknown) => createLogger('stable-endpoint').warn({ err }, '咕咕 MCP 没能提前绑回端口'))
  }
  if (hasPersistedMcpGrants('integration-mcp')) {
    integrationMcpHost ??= createIntegrationMcpHost(stableMcpPersistence('integration-mcp'))
    void integrationMcpHost.start().catch((err: unknown) => createLogger('stable-endpoint').warn({ err }, '集成转发口没能提前绑回端口'))
  }
  if (hasPersistedMcpGrants('extension-gateway')) {
    void getExtensionGatewayHost().start().catch((err: unknown) => createLogger('stable-endpoint').warn({ err }, '扩展网关没能提前绑回端口'))
  }
  installNativeSleepActivity(powerMonitor, recordDeviceSleep)
  installNativeResumeSource(powerMonitor, notifyRendererForeground, resumeAccountMessaging)
  // @@@test-seam host-resume(GUGU_TEST_HOST_RESUME=1 才注册)—— 上面这条与 mainWindow 的 'focus'
  // 都要求一个能切焦点的 GUI 会话,锁屏的无人测试机上两条都按不动。这个信号跑的是**同一个**
  // reconcileSessionpagePlatformOnResume,不另立语义;env 没开时不注册,生产行为逐字不变。
  registerHostResumeTestSignal({
    env: process.env,
    signals: process,
    reconcile: () => reconcileSessionpagePlatformOnResume,
    onTriggered: ({ hasReconcile }) => createLogger('sessionpage/platform')
      .info({ hasReconcile, via: 'test-signal' }, '平台凭据恢复事件收到'),
    onError: (error) => createLogger('sessionpage/platform').error({ err: error }, '平台凭据恢复对账失败'),
  })
  void cleanupStaleRemoteFileDirectories(remoteFileTempRoot)
    .catch((error) => createLogger('remote-file-open').error({ err: error }, 'stale cleanup failed'))
  // @@@2125①b / @@@2146② — finish residual group reap before this run can spawn an engine.
  // ownerMainPid plus the pidfile's recorded endpoint protect live foreign groups; the spawn
  // latch remains a final fail-safe against future ordering regressions, not the normal path for
  // postponing cleanup.
  // @@@3890⑦ 回收是尽力而为的清扫,**任何结果都不阻断启动**(理由见 describeReapSummary 的注释:
  // 之前 retained>0 会 throw 进这条没有 catch 的链,把 app 变成没窗口没托盘、还占着单实例锁的活死人,
  // 且下次启动同一个孤儿组还在、照样起不来)。
  try {
    const { info, warning } = describeReapSummary(await reapResidualEngineGroupsOnce(createReapDeps()))
    if (info) console.log(info)
    // #6264 推理后台住在 tmux 里的那几台(codex app-server / opencode serve / droid daemon):终端会话已经不在的是孤儿,
    // 收掉;终端还在的留着,等会话被打开或被投递唤醒时接回。只在启动时跑一次(一次 tmux list-sessions),❌ 轮询。
    startTmuxBackendStartupSweep()
    if (warning) console.error(warning)
  } catch (error) {
    createLogger('engine-reap').error({ err: error }, '启动回收自身失败,残留留待下轮')
  }
  hostLocaleStore = new HostLocaleStore(
    join(app.getPath('userData'), HOST_LOCALE_STATE_FILE),
    app.getPreferredSystemLanguages(),
  )
  try {
    enableMacTouchIdPasskeys()
  } catch (error) {
    createLogger('webauthn').error({ err: error }, 'Touch ID 通行密钥没开成,内置浏览器照旧(网站会以为这台电脑没有指纹)')
  }

  try {
    const retired = await removeRetiredCodexCapabilityRuns(process.env)
    if (retired.found > 0) {
      console.log(`[codex-app-server] retired capability runs removed=${retired.removed}/${retired.found}`)
    }
  } catch (error) {
    console.error('[codex-app-server] retired capability run cleanup failed:', error)
  }
  // @@@gugu-app-scheme — serve the built renderer (dist/) over gugu-app://app/…; net.fetch on the
  // file URL supplies correct Content-Type per extension (module scripts require a JS MIME).
  // 路径越界直接 403,找不到的文件由 net.fetch 报 404 — fail loud,无兜底页。
  // 解析惰性执行:注册不碰磁盘,第一次真有人请求才解析(#2795)。dev 从 VITE_DEV_SERVER_URL
  // 取渲染层、永不请求本 scheme,所以不该被生产产物的存在性检查挡住启动。
  const builtRendererRoot = createBuiltRendererRootResolver({
    appPath: app.getAppPath(),
    mainEntryPath: __filename,
  })
  protocol.handle('gugu-app', (request) => {
    const rendererRoot = builtRendererRoot()
    const url = new URL(request.url)
    const filePath = join(rendererRoot, decodeURIComponent(url.pathname))
    if (url.host !== 'app' || !filePath.startsWith(rendererRoot + sep)) {
      return new Response('forbidden', { status: 403 })
    }
    return net.fetch(pathToFileURL(filePath).toString())
  })
  // @@@deeplink-register - Packaged builds declare gugu:// via electron-builder `protocols`
  // #6387 前缀按版本区分(见 GUGU_LINK_SCHEME):同机的正式版、Beta、开发版各认各的链接。
  if (process.defaultApp) {
    if (process.argv.length >= 2) {
      app.setAsDefaultProtocolClient(GUGU_LINK_SCHEME, process.execPath, [resolve(process.argv[1])])
    }
  } else {
    app.setAsDefaultProtocolClient(GUGU_LINK_SCHEME)
  }
  setupRendererCommandIpcHandlers()
  // 应用菜单(app-menu.ts):mac「咕咕」那一栏多一项「设置…」;@@@devtools-lock 锁了的包「视图」里没有
  // reload / forceReload / toggleDevTools。要在 ready 之后、窗口出现之前:菜单是原生资源,ready 前设不生效。
  refreshApplicationMenu()
  if (isDevtoolsLocked()) {
    devtoolsLockLogger.info('已锁定:DevTools 与重载入口在本包中不可用')
  }
  // Create the hidden BrowserWindow first so main-side event wiring can target it, but defer
  // renderer navigation until the session-page IPC router has registered. Otherwise the embedded renderer
  // races boot and its first dot-RPC calls fail with "No handler registered".
  if (!SERVER_MODE) {
    // 只有 mac 主窗建窗时挂了 vibrancy(见 createWindow);别的窗问到的都是 opaque。
    windowMaterial = installWindowMaterial({
      platform: process.platform,
      nativeTheme,
      ipcMain,
      materialWindow: () => (process.platform === 'darwin' ? mainWindow : null),
    })
    windowMaterial.onChange(() => syncWindowTone(readWindowTone()))
    installNativeAppearanceSync({ platform: process.platform, nativeTheme, ipcMain })
    createWindow(false)
  }
  // PATH 补救不再挑启动方式（曾经只在「mac 且已打包」时跑 → ssh/agent 起的验证流程、以及
  // Linux 上的**所有**启动方式都缺 PATH，症状是每个 agent CLI 都报「未安装」）。
  // Windows 没有登录 shell 的概念，走 ensureWindowsNpmGlobalBinInPath()；两条互斥，不重复起进程。
  // @@@4865 会话页主进程图在**这里**才加载(❌ 文件顶部静态 import,也 ❌ whenReady 开头):
  //  · 模块顶层会读 userData 等应用路径,必须晚于本文件顶层的 app.setPath('userData');
  //  · 这是一块 18MB 的 chunk,求值要几百毫秒 —— 放在建窗口之前就是首屏迟几百毫秒(owner 实测感到
  //    「首屏慢了」)。旧的 createRequire 就在下面这个位置(窗口已建、PATH 已补水),时点保持一致。
  // 动态 import 在 CJS 产物里就是一次同步 require,rollup 把目标切成独立入口 chunk 并纳入 watch 与
  // 构建图 —— 桥打坏了是构建红,不再是「App 起来才弹错」。
  try {
    emdashBridgeModule = await import('./sessionpage/emdash-main-bridge')
  } catch (err) {
    createLogger('sessionpage').error({ err }, 'FAILED to load session page module — session page backend disabled')
    fatalSessionpageBoot(err)
    return
  }
  hydrateLoginShellPath()
  ensureWindowsNpmGlobalBinInPath()
  if (SERVER_MODE) {
    // #6264 最小化的服务器常常没设 locale:补一个 UTF-8 的,之后起的 agent、「编程」终端、tmux 都继承它(中文文件名不乱码)。
    const locale = ensureUtf8Locale(loginShellEnvSnapshot())
    if (locale.lang) createLogger('server/locale').info({ lang: locale.lang, source: locale.source, override: locale.override }, '补上 UTF-8 locale')
  }
  // 已死会话留在 tmp 里的 rendezvous 文件:启动时清一次(只清自己的、没人听的、一分钟以前的),不常驻扫。
  void sweepStaleRendezvousSocksNow().then(
    (removed) => { if (removed > 0) createLogger('sessionpage').info({ removed }, 'cleared stale rendezvous sockets') },
    () => undefined,
  )
  // @@@sessionpage — boot the session-page backend MODULE (one entry, owner #43) AFTER the window exists (its
  // main→renderer event broadcasts target BrowserWindow.getAllWindows()) and AFTER PATH hydration
  // (ACP/pty spawns need a login PATH). Fire-and-forget: controllers begin serving as init completes.
  // gugu's own hydrateLoginShellPath() is the single PATH source, so there is nothing left to race.
  // The session backend and its session actions are required session-page
  // components: either failing aborts app startup through fatalSessionpageBoot.
  const emdash = loadEmdashBridge()
  if (emdash) {
    const localDelivery = getSessionpageLocalDelivery()
    // The session-page PTY provider is a separately bundled module graph. Install the host-owned registry before
    // any persisted/session rehydration can start, so every live/offline registration is visible to the
    // ordinary Contacts delivery router immediately and carries the real provider callback back across.
    emdash.setLocalSessionDeliveryBridge(withSessionLiveInboxKick(
      createLocalSessionDeliveryBridge(),
      // S2b 读者触发③(TUI 腿转 live):九家 local-session TUI 的注入点就在这一刻可用。
      (agentUserId, sessionId) => onSessionpageSessionLive(agentUserId, sessionId),
    ))
    // codex app-server 腿的 live 转换 = 这条认领的 threadId 到位(新会话要等 TUI 把 thread 建出来,比
    // provisioned 事件晚 —— 那一脚落在「还不可投」的窗口里只是空拉,真正的就绪在这里)。
    codexAppServerRegistry.setLiveHooks({
      onLive: (reg) => onSessionpageSessionLive(reg.guguAgentUserId, reg.sessionId),
    })
    // claude rendezvous 腿的 live 转换 = 该会话的 gugu MCP 送出 tools/list(spec delivery-routing #4896);
    // 预算到点仍未就绪 ⇒ 同一条路把在等的消息推成响亮失败(读者披露行 / outbox failed 收据)。
    claudeSessionDelivery.setLiveHooks({
      onLive: (reg) => onSessionpageSessionLive(reg.guguAgentUserId, reg.sessionId),
      onOverdue: (reg, detail) => {
        createLogger('sessionpage/deliver').error(
          { sessionId: reg.sessionId, agentUserId: reg.guguAgentUserId, ...detail },
          'claude TUI gugu MCP readiness overdue: pending deliveries to this session now fail loud',
        )
        onSessionpageSessionLive(reg.guguAgentUserId, reg.sessionId, 'ready-overdue')
      },
    })
    // #5025 取归属只走 resolveBootOwner:它问的是一个能区分「还不知道」和「没登录」的问题。
    // ❌ 别改回 race(getAuth(), 计时器):开机这一刻 authProvider 往往还没建好,那句会立刻得到 null,
    // 于是预算写 3s 还是 60s 都一样 —— 它压根没问过任何人(理由与实测数字见 boot-owner.ts)。
    const bootOwnerWithin = (ms: number): Promise<string | null> =>
      resolveBootOwner(
        (waitMs) =>
          serverAuth
            ? Promise.resolve<BootOwnerAnswer>({ decided: true, userId: serverAuth.signedInUserId() })
            : (invokeRendererAuth('getSessionOwner', { waitMs }) as Promise<BootOwnerAnswer>),
        ms,
      )
    const sessionMessageRouter = async (sessionId: string, message: SessionMessage, signal?: AbortSignal) => {
      signal?.throwIfAborted()
      const ready = await sessionpagePlatformRecovery?.ensureReady(sessionId, `session-message:${message.kind ?? 'ordinary'}`)
      signal?.throwIfAborted()
      if (ready?.status === 'failed') {
        createLogger('session-message').error({ sessionId, messageId: message.id, error: ready.error }, 'platform credential recovery failed; message remains pending')
        return {
          status: 'not-ready' as const,
          preserve: true,
          reason: `platform model access could not be restored (${ready.error})`,
        }
      }
      const attempt = async () => {
        signal?.throwIfAborted()
        const result = await localDelivery.tryInjectSessionMessage(sessionId, message)
        return result === false ? 'not-live' as const : result
      }
      let accepted: Exclude<Awaited<ReturnType<typeof attempt>>, 'not-live'>
      if (message.kind === 'session-direct') {
        // #6546 冷目标:与收件箱同一个唤醒入口,等准入后再投一次;叫不醒带着原因报回发送方。
        try {
          accepted = await localDelivery.injectWithWake(sessionId, attempt, signal)
        } catch (error) {
          if (!(error instanceof SessionWakeError)) throw error
          return { status: 'not-ready' as const, reason: `target session not live — ${error.message}` }
        }
      } else {
        const first = await localDelivery.tryInjectOrWake(sessionId, message)
        if (first === false) return { status: 'not-ready' as const }
        accepted = first
      }
      if (accepted !== true) {
        void accepted.completion.catch((error) => {
          createLogger('session-message').warn({
            sessionId,
            messageId: message.id,
            turnId: accepted.turnId,
            error: error instanceof Error ? error.message : String(error),
          }, 'native session message turn failed after acceptance')
        })
      }
      return {
        status: 'accepted' as const,
        messageId: message.id,
        ...(accepted === true ? {} : { nativeReceiptId: accepted.turnId }),
      }
    }
    emdash.setSessionMessageRouter(sessionMessageRouter)
    // ACP 腿的 live 转换 = 运行时登记好这条会话(启动成功)。与 codex / claude 的 onLive 同一个形状。
    emdash.setSessionLiveNotifier((sessionId) => {
      // @@@4629 conversation → agent 走 roster(那份 cache 就是这层绑定的 SSOT,见 agent-provisioning)。
      void guguAgentUserIdForSession(sessionId, process.env).then(
        (agentUserId) => {
          if (agentUserId) return onSessionpageSessionLive(agentUserId, sessionId, 'acp-started')
          // ❌ 不静默丢:排着的消息要等下一个触发。
          createLogger('sessionpage/deliver').warn(
            { sessionId },
            'ACP 会话已起,却无处可投:这条会话在 roster 上没有 agent(还没 provision / 已被 reap)',
          )
        },
        (error: unknown) => {
          createLogger('sessionpage/deliver').error(
            { sessionId, err: error instanceof Error ? error.message : String(error) },
            'ACP 会话已起,解析不出它的 agent(未读留在本机 outbox,等下一个触发)',
          )
        },
      )
    })
    const senderBinding = async (context: LocalSessionBridgeContext, ownerUserId: string | null) => {
      return resolveSessionpageSenderBinding(context.sessionId, {
        listRoster: () => listAgents(process.env, { includeGuests: true }),
        ownerUserId,
      })
    }
    /**
     * 身份写法的收件人在本机是哪条会话(本机名录 → 它的投递属主报的会话),以及哪些已被删除 —— reaper 的墓碑是唯一能把
     * 「不可达」说成「已删除」的证据。只读;投递与 `session:` 同一条路(编排层的 message 动作)。
     */
    const localSessionsOfAgents = async (userIds: string[]) => {
      const tombstones = await listReapedAgents(process.env)
      const deletedRecipients = tombstones
        .filter((tombstone) => userIds.includes(tombstone.gugu_user_id))
        .map((tombstone) => ({ userId: tombstone.gugu_user_id, name: tombstone.name }))
      const sessions = new Map(userIds.flatMap((userId) => {
        const sessionId = localDelivery.sessionIdForAgent(userId)
        return sessionId ? [[userId, sessionId] as const] : []
      }))
      return { sessions, deletedRecipients }
    }
    // agent 的 session_* 跨机器:发起方自述 —— 另一台机器执行时,凡本机从发起方会话行上读的都由它带过去。
    const remoteCaller = async (auth: RuntimeAuth, context: LocalSessionBridgeContext): Promise<RemoteSessionCaller> => {
      const machine = await crossMachine().thisDevice()
      const agentUserId = await senderBinding(context, auth.userId).then((binding) => binding.guguAgentUserId, () => null)
      const facts = await emdash.sessionCallerFacts(context)
      return { deviceId: machine.deviceId, deviceLabel: machine.label, agentUserId, ...facts }
    }
    // #4562 —— 本机直投唯一入口 session_message 的宿主收敛点。寻址解析在 unified-session-message.ts(可单测);
    // 投递只有一条:会话页后端编排的 message 动作(身份写法先换成它那条会话)。
    const unifiedSessionMessage = async (
      auth: RuntimeAuth,
      context: LocalSessionBridgeContext,
      record: Record<string, unknown>,
      signal: AbortSignal,
    ): Promise<unknown> => {
      signal.throwIfAborted()
      record=await withAssistantWorkReply(record,await emdash.readCurrentAssistantWorkInput(context.sessionId),async number=>
        (await crossMachine().messageDeps(()=>remoteCaller(auth,context),signal).locateAgents({userIds:[],numbers:[number]})).numberToUserId.get(number))
      const prepareFiles = async (files: SessionFileInput[], targets: Array<{sessionId: string; deviceId?: string; agentId?: string}>) => {
          await crossMachine().assertFileHandoffSupported(targets.flatMap(target => target.deviceId && !target.agentId ? [target.deviceId] : []))
          const sender = await senderBinding(context, auth.userId)
          if (!sender.guguAgentUserId || !auth.accessToken) throw new Error('Session file handoff requires an Agent identity')
          const caller = await remoteCaller(auth, context)
          const remotePeers = new Map<string, Array<Record<string, unknown>>>()
          const recipients: string[] = []
          for (const target of targets) {
            let agentId: string | null = target.agentId ?? null
            if (agentId) { recipients.push(agentId); continue }
            if (!target.deviceId) agentId = await guguAgentUserIdForSession(target.sessionId, process.env)
            else {
              if (!remotePeers.has(target.deviceId)) remotePeers.set(target.deviceId, await crossMachine().runOnDevice(target.deviceId, caller, { action: 'peers' }, signal) as Array<Record<string, unknown>>)
              const peer = remotePeers.get(target.deviceId)!.find(row => row.sessionId === target.sessionId || row.session_id === target.sessionId)
              const identity = peer?.identity as { users?: { id?: string } } | undefined
              agentId = typeof peer?.agentUserId === 'string' ? peer.agentUserId : typeof peer?.agent_user_id === 'string' ? peer.agent_user_id.replace(/^user:/, '') : identity?.users?.id ?? null
            }
            if (!agentId) throw new Error(`Session attachment recipient has no Agent identity: session:${target.sessionId}`)
            recipients.push(agentId)
          }
          const endpoint = configuredEndpoint(auth.accessToken)
          signal.throwIfAborted()
          return uploadSessionFiles(endpoint, files, { agentId: sender.guguAgentUserId, sessionId: context.sessionId, recipients, beforeCommit: async () => signal.throwIfAborted() })
      }
      return handleUnifiedSessionMessage(record, {
        prepareFiles,
        localDeviceId: () => crossMachine().thisDevice().then(row => row.deviceId),
        enqueueWork: enqueueAssistantWorkMessage,
        workTitle:async(intent,targets)=>{
          const store=assistantWorkForAgent(intent.assistant_id)
          if(!store)throw new Error('Assistant dispatch reference is unavailable')
          // Dispatch never waits on reachability: only a local task's title is read here. A remote or
          // unreadable one keeps the requested title; the work list projects it from the device digest.
          const target=targets.length===1?targets[0]:undefined
          if(!target||target.deviceId!==(await crossMachine().thisDevice()).deviceId)return intent.title
          return store.dispatchTitle(intent.work_id,intent.operation_id,async()=>{
            const snapshot=await emdash.runSessionAction(context,{action:'get',session_id:target.sessionId},signal)
            const title=(snapshot as {title?:unknown})?.title
            if(typeof title!=='string')throw new Error('Addressed task has no readable title')
            return title
          }).catch((error:unknown)=>{
            if(signal.aborted)throw error
            createLogger('assistant/work').warn({workId:intent.work_id,error:String(error)},'assistant work title unavailable; dispatching with the requested title')
            return intent.title
          })
        },
        enqueueReport: async report => {
          const current = await assistantWorkDeliveryHost().context()
          if (!current || current.ownerId !== auth.userId) throw new Error('Work account changed')
          const identity = makeIdentityClient(auth.accessToken!)
          const { data, error } = await identity.from('agent_provisions').select('agent_user_id,device_id,member_key,phase,created_at')
            .eq('owner_user_id', auth.userId).eq('member_key', 'assistant')
          if (error) throw error
          const assistant = pickAssistant((data ?? []) as AssistantProvisionRow[])
          if (!assistant) throw new Error('Personal assistant is not available')
          const receipt = await enqueueAssistantWorkReport({
            rpc: (name, args) => current.client.rpc(name, args),
            prepare: (files, target) => prepareFiles(files, [target]),
            resolveNumbers: async numbers => (await crossMachine().messageDeps(() => remoteCaller(auth, context), signal).locateAgents({userIds: [],numbers})).numberToUserId,
            id: createDesktopWorkReportIds(context.sessionId),
          }, {assistantId:assistant.agentId,runtimeInstanceId:current.runtimeInstanceId,deviceId:current.deviceId,sessionId:context.sessionId,record:report})
          void assistantWorkDeliveryHost().kick()
          return receipt
        },
        graphMessage: async (sessionIds, text, said) => await emdash.runSessionAction(
          context,
          { action: 'message', session_ids: sessionIds, text, ...said } as SessionAction,
          signal,
        ) as { recipients: UnifiedRecipientResult[] },
        // 调用者是谁(判自指):分叉的 context 已被改写成来源会话。
        caller: { sessionId: context.sessionId, runtimeFork: context.sourceSessionId !== undefined },
        localSessionsOfAgents,
        // #5048 `gugu:<号>` 是 `user:` 键的短写法:名录就是 session_peers 那一份,❌ 不另开一条查号的路。
        resolveLocalGuguNumbers: async (numbers) => {
          const peers = await localSessionPeers(emdash, auth)
          const byNumber = new Map<number, string>()
          for (const peer of Array.isArray(peers) ? peers : []) {
            const users = peer?.identity?.users
            if (typeof users?.gugu_number === 'number' && typeof users?.id === 'string' && numbers.includes(users.gugu_number)) {
              byNumber.set(users.gugu_number, users.id)
            }
          }
          return byNumber
        },
        localSessionIds: (sessionIds) => emdash.localSessionIds(sessionIds),
        remote: crossMachine().messageDeps(() => remoteCaller(auth, context), signal),
      })
    }
    const listActivity = createActivitySummaryQuery()
    localSessionActionDispatcher = async (auth, context, action, signal) => {
      signal.throwIfAborted()
      if (!action || typeof action !== 'object') {
        // 宿主转发的是不透明的 IPC 输入;形状由 runSessionAction 自己按 action 判别式分派、不认识即抛。
        return emdash.runSessionAction(context, action as SessionAction, signal)
      }
      let record = action as Record<string, unknown>
      const projectResult = (result: unknown) => typeof record.action === 'string' && record.action.startsWith('project_')
        ? prepareProjectAgentNotice(result, {
          agentUserId: () => senderBinding(context, auth.userId).then((binding) => binding.guguAgentUserId),
          ensureAccess: (agent, project) => ensureProjectNoticeAccess(auth, agent, project, { founding: record.action === 'project_create' }),
        })
        : result
      if (record.action === 'devices') return crossMachine().listDeviceRows()
      if (record.action === 'activity_list') {
        const caller = await remoteCaller(auth, context)
        return listActivity(record, { scope: `${auth.userId}:${context.sessionId}`,
          devices: () => crossMachine().activityDevices(),
          query: (device, query, stepSignal) => device.this_machine
            ? emdash.runSessionAction(context, { action: 'activity_list', ...query }, stepSignal)
            : crossMachine().runOnDevice(device.device_id, caller, { action: 'activity_list', ...query }, stepSignal),
        }, signal)
      }
      // gugu-dev#181 ⑨ 问自群里的那一句,问题卡也进那个群(question-card.ts)。
      if (record.action === 'ask_user') {
        const asked = await emdash.runSessionAction(context, record as SessionAction, signal)
        return withQuestionCard({ auth, caller: await remoteCaller(auth, context), projectId: context.projectId, asked, questions: record.questions })
      }
      // #7199 第二步:列我的设备与它们的动作 / 调某台设备的某个动作(`device` 是目标,❌ 当成「在那台机器上做」转发)。
      if (record.action === 'device_actions') {
        const device = typeof record.device === 'string' ? record.device : undefined
        const filter = {
          ...(typeof record.group === 'string' && record.group ? { group: record.group } : {}),
          ...(typeof record.name === 'string' && record.name ? { name: record.name } : {}),
        }
        const devices = await deviceActionCaller().describe(device, filter)
        if (!device) return { devices, next: 'Call device_actions with device:<id> to see each action of that device, then with group or name for the description and input_schema before device_call.' }
        if (!filter.group && !filter.name) return { devices, next: 'Call device_actions with this device and group:<group> (or name:<action>) for the description and input_schema before device_call.' }
        return { devices }
      }
      if (record.action === 'device_call') {
        // 谁调的:只用于那台设备「最近调用」里给人看,查不到就不带(❌ 为它拦下动作)。
        const who = await remoteCaller(auth, context).catch((error: unknown) => {
          createLogger('device-actions').warn({ err: error instanceof Error ? error.message : String(error) }, 'device_call caller identity unavailable')
          return null
        })
        const call = {
          device: String(record.device ?? ''),
          name: String(record.name ?? ''),
          args: { ...(record.args && typeof record.args === 'object' ? record.args as Record<string, unknown> : {}), ...((record.name === 'recordings.read' || record.name === 'photos.read') ? { _phone_file_transport: 1 } : {}) },
        }
        const taskTitle = call.name.startsWith('computer.')
          ? await emdash.emdashSessionpageSessionFacts().then(
            (rows) => rows.find((row) => row.sessionId === (context.sourceSessionId ?? context.sessionId))?.title,
            (error: unknown) => {
              createLogger('device-actions').warn({ err: String(error) }, 'device_call task title unavailable')
              return undefined
            },
          ) : undefined
        const caller = who ? { ...(who.agentUserId ? { agent_user_id: who.agentUserId } : {}), ...(who.name ? { name: who.name } : {}), ...(taskTitle ? { task_title: taskTitle } : {}) } : undefined
        // A side chat's steps are its task's: the task's 「电脑」 tab shows them (the side chat is a view of it).
        const ended = computerStepStarted({ projectId: context.projectId, sessionId: context.sourceSessionId ?? context.sessionId,
          cursorSession: computerSessionOf({ caller }),
        }, call)
        let result: DeviceActionResult
        try {
          result = await deviceActionCaller().call({
            deviceId: call.device,
            action: call.name,
            args: call.args,
            ...(typeof record.timeout_ms === 'number' ? { timeoutMs: record.timeout_ms } : {}),
            ...(caller ? { caller } : {}),
            signal,
          })
        } catch (error) {
          ended?.(error instanceof Error ? error : new Error(String(error)))
          throw error
        }
        // After the call, outside its try: what the preview does with the result never turns a step that ran into an error.
        ended?.(result)
        if (record.name === 'recordings.read' || record.name === 'photos.read') {
          const args = record.args && typeof record.args === 'object' ? record.args as Record<string, unknown> : {}
          const transfer = await receivePhoneDeviceFile({
            first: result,
            args,
            root: join(resolveGuguHome(process.env), 'device-reads', context.sessionId),
            signal,
            read: (next) => deviceActionCaller().call({
              deviceId: String(record.device ?? ''), action: String(record.name), args: { ...next, _phone_file_transport: 1 },
              ...(typeof record.timeout_ms === 'number' ? { timeoutMs: record.timeout_ms } : {}),
              ...(who ? { caller: { ...(who.agentUserId ? { agent_user_id: who.agentUserId } : {}), ...(who.name ? { name: who.name } : {}) } } : {}),
              signal,
            }),
          })
          return hoistDevicePictures(transfer)
        }
        return hoistDevicePictures(result)
      }
      if (record.action === 'project_add_device') {
        const caller = await remoteCaller(auth, context)
        const onDevice = async (device: string | undefined, step: Record<string, unknown>) =>
          device && !(await crossMachine().isThisDevice(device))
            ? crossMachine().runOnDevice(device, caller, step as { action: string }, signal)
            : emdash.runSessionAction(context, step as SessionAction, signal)
        return projectResult(await linkProjectDevice(record as unknown as Parameters<typeof linkProjectDevice>[0], onDevice))
      }
      // `device`:还没有地址的动作在那台机器上做。
      if (typeof record.device === 'string') {
        const { device, ...rest } = record
        if (!(await crossMachine().isThisDevice(device as string))) {
          return projectResult(await crossMachine().runOnDevice(device as string, await remoteCaller(auth, context), rest as { action: string }, signal))
        }
        record = rest
      }
      if (record.action === 'peers') return localSessionPeers(emdash, auth)
      // 名录类工具给 agent 行带状态:跑在这台机器上的那些,读宿主按 agent 的状态流(咕咕一侧读会话页状态的唯一入口);
      // 不在流里的由调用方去问云端 presence。
      if (record.action === 'agent-status') {
        const ids = Array.isArray(record.agentUserIds) ? record.agentUserIds.filter((id): id is string => typeof id === 'string') : []
        return ids.flatMap<{ agentUserId: string; status: string | null; detail: string | null }>((agentUserId) => {
          const entry = agentStatusFeed.get(agentUserId)
          const archived = getSessionpageLocalDelivery().sessionArchivalForAgent(agentUserId)?.archivedAt
          return archived ? [{ agentUserId, status: 'archived', detail: null }] : entry ? [{ agentUserId, status: entry.reading?.status ?? null, detail: entry.reading?.detail ?? null }] : []
        })
      }
      if (record.action === 'message') return unifiedSessionMessage(auth, context, record, signal)
      // `session:<id>` 是账号级的地址:本机库里没有就在别的机器上。
      const sessionId = typeof record.session_id === 'string' ? record.session_id : undefined
      const elsewhere = sessionId !== undefined && !(await emdash.localSessionIds([sessionId])).length
      if (record.action === 'children') {
        if (elsewhere) await crossMachine().deviceOfSession(sessionId, await remoteCaller(auth, context), signal)
        const local = await emdash.runSessionAction(context, record as SessionAction, signal)
        return crossMachine().withRemoteChildren(local, sessionId, () => remoteCaller(auth, context), signal)
      }
      if (['get', 'stop', 'archive', 'set_parent'].includes(String(record.action)) && elsewhere) {
        return crossMachine().runOnSession(sessionId, await remoteCaller(auth, context), record as { action: string }, signal)
      }
      return projectResult(await emdash.runSessionAction(context, record as SessionAction, signal))
    }
    // 别的机器交过来的 session 动作:名录在宿主这一侧,其余交给会话页编排 —— 都与本机工具同一份实现。
    emdash.setAgentSessionHost(async (name, caller, action) => {
      const auth = await desktopAuthProvider().getAuth().catch(() => null)
      if (!auth?.accessToken || !auth.userId) throw new CrossMachineError('host_not_signed_in', 'that machine is not signed in to 咕咕')
      const signal = new AbortController().signal
      return crossMachine().answer(name, caller, action, {
        peers: () => localSessionPeers(emdash, auth),
        // app_install { device } from another machine: installed here the way a card's package is — fetched and checked
        // here (L4 10-02); the same dispatcher as this machine's app_*. D-31: that machine asks the person, as its agent's
        // approval — `consent` says hand back the ask, or install the bytes they agreed to.
        // #7290 A folder of the owner's from that machine comes over this channel part by part, then installs as a folder;
        // a card by its message.
        run: (caller, action) => action.action === 'app_manage'
          ? emdash.runEmdashExtensionAction({ ...action, action: 'manage', consent: action.consent ?? { kind: 'return' } })
          : action.action === 'app_install'
            ? emdash.runEmdashExtensionAction(appInstallFrom(caller.deviceId, action))
            : emdash.runRemoteSessionAction(caller, action as never, signal),
        app: (caller, action) => emdash.answerAppMessage(caller, action),
        appSpawn: (caller, action) => emdash.spawnAgentForExtension({ extensionId: caller.extensionId, extensionName: caller.extensionName, prompt: action.prompt, ...action.spawn }),
        appReadFile: (caller, action) => emdash.answerAppReadFile(caller, action),
        appCall: (caller, action) => emdash.answerAppCall(caller, action),
      })
    })
    // 归档「连同子会话」跨机器(owner 2026-10-01「一起收」):人点的与 agent 的同一个动作,都经这里到别的机器。
    emdash.setOtherMachines({
      devices: () => crossMachine().devices(),
      isThisDevice: (deviceId) => crossMachine().isThisDevice(deviceId),
      appSpawn: (app, deviceId, action) => crossMachine().appSpawn(app, deviceId, action),
      sessions: (since, options) => crossMachine().sessionsElsewhere(since, options),
      archive: (deviceId, sessionId) => crossMachine().archiveOn(deviceId, sessionId),
      appMessage: (app, deviceId, sessionId, text, how) => crossMachine().appMessage(app, deviceId, sessionId, text, how),
      appReadFile: (app, deviceId, action) => crossMachine().appReadFile(app, deviceId, action),
      appCall: (app, deviceId, action) => crossMachine().appCall(app, deviceId, action),
    })
    // 打开会话只有一条路(gugu-links.openLink):agent 的会话先看本机映射,再到它所在的机器上找;本机会话打开前先做平台恢复。
    emdash.setSessionOpening({
      agentSession: async (agentId, deviceId) => {
        const here = await readSessionpageOpenTarget(agentId)
        return here ? { sessionId: here.sessionId } : crossMachine().sessionOfAgent(agentId, deviceId)
      },
      ensureReady: async (sessionId) => {
        const ready = await ensureSessionpageSessionReady(sessionId, 'sessionpage-open')
        if (ready.status === 'failed') createLogger('sessionpage/platform').error({ sessionId, error: ready.error }, 'sessionpage-open platform recovery failed')
      },
    })
    // 触发②(agent 停下):running→false 的转变事件踢一次读者(触发④开机扫在 boot 那里)。
    agentStatusFeed.subscribe((agentUserId, entry, previous, version) => {
      // 按 agent 的同一份条目,两个读者:聊天页的本机事件流与云端 presence(device-runtime 那条腿)。
      mainWindow?.webContents.send('agent-status-feed', { agentUserId, entry, version })
      // agent 停下(做完、被打断、进 park)= 又收得进投递了:排着的消息现在就拉进来。
      if (entry && previous?.reading?.running && !entry.reading?.running) kickInboxForAgent(agentUserId, 'agent-stopped')
    })
    // @@@sessionpage TASKPAGE-FUSION — hand the session-page delivery target the session backend's control-channel
    // surface, so an agent.deliver addressed to a live session-page agent injects a new ACP turn; a
    // mapped offline target is queued, while transport errors remain fail-loud. Never a pty write.
    emdashAgentRegistry.setBridge(emdash)
    // 编号 5: the reconnect a delivery kicked for a lost session ended (up, failed, or over budget): pull its inbox again —
    // up, the batch goes in; not, it fails in its chat. The same shape as the claude TUI leg's onOverdue.
    emdashAgentRegistry.setReconnectSettledHook((agentUserId) => kickInboxForAgent(agentUserId, 'reconnect-settled'))
    // @@@sessionpage TASKPAGE-FUSION — re-map every persisted session-page agent binding at boot so it stays
    // addressable BEFORE its session-page session reopens: a deliver to a mapped-but-not-live agent becomes
    // ordered local debt instead of silently passing through to a gugu-native engine spawn.
    // @@@sessionpage TASKPAGE-FUSION — deletion sync (spec ⑨「删除必同步」): reconcile the social-side
    // projection against the session page, reaping agents whose conversation was deleted and
    // archiving groups whose project is gone. Runs at boot (so removals made while gugu was closed still
    // converge) and on every session-page removal trigger. The reap itself is fail-loud/aggregated; here we only
    // log, because a failed reconcile must not take down the app — the next trigger retries it.
    const getSessionpageAuth = async () => {
      const auth = await authProvider?.getAuth()
      return auth?.accessToken && auth.userId
        ? { accessToken: auth.accessToken, refreshToken: auth.refreshToken ?? '', userId: auth.userId }
        : null
    }
    app.once('will-quit', startSessionpageAgentArchivalSync({ getAuth: getSessionpageAuth, resolveDeviceId: localDeviceId,
      inventory: () => emdash.emdashSessionpageInventory(), subscribe: (listener) => emdash.onEmdashSessionpageReapTrigger(listener) }))
    // @@@task-shell-port (#5012) 「给会话开账号」的口与网页版无头宿主共用(sessionpage-identity-host.ts);
    // 这里只喂它桌面版的四样:登录态、设备 id、项目名、会话事实。
    const sessionpageIdentityHost = createSessionpageIdentityHost({
      getAuth: getSessionpageAuth,
      // #4320② 锁内解析:localDeviceId 不起 tick,不会派发要同一把锁的设备命令。
      resolveDeviceId: localDeviceId,
      resolveProjectName: (projectId: string) => emdash.emdashProjectName(projectId),
      takeBirthGroup: (sessionId: string) => emdash.emdashTakeBirthGroup(sessionId),
      sessionFacts: (target) => emdash.emdashSessionProvisionInput(target),
      listSessionFacts: () => emdash.emdashSessionpageSessionFacts(),
    })
    const sessionpageIdentityDeps = sessionpageIdentityHost.provisionDeps
    // 项目的跨设备身份由宿主的群对照维护；每次写入后通知渲染层重读。
    emdash.setUserLibraryOwner(async () => (await getSessionpageAuth())?.userId ?? null)
    const assistantPanel = createAssistantPanelRuntime({
      locale: currentHostLocale,
      getAuth: getSessionpageAuth,
      instanceId: () => deviceRuntimeHost?.instanceId ?? null,
      deviceId: async () => { const id = await localDeviceId(); if (!id) throw new Error('PANEL_DEVICE_UNAVAILABLE'); return id },
      local: emdash.assistantPanelLocal,guguHome: resolveGuguHome(process.env),kind: SERVER_MODE ? 'cloud' : 'computer',env: process.env,
      failed: domain => createLogger('assistant-panel').warn({ domain },'Panel publication will retry during host activity'),
    })
    emdash.setSessionAdmissionPreparation((sessionId,text) => assistantPanel.prepare(sessionId,text))
    emdash.setProjectGroupHost(createSessionpageProjectGroupHost({ getAuth: getSessionpageAuth, env: process.env }))
    onProjectGroupMappingChanged(({ projectId }) => emdash.notifyProjectGroupBindingChanged(projectId))
    setSessionpageAgentCardRevoker(revokeAgentCards)
    // @@@task-shell-port (#5057) 「咕咕自营模型」那五个钩子的实现与网页版无头宿主共用一份
    // (sessionpage-platform-hooks.ts)。❌ 别把实现搬回这里:网页版就是因为实现只住在这个文件里,
    // 才整整缺了这一层,而它的缺席是静默的。
    // #6264 宿主供给凭据的终端会话活过宿主进程重启:端口、口令、会话行落在本账号数据目录(见 sessionpage-platform-model)。
    {
      const relayLog = createLogger('stable-endpoint')
      configurePlatformRelayPersistence({
        dataDir: app.getPath('userData'),
        log: {
          info: (message, fields) => relayLog.info(fields ?? {}, message),
          warn: (message, fields) => relayLog.warn(fields ?? {}, message),
        },
      })
    }
    // 会话中途签不出票时 agent 界面上那一句,跟宿主语言走(现读:用户中途切语言也跟着变)。
    configurePlatformCredentialCopy(() => currentHostCatalog().sessionPlatform.credentialUnavailable)
    // #7103 取票被咕咕拒:先把原因递进那条通用形态会话进行中的那一轮,再回 403(见 tellCredentialRefusal)。
    configurePlatformCredentialRefusalSink((sessionId, code) =>
      loadEmdashBridge()?.announceEmdashSession({ sessionId, credentialRefusal: code }) ?? Promise.resolve())
    // #7056 会员中途到期:续期发现这条会话的模型被收掉了 ⇒ 告诉任务页,它刷新目录、在下一轮之前停下说清。
    configurePlatformMembershipListener((change) => {
      mainWindow?.webContents.send('session:platform-membership-changed', change)
    })
    const sessionpagePlatformHooks = createSessionpagePlatformHooks({
      // #5092 现读:这一格在 `startDeviceRuntimeWhenRendererReady()` 之前构造,当场取值只会取到 null,
      // 而且是**永久**的 —— 下拉列得出咕咕模型(那条 IPC 在 handler 体内现读)、一开会话必报
      // 「platform model token requires authenticated Supabase runtime auth」。
      authProvider: () => authProvider,
      provisionDeps: sessionpageIdentityDeps,
      // PTY 那腿多挂 onTurnLifecycle,与 ACP 那份不是同一个对象;它定义得比这里晚,故惰性取。
      ptyProvisionDeps: () => sessionpageProvisionDeps,
      // 两家 detachedInference 拓扑各自回答自己那台推理进程;一条 conversation 只属于其中一家。
      inferenceProcessLive: (sessionId) =>
        codexPtyProvisioning.hasLiveSession(sessionId)
        || opencodeServeAttachSessionDelivery.hasLiveServe(sessionId),
      onPlatformCredentialExpired: async (target) => {
        sessionpagePlatformRecovery?.markExpired(target)
      },
      onPlatformCredentialObservation: (sessionId, observation) => {
        sessionpagePlatformRecovery?.recordObservation(sessionId, observation)
      },
      onPlatformSessionEnded: (sessionId) => sessionpagePlatformRecovery?.forget(sessionId),
      onHostResume: resumeAllCodexAppServerTurnWaiters,
      env: process.env,
    })
    sessionpagePlatformRecoveryHooks = sessionpagePlatformHooks
    /** The conversation-keyed owner of a credential target, if it declares that target's provider × surface. */
    const credentialOwnerOf = async (target: { sessionId: string; providerId: string; surface: string }) => {
      const owner = await getSessionpageLocalDelivery().deliveryTargetForSession(target.sessionId)
      const session = owner ? await owner.target.sessionProviderSurface(owner.deliveryKey) : null
      return session?.providerId === target.providerId && session.surface === target.surface ? owner!.target : null
    }
    const recovery = new SessionpagePlatformRecoveryCoordinator({
      isExpired: (sessionId) => expiredPlatformModelSessions().includes(sessionId),
      resolveTarget: (sessionId) => sessionpagePlatformRecoveryHooks?.targetForSession(sessionId) ?? null,
      currentGeneration: platformCredentialGenerationForSession,
      requestCredentialsManaged: (target) => platformRequestsUseCredentialProxy(target.sessionId),
      credentialLifecycleFor: (target) => resolveSessionpageCredentialLifecycle(target.providerId, target.surface),
      refresh: async (target) => {
        if (!await reissueExpiredPlatformModelForSession(target.sessionId)) {
          throw new Error('platform credential original-process refresh did not establish a new lease')
        }
      },
      reopen: async (target) => {
        const emdash = loadEmdashBridge()
        if (!emdash) throw new Error('任务页运行时不可用，无法恢复平台会话')
        const reload = () => emdash.reloadEmdashSession({
          sessionId: target.sessionId,
          reason: 'platform-credential-expired',
        })
        if (target.credentialGeneration) {
          await emdash.withEmdashPlatformSessionRestart(target.sessionId, target.credentialGeneration, reload)
        } else {
          await reload()
        }
      },
      waitUntilReady: async (target) => {
        // Native owners must expose an admission waiter. Lookup is the router's own conversation-keyed owner and its
        // declared session surface, never a provider-specific lifecycle branch.
        const owner = await credentialOwnerOf(target)
        if (!owner) throw new Error(`sessionpage credential owner is not live for ${target.providerId}/${target.surface}`)
        if (!owner.waitUntilReady) {
          throw new Error(`sessionpage owner ${owner.deliveryTargetName ?? 'unknown'} has no admission waiter`)
        }
        await owner.waitUntilReady(target.sessionId)
      },
      isTurnInFlight: async (target) => {
        const owner = await credentialOwnerOf(target)
        return owner?.isSessionTurnInFlight ? await owner.isSessionTurnInFlight(target.sessionId) : false
      },
      onStateChange: (target, state) => {
        createLogger('sessionpage/platform').info({
          sessionId: target.sessionId,
          status: state.status,
          ...(state.observation ? { observation: state.observation } : {}),
          ...(state.error ? { error: state.error } : {}),
        }, '平台凭据恢复状态变化')
        mainWindow?.webContents.send('session:platform-recovery-changed', {
          ...target,
          status: state.status,
          ...(state.error ? { error: state.error } : {}),
        })
      },
    })
    sessionpagePlatformRecovery = recovery
    const recoveryBridge = loadEmdashBridge()
    if (!recoveryBridge) throw new Error('任务页运行时不可用，无法安装平台恢复 gate')
    recoveryBridge.setPlatformRecoveryReadyGate((sessionId, trigger) => recovery.ensureReady(sessionId, trigger))
    reconcileSessionpagePlatformOnResume = async () => {
      await sessionpagePlatformHooks.onHostResume()
      await recovery.reconcileExpired()
    }
    /**
     * 对话页「新建 Agent」那一句 —— **它是一条真的咕咕消息,不是会话的启动参数**。
     *
     * 两条腿(ACP 的 `session/prompt`、PTY 的 argv/stdin)共用这一个函数,所以「首句怎么变成一条
     * 消息」只有一条链(#4500 §二 第一禁令)。会话起来之前依序做完:
     *   1. 私聊开好 —— 它是这条消息的容器,也是 agent 回复要落回去的地方;
     *   2. 按 exact `messageId` **幂等**落库 —— 聊天页那个正常气泡就是它。幂等是因为 spawn 会重试
     *      (pty 起不来、能力物化失败),重试必须收敛到同一条消息而不是又发一条;
     *   3. 给 agent 标记已读 —— 否则收件箱读者会把同一条**再投递一遍**,变成两轮;
     *   4. 交回 route=chat 信封,由调用方塞进这条腿自己的启动槽。
     *
     * ⚠️ 信封是**临时构造**的,❌ 不写进持久化的 `config.initialPrompt`(spec agent-create);
     *    落库与重开会话读到的一直是裸文本 + 稳定 message id。
     */
    const landChatPageFirstTurn = async (input: {
      sessionId: string
      guguAgentUserId: string
      knownChatId: string | null | undefined
      messageId: string
      text: string
      /** gugu-dev#181 派任务:首句落成这个对话里的一张任务卡(task-card-first-turn.ts),❌ 进 agent 私聊。 */
      taskChatId?: string
      projectId: string
    }): Promise<{ chatId: string; firstTurn: string; envelope: boolean }> => {
      const content = input.text.trim()
      if (!content) {
        throw new Error(`chat-page first turn for ${input.sessionId} has no text`)
      }
      const auth = await getSessionpageAuth()
      if (!auth) throw new Error('chat-page startup envelope: owner not authenticated')
      if (input.taskChatId) {
        const deviceId = await localDeviceId()
        if (!deviceId) throw new Error(`task card for ${input.sessionId}: this device is not registered yet`)
        return landTaskCardFirstTurn({
          auth,
          sessionId: input.sessionId,
          projectId: input.projectId,
          agentUserId: input.guguAgentUserId,
          chatId: input.taskChatId,
          messageId: input.messageId,
          text: content,
          deviceId,
          machineLabel: (await getLocalDeviceSelfSnapshot())?.label || hostname(),
          senderIdentities: await envelopeSenderIdentities(auth.userId, auth.accessToken),
          timestamp: formatDeliveryTimestamp(new Date().toISOString()),
          env: process.env,
        })
      }
      const chatId = input.knownChatId || await openOwnerDirectChatForAgent(
        input.guguAgentUserId,
        auth.accessToken,
        process.env,
      )
      const envelope = buildAgentDeliveryEnvelope(
        {
          guguUserId: input.guguAgentUserId,
          chatId,
          messageId: input.messageId,
          senderUserId: auth.userId,
          content,
          replyTo: null,
          threadRootId: null,
        },
        await envelopeSenderIdentities(auth.userId, auth.accessToken),
        { publicId: null, name: null, kind: 'dm' },
        formatDeliveryTimestamp(new Date().toISOString()),
      )
      const { error: messageError } = await makeChatClient(auth.accessToken).rpc('send_message_idempotent', {
        p_message_id: input.messageId,
        p_chat_id: chatId,
        p_sender_user_id: auth.userId,
        p_to_user_ids: [input.guguAgentUserId],
        p_content: content,
        p_content_type: 'text',
        p_reply_to_message_id: null,
        p_thread_root_id: null,
        p_is_thread_root: false,
        p_is_whisper: false,
      })
      if (messageError) throw new Error(`chat-page initial message write failed: ${messageError.message}`)
      const { error: readError } = await makeIdentityClient(auth.accessToken).rpc('mark_read_on_deliver', {
        p_chat_id: chatId,
        p_message_id: input.messageId,
        p_user_id: input.guguAgentUserId,
      })
      if (readError) throw new Error(`chat-page initial message read mark failed: ${readError.message}`)
      return { chatId, firstTurn: envelope, envelope: true }
    }
    ipcMain.removeHandler(SESSION_SHELL_CHANNELS.ensureAgentAddress)
    handleShellChannel(SESSION_SHELL_CHANNELS.ensureAgentAddress, (_event, input: unknown) =>
      sessionpageIdentityHost.ensureAgentAddress(input as Parameters<typeof sessionpageIdentityHost.ensureAgentAddress>[0]),
    )
    // #6091 会话页「重命名」弹窗里改 agent 名。改完两处要知道:会话页(侧栏身份卡 / 分享按钮提示,按 conversationId
    // 认领)与 gugu 渲染层的通讯录(它缓存着 display_name,不叫它刷新,聊天页就还挂着旧名)。
    ipcMain.removeHandler(SESSION_SHELL_CHANNELS.renameAgent)
    handleShellChannel(SESSION_SHELL_CHANNELS.renameAgent, async (_event, input: unknown) => {
      const renamed = await sessionpageIdentityHost.renameAgent(
        input as Parameters<typeof sessionpageIdentityHost.renameAgent>[0],
      )
      sendSessionpageIdentityEvent(sessionpageAgentRenamedEvent, renamed)
      sendUiEvent(MAIN_UI_EVENTS.ownedAgentRenamed, { agentUserId: renamed.agentUserId, displayName: renamed.displayName })
      tellRenamedAgentsSession({ agentUserId: renamed.agentUserId, displayName: renamed.displayName })
      return renamed
    })
    const runSessionpageReap = (reason: string, info?: { deadSessionId?: string }): void => {
      void reconcileSessionpageAgents({
        // 真删除时会话页后端才点名:归档会话与原身份仍在清单里,不会进入删除路径;
        // detach 不点名(会话还活着)。
        deadSessionIds: info?.deadSessionId ? [info.deadSessionId] : undefined,
        getAuth: getSessionpageAuth,
        resolveDeviceId: localDeviceId,
        getInventory: () => emdash.emdashSessionpageInventory(),
        disposeSession: async (sessionId) => {
          await teardownSessionpageSessionRuntimes(sessionId)
          await primaryGuguMcpHost?.revoke(sessionpageSurfaceKey(sessionId))
          await closeSessionBrowserTools(sessionId, emdash.emdashAgentBrowser())
          forgetSessionAppScope(sessionpageSurfaceKey(sessionId))
        },
        env: process.env,
      })
        .then(({ reapedAgents, archivedGroups }) => {
          // Always log the boot passes (a silent "nothing happened" is indistinguishable from "never ran" —
          // that ambiguity already hid an ordering bug once). Per-trigger passes log only when they act,
          // since a plain tab detach fires the trigger too and would otherwise spam the log.
          if (reason.startsWith('boot') || reapedAgents || archivedGroups) {
            console.log(
              `[sessionpage] session-page reap (${reason}): reaped ${reapedAgents} agent(s), archived ${archivedGroups} group(s)`,
            )
          }
        })
        .catch((err) => console.warn(`[sessionpage] session-page reap (${reason}) failed: ${(err as Error).message}`))
    }
    // The boot pass is kicked off only after bootEmdashModule resolves (see below) — it READS the session
    // backend's database, which bootEmdashModule is what initializes.
    if (!isQuitting) {
      sessionpageLocalSessionSource = createHostLocalSessionSource(app.getPath('userData'))
      emdash.setEmdashLocalSessionSource(sessionpageLocalSessionSource)
    }
    emdash.setEmdashMcpInjector(async (info) => {
      const persistedSessionId = info.sourceSessionId ?? info.sessionId
      const provisioned = await provisionSessionpageAgentForSession(
        {
          // 运行时分叉(侧边聊天)递自己的 view id + 来源会话:它没有会话页身份,provisioning 据此
          // 返回 null,归属与绑定一格都不动(见 SessionpageSessionInfo.sourceConversationId)。
          sessionId: info.sessionId,
          sourceSessionId: info.sourceSessionId,
          providerId: info.providerId,
          surface: 'acp',
          cwd: info.cwd,
          projectId: info.projectId,
          // spec agent-provisioning:显式命名过的会话用那个名字开户;缺席才落到「<引擎 label> <序号>」。
          displayName: info.agentDisplayName,
          lifecycle: info.lifecycle,
        },
        sessionpageIdentityDeps,
      )
      if (!provisioned) {
        if (!authProvider) throw new Error('[sessionpage] MCP injector: runtime auth provider not ready')
        if (!primaryGuguMcpHost) throw new Error('[sessionpage] MCP injector: Gugu MCP host not ready')
        const runAction = (action: unknown, auth: RuntimeAuth, signal: AbortSignal) =>
          runLocalSessionAction(
            auth,
            { ...info, sessionId: persistedSessionId },
            action,
            signal,
          )
        // ── 运行时分叉(侧边聊天):能力包与来源会话**一字不差** ────────────────────────
        // 为什么不给它一套「精简版」:系统提示与工具清单都在模型前缀里。分叉继承的是来源会话的
        // transcript,只要前缀有一处不同,那整段上下文就命中不了缓存 —— 主会话实测量级
        // `input=23,695 (+30,208 cached)`,等于每开一次侧边聊天都全价重算一遍。owner 2026-08-21
        // 定调:侧边聊天多是随手问询,不该为此付这笔钱。
        //
        // 「不落库、没有身份」这条**不靠削工具来表达**,而是靠 socialBridgeDeps.forkOf 那道闸:
        // IM 工具照常注册(前缀因此不变),一调用就拒(见 gugu-im-server.mjs)。身份块沿用来源的
        // —— 它本来就是那条会话的分叉,继承来的 transcript 里也这么写着。
        //
        // ❌ 这里**不 provision**:归属仲裁会 unregister 掉来源会话正在用的 app-server(owner 实测
        // 当场打死主 codex 会话),绑定盖章会把来源的 surface 从 tui 改写成 acp。只读解析,
        // 一格都不写。
        const forkSource = await resolveRuntimeForkSource(info, process.env)
        if (forkSource) {
          const configuredMcp = await sessionBundleUserMcpFor(
            info.providerId,
            () => mcpService.listForAgent(info.providerId, info.cwd),
          )
          /**
           * 分叉**也要平台额度** —— 它此前一格都不带,而那正是 owner 撞到的
           * 「claude 侧边聊天一发就 `Failed to send message`」:
           * 分叉的能力包里 `model` 恒为 `null` ⇒ 平台中转一个字段都不注入,
           * 而会话的 `config.model` 仍是咕咕网关的模型名
           * ⇒ 拿不到咕咕的票去调咕咕的模型,认证当场失败。主会话好、侧边聊天坏,正是这个差。
           *
           * ⚠️ 身份取**来源会话**(`sourceConversationId`):分叉是运行时视图,自己没有行 ——
           * 与 `readSessionInjectionFacts` 那条「运行时分叉的 view id 没有行」同一条规则。
           * ⇒ 语义随之确定:**分叉借来源的身份**,来源换了模型,分叉下次起也跟着换。
           *
           * ⚠️ `ensureAgentUserId` 回来源那个 agent —— 这一格**仍然不 provision**
           * (见上面那段:归属仲裁会打死来源正在用的 app-server)。
           */
          const forkOwnsProcessConfig = providerUsesSessionProcessConfig(info.providerId)
          const forkModelViaConfigFile = providerDeliversModelViaConfigFile(info.providerId, 'acp')
          // 与 fresh 那一处同一口 —— 理由见那边的抬头(#5552:重签会撤掉活适配器手里那张票)。
          const forkPlatform = forkOwnsProcessConfig || forkModelViaConfigFile
            ? await sessionpagePlatformHooks.acpPlatformModel(info)
            : null
          const forkBundle = await buildSessionBundle({
            runtime: { authProvider, env: process.env },
            agentUserId: forkSource.agentUserId,
            sessionKey: info.sessionId,
            ...(forkPlatform
              ? {
                  additionalEnv: {
                    ...forkPlatform.env,
                    ...forkPlatform.spawnEnv,
                    ...configuredMcp.env,
                  },
                }
              : (Object.keys(configuredMcp.env).length > 0
                ? { additionalEnv: configuredMcp.env }
                : {})),
            additionalMcpServers: configuredMcp.servers,
            // 运行时分叉(侧边聊天)沿用启动输入解析出的同一权限档；ACP adapter 的进程参数
            // 与普通 app-server 由同一 session bundle 物化，不能在桥里另猜一档。
            autonomy: info.permissionMode
              ? {
                  mode: autoApproveFromPermissionMode(info.permissionMode)
                    ? ('full-access' as const)
                    : ('approval-required' as const),
                  ...(info.permissionMode ? { permissionMode: info.permissionMode } : {}),
                }
            : null,
            model: sessionBundleModelFor(info.providerId, 'acp', forkPlatform),
          // spec `mcp-session-toggle`:用户为这条会话关掉的那几台。
          // ⚠️ 原样递,`[]` 也递 —— 归一成 undefined 会让「决定过但一台没关」
          //    与「从没碰过」同形,而这条会话的适配器独占正是按前者判的。
          mcpDisabled: info.mcpDisabledServers,
            promptBlocks: {
              identity: await buildAgentIdentityBootstrap(
                { authProvider, env: process.env },
                forkSource.agentUserId,
              ),
            },
            socialBridgeDeps: {
              host: primaryGuguMcpHost,
              resolveFile: desktopFiles.resolve,
              publishFile: (chat, file, actor, message, next) => desktopFiles.publish(chat, file, null, actor, undefined, { message, next }),
              // grant key 用**分叉自己**的会话 id:它必须是独立一格,否则会顶掉来源会话的 grant。
              grantKey: sessionpageSurfaceKey(info.sessionId),
              runHostAction: runAction,
              runSessionAction: runAction,
              forkOf: forkSource.forkOf,
              ...(emdashBridge
                ? { runExtensionAction: extensionActionsFor(info.sessionId) }
                : {}),
            },
          })
          const forkCapabilities = loadSessionAcpCapabilities(info.providerId, forkBundle, {
            cwd: info.cwd,
            lifecycle: info.lifecycle,
          })
          await applySessionMaterialization({
            cwd: info.cwd,
            guguHome: forkBundle.env.GUGU_HOME ?? '',
            materialization: forkCapabilities,
          })
          createLogger('sessionpage').info(
            { sessionId: info.sessionId, sourceSessionId: info.sourceSessionId, agentUserId: forkSource.agentUserId },
            '[sessionpage] runtime fork inherits caps from its source (IM registered but refused)'
          )
          return {
            mcpServers: forkCapabilities.sessionNewPatch?.mcpServers ?? [],
            extensionDelivery: sessionExtensionDelivery(forkBundle),
            spawnEnv: forkCapabilities.spawnEnv,
            spawnArgs: forkCapabilities.extraArgs,
            sessionMeta: forkCapabilities.sessionNewPatch?.meta,
            // The fork branch already materialized OpenCode's process-owned config (including
            // the platform model). Tell the generic ACP platform injector not to dispatch it a
            // second time; `opencode-config-content` intentionally has no generic envelope.
            platformConfigured: Boolean(
              forkPlatform && Object.keys(forkPlatform.env).length > 0
            ),
            // 重开后由 runtime 按它把模型断言一次(#6196):钉在进程配置里的模型,pi 恢复会话时不认。
            ...(forkPlatform?.model && Object.keys(forkPlatform.env).length > 0
              ? { platformModel: forkPlatform.model }
              : {}),
            ...(forkPlatform?.accessSessionId
              ? { platformAccessSessionId: forkPlatform.accessSessionId }
              : {}),
            ...(forkCapabilities.sessionPrompt
              ? {
                  sessionPrompt: {
                    value: forkCapabilities.sessionPrompt,
                    carrier: forkCapabilities.sessionPromptCarrier ?? 'system',
                  } satisfies SessionPromptDelivery,
                }
              : {}),
          }
        }

        const sessionMcp = await buildSessionOnlyBridge(
          { authProvider, env: process.env },
          persistedSessionId,
          {
            host: primaryGuguMcpHost,
            grantKey: sessionpageSurfaceKey(info.sessionId),
            runSessionAction: runAction,
            // @@@2374 不带 auth:写文件与装扩展都不代表用户去调任何云端接口。桥没
            // 加载成功时这条腿就不接,gugu_session 的 app_* 动作于是在调用时报错 ——
            // ❌ 不给一个看起来能用却调不通的动作。
            ...(emdashBridge
              ? { runExtensionAction: extensionActionsFor(info.sessionId) }
              : {}),
          },
        )
        const sessionCapabilities = loadSessionAcpCapabilities(info.providerId, {
          mcpServers: sessionMcp,
          // 侧边聊天(运行时分叉)**没有自己的 `/mcp` 面板** ⇒ 没有用户的关闭决定可带。
          // 显式写 `undefined`:这个键是必答的,正是为了让「这条腿不带它」必须说出口,
          // 而不是和"有人忘了接"长成同一个样子(#5157 的病根就是后者)。
          // 哪天侧边聊天也能开关 MCP,这一行会是一条编译错误,而不是一个静默的空。
          mcpDisabled: undefined,
          env: { GUGU_HOME: resolveGuguHome(process.env) },
          // 侧边聊天只挂咕咕自己那台桥(已连接的集成也不挂),扩展同此。
          extensionSkills: [],
          extensionApps: [],
          extensionServerOrigins: [],
          model: null,
          autonomy: info.permissionMode
            ? {
                mode: autoApproveFromPermissionMode(info.permissionMode)
                  ? ('full-access' as const)
                  : ('approval-required' as const),
                ...(info.permissionMode ? { permissionMode: info.permissionMode } : {}),
              }
            : null,
          // ❌ 运行时分叉(侧边聊天)**不得**在这里多加一格。owner 2026-08-21 定调:分叉会话的
          // harness 自己就带系统提示,分叉又继承了来源会话那一份,再追加一块就是第三份。
          // promptBlocks 走系统提示通道(见 @@@system-prompt-channel),而系统提示在前缀最前面:
          // 分叉与来源只要不一字不差,继承来的那整段上下文就命中不了缓存。
          //
          // ⚠️ 这不等于「摘了块缓存就保住了」:分叉走 session-only 桥,工具清单里没有 gugu_message /
          // gugu_conv,而**工具清单同样在前缀里** —— 只要工具面与来源不同,前缀照样不同。IM 工具
          // 不给分叉是 owner 明确要的(没有身份的东西不该以谁的名义说话),所以这笔缓存代价现在是
          // 认下的定价,不是被这一格解决掉了。分叉继承的自述("你是 Codex 3、用 gugu_message 回话")
          // 与实际工具面不符,由工具缺席自己说话:调不存在的工具当场拿到错误。
          promptBlocks: { platform: GUGU_PLATFORM_BLOCK },
          packages: PRODUCT_CAPABILITY_PACKAGES,
        }, { cwd: info.cwd, lifecycle: info.lifecycle })
        await applySessionMaterialization({
          cwd: info.cwd,
          guguHome: resolveGuguHome(process.env),
          materialization: sessionCapabilities,
        })
        await writeCapabilityLoadReport(
          { kind: 'sessionpage', sessionId: info.sessionId },
          sessionCapabilities.report,
          process.env,
        )
        return {
          mcpServers: sessionCapabilities.sessionNewPatch?.mcpServers ?? [],
          spawnEnv: sessionCapabilities.spawnEnv,
          spawnArgs: sessionCapabilities.extraArgs,
          sessionMeta: sessionCapabilities.sessionNewPatch?.meta,
          ...(sessionCapabilities.sessionPrompt
            ? {
                sessionPrompt: {
                  value: sessionCapabilities.sessionPrompt,
                  carrier: sessionCapabilities.sessionPromptCarrier ?? 'system',
                } satisfies SessionPromptDelivery,
              }
            : {}),
        }
      }
      let startupQueue: Array<{ text: string; origin: 'communication' | 'manual' }> | undefined
      let provisionedChatId = provisioned.chatId
      if (info.initialMessageId && !info.startupOrigin) {
        throw new Error(`startup first turn for ${info.sessionId} requires an explicit creation surface`)
      }
      // @@@5004 首句只随首次 spawn 的载荷来(spec delivery-routing)。`startupOrigin`/`initialMessageId`
      // 是创建那一刻的事实、随会话永久持久化;`initialMessageText` 才是这次 start 的载荷 —— 渲染端只在
      // 行上 sessionId 为空时(首次 spawn / restart)才把 initialQueue 递过来。会话页 store 重建后重新
      // 挂载(渲染进程重载、页签释放过宽限)、宿主唤醒冷会话,都是「再打开一条启动过的会话」:没有
      // 载荷,注入器就无事可做。此前这里对每一次 lifecycle=fresh 的 chat-page start 都索要 id+text,
      // 于是聊天页照常回复、会话页却报 requires initial message id and text —— 把一条活着的会话读成
      // 打不开。与 PTY 腿(local-session.ts 的 chatPageFirstTurn)同一判据:有载荷才落首句。
      // 这一腿上两种不一致仍响亮失败:载荷在而稳定 id 缺(没有 id 就写不出那条幂等的聊天行);
      // 行上 sessionId 为空(首次 spawn / 重来)却没带载荷 —— 那是载荷没跟上会话行,❌ 不许静默开一条
      // 空会话冒充首轮(重来路径的载荷失联本身归 session-resume 那条票,这里只保证它响亮)。
      // gugu-dev#181:派出去的任务(taskChatId)与对话页同形 —— 首句是一条真的咕咕消息(那张任务卡)。
      const chatPageFirstTurnText = (info.startupOrigin === 'chat-page' || info.taskChatId) && info.lifecycle === 'fresh'
        ? info.initialMessageText?.trim()
        : undefined
      // ⚠️ 闸的条件是「**承诺过**一份首句载荷却没交出来」,不是「来自聊天页」。承诺的凭据是
      // `initialMessageId`:创建面只在这一轮真的把首句交给 spawn 时才铸它(#5049)。少了这一格,
      // 任何**没有** startup 载荷的聊天页创建都会被这道闸打死 —— 纯附件的一轮(附件行是普通 DM 行,
      // 由读者在会话 live 后投递),以及 provider 没声明启动通道、首轮本就走普通私聊消息的那一格。
      // 它们都不欠注入器任何东西,而 `startupOrigin` 只是「这条会话由哪一面创建」的事实(#5004),
      // ❌ 不是一张欠条。
      if (
        !chatPageFirstTurnText
        && info.startupOrigin === 'chat-page'
        && info.initialMessageId
        && info.lifecycle === 'fresh'
        && info.providerSessionId === null
      ) {
        throw new Error(
          `chat-page first spawn for ${info.sessionId} reached the injector without its first-turn payload `
          + '(the session row has no provider session yet, but the start carried no initialQueue text)',
        )
      }
      if (chatPageFirstTurnText) {
        if (!info.initialMessageId) {
          throw new Error(
            `chat-page first turn for ${info.sessionId} carries text but no stable message id`,
          )
        }
        const delivered = await landChatPageFirstTurn({
          sessionId: info.sessionId,
          guguAgentUserId: provisioned.guguAgentUserId,
          knownChatId: provisionedChatId,
          messageId: info.initialMessageId,
          text: chatPageFirstTurnText,
          taskChatId: info.taskChatId,
          projectId: info.projectId,
        })
        provisionedChatId = delivered.chatId
        startupQueue = [{ text: delivered.firstTurn, origin: delivered.envelope ? 'communication' : 'manual' }]
      }
      // #5323 能力注入这一段过去是个黑盒(真机实测 1.5 s,是 gugu 侧最大的一块)。逐步计时,
      // 才判得出哪一步真的必须挡在用户前面。
      const injectStartedAt = Date.now()
      const injectMarks: Array<[string, number]> = []
      const injectMark = (name: string): void => { injectMarks.push([name, Date.now() - injectStartedAt]) }
      try {
        if (!authProvider) throw new Error('[sessionpage] MCP injector: runtime auth provider not ready')
        if (!primaryGuguMcpHost) throw new Error('[sessionpage] MCP injector: Gugu MCP host not ready')
        const runAction = (action: unknown, auth: RuntimeAuth, signal: AbortSignal) =>
          runLocalSessionAction(
            auth,
            { ...info, sessionId: persistedSessionId },
            action,
            signal,
          )
        // 这一家的模型由**它自己的物化器**投递 —— 进程配置(旧)或它自己的配置文件(kimi)。
        // 两种都在这一层解析平台额度,再由下面的 `platformConfigured` 让信封注入器整个跳过:
        // 一维两条路时赢的是环境变量那条,而它带不动模型的能力声明(`support_efforts`)。
        const ownsProcessConfig = providerUsesSessionProcessConfig(info.providerId)
        const modelViaConfigFile = providerDeliversModelViaConfigFile(info.providerId, 'acp')
        // 启动提速 —— 这三样(平台模型额度、用户配置的 MCP 清单、身份引导块)互不依赖,过去是串着
        // 各等一次;并行后关键路径只剩其中最慢的那一个。
        const inputMs: Record<string, number> = {}
        const timed = async <T>(name: string, work: Promise<T>): Promise<T> => {
          const at = Date.now()
          try { return await work } finally { inputMs[name] = Date.now() - at }
        }
        const assistantResourceOwner = (await getSessionpageAuth())?.userId ?? null
        const [processConfigPlatform, configuredMcp, identityBlock, assistantRole] = await Promise.all([
          // ⚠️ 走 hooks 的 `acpPlatformModel`,**❌ 不直接调 `platformModelForSession`**:
          //    后者开头就无条件「先撤旧、再签新」,而这一步跑在 worker 的幂等判断**之前** ——
          //    对一条适配器还活着的会话(刷新窗口就是),worker 什么都不会建立,这里却已经把它
          //    手里那张票撤了,之后每一轮 `Invalid token`(#5552)。「握着活令牌就沿用」那条纪律
          //    以前只写在信封注入器里,而这条路会 `platformConfigured: true` 把它整个跳过。
          timed('platform-model', (async () => ownsProcessConfig || modelViaConfigFile
            ? sessionpagePlatformHooks.acpPlatformModel(info)
            : null)()),
          timed('mcp-list', sessionBundleUserMcpFor(info.providerId, () => mcpService.listForAgent(info.providerId, info.cwd))),
          // #5323 刚铸出来的身份,persona 供给那一步已经带出来了 —— 本地拼块,不再走网络。
          timed('identity-block', buildAgentIdentityBootstrap(
            { authProvider, env: process.env },
            provisioned.guguAgentUserId,
            provisioned.agentIdentityFacts,
          )),
          timed('assistant-role', isPersonalAssistant({ authProvider, env: process.env }, provisioned.guguAgentUserId)),
        ])
        injectMark('platform-model+mcp-list+identity-block')
        const readAssistantResources = assistantRole ? async () => {
          if (!assistantResourceOwner || (await getSessionpageAuth())?.userId !== assistantResourceOwner) throw new Error('Assistant resource owner changed')
          const { assistantLocalIndex } = await import('./sessionpage/assistant-local-index')
          const resources = await assistantLocalIndex(info.cwd, SERVER_MODE ? 'cloud' : 'computer', undefined,
            () => emdash.assistantPanelLocal.integrationIndex())
          if ((await getSessionpageAuth())?.userId !== assistantResourceOwner) throw new Error('Assistant resource owner changed')
          return resources
        } : undefined
        const projectContextBlock = buildSessionpageProjectContextBlock(provisioned.projectContext)
        const bundle = await buildSessionBundle({
          runtime: { authProvider, env: process.env },
          agentUserId: provisioned.guguAgentUserId,
          sessionKey: info.sessionId,
          ...(assistantRole ? { extensionTools: 'catalog' as const } : {}),
          // spec `mcp-session-toggle`:用户为这条会话关掉的那几台。
          // ⚠️ 原样递,`[]` 也递 —— 归一成 undefined 会让「决定过但一台没关」
          //    与「从没碰过」同形,而这条会话的适配器独占正是按前者判的。
          mcpDisabled: info.mcpDisabledServers,
          // 权限档 —— 这条腿此前**一格都没递**,于是每一个把 `units.autonomy` 声明成 native 的家
          // (opencode / mimocode / qwen / copilot / grok)在 session-ACP 上都恒定物化成 degraded:
          // 声明是真的、物化器也写好了,**只是永远没人喂**。spec agent-runtime 的「持久权限意图由
          // session runtime 落地」要求这份意图随每次 ACP start input 到达,而 ACP 自报 mode 那条路
          // 盖不住的家由这一维兜(见 emdash-mcp-injector 上 `permissionMode` 的字段说明)。
          // `runtime-process/host.ts` 早就为此把档位解析在调注入器**之前**完成并递了进来,
          // 它那段注释逐字写着这一格不递就会「变成一条永远不被喂的死代码」—— 这里补上那根线。
          // ⚠️ 解析式与运行时 `applyConfiguredPermissionMode` 同源(都从 permissionMode 来),
          //    ❌ 别在这里另写一套映射:两条路对同一个用户选择解释出不同档 = 界面与实际不一致。
          autonomy: info.permissionMode
            ? {
                mode: autoApproveFromPermissionMode(info.permissionMode)
                  ? ('full-access' as const)
                  : ('approval-required' as const),
                ...(info.permissionMode ? { permissionMode: info.permissionMode } : {}),
              }
            : null,
          promptBlocks: { platform: `${GUGU_PLATFORM_BLOCK}${projectContextBlock}`, identity: identityBlock },
          ...(processConfigPlatform
            ? {
                additionalEnv: {
                  ...processConfigPlatform.env,
                  ...processConfigPlatform.spawnEnv,
                  ...configuredMcp.env,
                },
              }
            : (Object.keys(configuredMcp.env).length > 0
              ? { additionalEnv: configuredMcp.env }
              : {})),
          additionalMcpServers: configuredMcp.servers,
          // 模型声明只交给「模型走自己配置文件」的那些家(判据与理由都在这个函数里)——
          // 它们的宿主侧注入已经闭嘴,这份声明是模型唯一的来路。
          model: sessionBundleModelFor(info.providerId, 'acp', processConfigPlatform),
          socialBridgeDeps: {
            host: primaryGuguMcpHost,
            resolveFile: desktopFiles.resolve,
            publishFile: (chat, file, actor, message, next) => desktopFiles.publish(chat, file, null, actor, undefined, { message, next }),
            grantKey: sessionpageSurfaceKey(info.sessionId),
            ...(assistantRole ? { personalAssistant: true as const, assistantWork: {
              ...assistantWorkBinding(persistedSessionId, info.cwd, SERVER_MODE ? 'cloud' : 'computer', provisioned.guguAgentUserId),
              currentInput: () => emdashBridge?.readCurrentActivityInput(persistedSessionId) ?? Promise.resolve(undefined),
            } } : {}),
            ...(readAssistantResources ? { readAssistantResources } : {}),
            runHostAction: runAction,
            runSessionAction: runAction,
            // @@@2374 不带 auth:写文件与装扩展都不代表用户去调任何云端接口。桥没
            // 加载成功时这条腿就不接,gugu_session 的 app_* 动作于是在调用时报错 ——
            // ❌ 不给一个看起来能用却调不通的动作。
            ...(emdashBridge
              ? { runExtensionAction: extensionActionsFor(info.sessionId) }
              : {}),
          },
        })
        injectMark('session-bundle-built')
        const loaded = loadSessionAcpCapabilities(info.providerId, bundle, {
          cwd: info.cwd,
          lifecycle: info.lifecycle,
        })
        const panelStatePath = assistantRole && assistantResourceOwner ? await assistantPanel.bind({
          sessionId: persistedSessionId,assistantId: provisioned.guguAgentUserId,ownerId: assistantResourceOwner,cwd: info.cwd,
        }) : undefined
        const capabilities = assistantRole && info.providerId === 'claude' ? await preparePersonalAssistantContext(
          loaded, info.cwd, resolveGuguHome(process.env), SERVER_MODE ? 'cloud' : 'computer', {
            accountId: async () => {
              const owner = (await getSessionpageAuth())?.userId
              return owner && owner === assistantResourceOwner ? owner : null
            },
            localSources: readAssistantResources,panelStatePath,
            run: async (action, signal) => {
              const auth = await getSessionpageAuth()
              if (!auth) throw new Error('Assistant startup index: owner not authenticated')
              return runAction(action, auth, signal)
            },
          },
        ) : info.providerId === 'claude' && !SERVER_MODE
          ? assistantHomeTaskContext(loaded, info.cwd, resolveGuguHome(process.env)) : loaded
        injectMark('capabilities-loaded')
        await applySessionMaterialization({
          cwd: info.cwd,
          guguHome: bundle.env.GUGU_HOME ?? '',
          materialization: capabilities,
        })
        injectMark('materialized')
        await writeCapabilityLoadReport(
          { kind: 'sessionpage', sessionId: info.sessionId },
          capabilities.report,
          process.env,
        )
        injectMark('load-report-written')
        createLogger('sessionpage/acp-start').info(
          {
            sessionId: info.sessionId,
            providerId: info.providerId,
            totalMs: Date.now() - injectStartedAt,
            inputMs,
            steps: Object.fromEntries(injectMarks),
          },
          'capability injection steps',
        )
        const mapped = capabilities.sessionNewPatch?.mcpServers ?? []
        console.log(`[sessionpage] injected the gugu MCP into session-page conv ${info.sessionId} (agent ${provisioned.guguAgentUserId}, chat ${provisionedChatId}) via ${capabilities.report.adapterId} session adapter`)
        return {
          mcpServers: mapped,
          extensionDelivery: sessionExtensionDelivery(bundle),
          ...(startupQueue ? { initialQueue: startupQueue } : {}),
          spawnEnv: capabilities.spawnEnv,
          spawnArgs: capabilities.extraArgs,
          sessionMeta: capabilities.sessionNewPatch?.meta,
          ...(capabilities.sessionPrompt
            ? {
                sessionPrompt: {
                  value: capabilities.sessionPrompt,
                  carrier: capabilities.sessionPromptCarrier ?? 'system',
                } satisfies SessionPromptDelivery,
              }
            : {}),
          platformConfigured: Boolean(
            processConfigPlatform && Object.keys(processConfigPlatform.env).length > 0
          ),
          // 重开后由 runtime 按它把模型断言一次(#6196):钉在进程配置里的模型,pi 恢复会话时不认。
          ...(processConfigPlatform?.model && Object.keys(processConfigPlatform.env).length > 0
            ? { platformModel: processConfigPlatform.model }
            : {}),
          ...(processConfigPlatform?.accessSessionId
            ? { platformAccessSessionId: processConfigPlatform.accessSessionId }
            : {}),
        }
      } catch (err) {
        console.error(`[sessionpage] MCP injector FAILED for session-page conv ${info.sessionId} (agent ${provisioned.guguAgentUserId}): ${(err as Error).message}`)
        throw err
      }
    })
    // @@@4972 会话发现工具的「咕咕提供的模型」—— 装进去的**就是** composer 那条 IPC(上面
    // SESSIONPAGE_PLATFORM_CATALOG_CHANNEL 的 handler)调的同一个函数。一个函数两个调用方,
    // 于是「agent 用 session_list_models 查到的」与「用户在下拉里看到的」不可能分岔。
    // ❌ 别在这里另加过滤或另算一份可用性:那就是第二份判据,它一定会漂。
    emdash.setPlatformModelCatalogResolver((query) => sessionpagePlatformHooks.listModels(query))

    // @@@2503 平台额度注入器(Chat UI / ACP 侧)—— pty 钩子的孪生。结构刻意与它一致:先按契约判这一格
    // 能不能注入,再决定复用还是重签。Claude 走会话 `_meta`;Codex/OpenCode 走会话私有适配器的 spawn env。
    emdash.setEmdashPlatformInjector((info) => sessionpagePlatformHooks.acpInjector(info))
    // @@@2503 会话结束 / ACP 运行时消失 → 结清令牌并删掉那份带令牌的 0600 settings 文档。
    // conversationId 为 null = 运行时整个没了,把 Chat UI 这一批全结清(终端会话那批的进程还活着,
    // 一起撤会把它们打成每轮 401)。
    emdash.setEmdashPlatformRelease((sessionId, expectedAccessSessionId, intent) =>
      sessionpagePlatformHooks.release(sessionId, expectedAccessSessionId, intent))
    emdash.setEmdashPlatformCheckpoint((sessionId) => sessionpagePlatformHooks.checkpoint(sessionId))
    // Sidecar-backed session-TUI legs (codex app-server, opencode serve) deliver over their own socket and
    // publish turn boundaries back through this one relay; the host never writes to the PTY for them.
    // 被打断的 stop 与等待边也走这一条;翻法只有 `relayTurnLifecycleEvent` 一处。
    const sessionpageProvisionDeps = {
      ...sessionpageIdentityDeps,
      onTurnLifecycle: (
        info: {
          sessionId: string
          providerId: string
          projectId?: string | null
        },
        edge: TurnLifecycleEdge,
      ) => {
        if (!info.projectId) {
          console.error(
            `[sessionpage] cannot relay ${info.providerId} turn lifecycle without a project id: ${info.sessionId}`,
          )
          return
        }
        emdash.emitSessionpageAgentEvent(relayTurnLifecycleEvent(
          edge,
          {
            sessionId: info.sessionId,
            providerId: info.providerId,
            projectId: info.projectId,
          },
          Date.now(),
        ))
      },
    }
    // Platform model quota applies to whatever session-page agent is starting, so it wraps the
    // provider-specific hook rather than being repeated inside each branch. A provider that
    // needs no divert still gets its argv back unchanged, plus the relay environment.
    const sessionTuiHostContext: SessionTuiHostContext = {
      provisionDeps: sessionpageProvisionDeps,
      runtime(what) {
        if (!authProvider) throw new Error(`${what}:runtime auth provider 未就绪`)
        return { authProvider, env: process.env }
      },
      mcpHost(what) {
        if (!primaryGuguMcpHost) throw new Error(`${what}:Gugu MCP host 未就绪`)
        return primaryGuguMcpHost
      },
      socialBridge(info, host) {
        const sessionContext = ptySessionCallerContext(info)
        const runAction = (action: unknown, auth: RuntimeAuth, signal: AbortSignal) =>
          runLocalSessionAction(auth, sessionContext, action, signal)
        return {
          host,
          grantKey: sessionpageSurfaceKey(info.sessionId),
          runHostAction: runAction,
          runSessionAction: runAction,
          // @@@2374 不带 auth:写文件与装扩展都不代表用户去调任何云端接口。桥没
          // 加载成功时这条腿就不接,gugu_session 的 app_* 动作于是在调用时报错 ——
          // ❌ 不给一个看起来能用却调不通的动作。
          ...(emdashBridge ? { runExtensionAction: extensionActionsFor(info.sessionId) } : {}),
        }
      },
      platformRecovery: () => sessionpagePlatformRecovery,
      recordFailedSessionDirectMessage(params, message, error) {
        const emdash = loadEmdashBridge()
        if (!emdash) throw new Error('opencode serve/attach: session-page bridge unavailable while surfacing first-turn failure')
        emdash.recordFailedSessionDirectMessage(params, message, error)
      },
    }
    if (process.env.GUGU_DEBUG_AUTONOMY === '1') {
      autonomyDebugLogger.warn({}, 'main PTY hook installed')
    }
    // 宿主的 hook 返回 CodexPtyOverride(env: NodeJS.ProcessEnv);会话页那侧要 Record<string, string>。
    // 在注册这一层规整一次(definedEnv),❌ 不去改会话页的类型迁就宿主。
    const sessionpagePtyHook = async (info: EmdashPtySessionpageStartInfo): Promise<CodexPtyOverride | null> => {
      if (process.env.GUGU_DEBUG_AUTONOMY === '1') {
        autonomyDebugLogger.warn({
          sessionId: info.sessionId,
          providerId: info.providerId,
          permissionMode: info.permissionMode,
          resumeProviderSessionId: info.resumeProviderSessionId,
          forkFromProviderSessionId: info.forkFromProviderSessionId,
        }, 'main PTY hook received')
      }
      // Reopen with a live app-server: that process keeps the token baked into its environment
      // at spawn. Issuing afresh here would first REVOKE that token under the live process —
      // every turn 401s from then on — while the replacement has no consumer. Reuse the held
      // launch; the provisioning below reuses the same app-server, and renewal keeps running
      // on the held record. (An electron restart empties both maps together, so a fresh spawn
      // with a fresh token is exactly what happens then.)
      //
      // 谁该复用、谁该重签,由引擎的注入契约说了算,不由这里认 provider 名字:令牌绑在哪个东西的
      // 存活上是引擎的进程拓扑决定的(codex 绑 app-server,claude TUI 绑可见进程本身)。表上没有
      // 这个引擎(插件引擎)→ 不复用,与从前一致。
      // 平台那一半与网页版无头宿主共用同一份实现(sessionpage-platform-hooks.ts):复用判定 + 解析。
      // 这里保留的是桌面壳**独有**的那一半 —— 与 provider hook(sidecar / 投递登记)的叠放。
      // #5331 这两发是并发的,不是排队的:平台令牌签发(云,实测 1.4–2.2 s)与 provider 供给
      // (身份 + 能力包物化 + sidecar,实测 1.9–3.3 s)之间没有依赖 —— 从前两段时长直接相加,
      // 全挡在用户面前。现在同时开跑,宿主段的耗时是两者的**最大值**而不是和。
      //
      // ⚠️ 先挂一个空 catch:provider 那一侧若在落地令牌之前就抛,这个 promise 会没人接
      //    (Node 把它算成 unhandledRejection,electron 里直接是一条崩溃日志)。真正的错误
      //    仍由下面的 await 抛出来,一次都不会被吞。
      const hookStartedAt = Date.now()
      const platformPromise = sessionpagePlatformHooks.ptyPlatform(info).then((it) => {
        platformMs = Date.now() - hookStartedAt
        return it
      })
      platformPromise.catch(() => undefined)
      let platformMs = 0
      const logHookLedger = (providerMs: number, reusedHeld: boolean): void => {
        createLogger('sessionpage/pty-start').info({
          sessionId: info.sessionId,
          providerId: info.providerId,
          reusedHeld,
          platformMs,
          providerMs,
          totalMs: Date.now() - hookStartedAt,
        }, 'pty sessionpage host steps')
      }
      const providerStartedAt = Date.now()
      const overridePromise = startSessionTuiHost(sessionTuiHostContext, info, platformPromise.then((it) => it.platform))
      overridePromise.catch(() => undefined)
      const [{ platform, reusedHeld }, override] = await Promise.all([platformPromise, overridePromise])
      logHookLedger(Date.now() - providerStartedAt, reusedHeld)
      if (reusedHeld) {
        const contract = findInjectionContract(info.providerId, 'tui')
        const clientArgs = contract && hasCredentialSink(contract, 'visibleClient', 'providerConfigArgs')
          ? platform.clientArgs
          : []
        return override ? {
          ...override,
          args: [...override.args, ...clientArgs],
          env: { ...platform.env, ...(override.env ?? {}) },
        } : override
      }
      if (!Object.keys(platform.env).length) return override
      if (override) {
        // The app-server already got the relay and token when its process was built inside the
        // hook. But the visible TUI runs codex's own login gate first — auth.json or a supported
        // auth env var — and a platform-quota user has neither, so without this env it lands on
        // the onboarding screen asking for an API key (owner hit this on the real rig). The TUI
        // only draws the UI; inference stays in the app-server, and OPENAI_BASE_URL keeps any
        // stray direct call on the relay where the token is single-model.
        const contract = findInjectionContract(info.providerId, 'tui')
        const clientArgs = contract && hasCredentialSink(contract, 'visibleClient', 'providerConfigArgs')
          ? platform.clientArgs
          : []
        return {
          ...override,
          args: [...override.args, ...clientArgs],
          env: { ...platform.env, ...(override.env ?? {}) },
        }
      }
      // The plain case: no divert, so the session is pinned by environment on its own argv.
      // A provider with no divert still gets its own argv back — the override contract requires
      // a command, and reconstructing one here would drift from the session backend's buildCommand.
      return {
        command: info.baseCommand,
        // 同样只追加(见 claude 分支的说明);非平台会话 clientArgs 为空 → argv 与从前一致。
        args: [...info.baseArgs, ...platform.clientArgs],
        env: { ...platform.env, ...platform.spawnEnv },
      }
    }
    emdash.setEmdashPtySessionpageHook(async (info) => {
      const override = await sessionpagePtyHook(info)
      return override ? { ...override, env: override.env ? definedEnv(override.env) : undefined } : null
    })
    // #4653 —— PTY 腿上的注入器边界:对话页「新建 Agent」的首句在 pty 起来**之前**先落成一条真的
    // 咕咕消息,再把同一份 route=chat 信封交回去塞进这一家自己的启动槽(argv/stdin)。
    //
    // 与 ACP 腿共用 `landChatPageFirstTurn`,所以「首句怎么变成一条消息」两条腿只有一条链。
    // 这里多出来的只有身份供给:ACP 腿的注入器本来就拿着 `provisioned`,PTY 腿的 sessionpage hook 要
    // 等到 buildCommand 之后才跑,而信封必须在 buildCommand **之前**就位 —— 所以在这里自己解析一次。
    // `provisionSessionpageAgentForSession` 幂等,稍后 hook 里那次会拿到同一个身份;私聊 id 也已由
    // `openOwnerDirectChatForAgent` 写回 roster 缓存,于是那次物化能力包时读到的就是这条 DM。
    emdash.setEmdashPtyChatStartupEnvelope(async (request) => {
      const provisioned = await provisionSessionpageAgentForSession(
        {
          sessionId: request.sessionId,
          providerId: request.providerId,
          surface: 'tui',
          cwd: request.cwd,
          projectId: request.projectId,
          // spec agent-provisioning:显式命名过就用那个名字开户(与 pty hook 同一口径)。
          displayName: request.agentDisplayName,
        },
        sessionpageProvisionDeps,
      )
      if (!provisioned?.guguAgentUserId) {
        throw new Error(
          `[sessionpage] chat-page first turn: no gugu identity for ${request.sessionId}`,
        )
      }
      const delivered = await landChatPageFirstTurn({
        sessionId: request.sessionId,
        guguAgentUserId: provisioned.guguAgentUserId,
        knownChatId: provisioned.chatId,
        messageId: request.messageId,
        text: request.text,
        taskChatId: request.taskChatId,
        projectId: request.projectId,
      })
      return delivered.firstTurn
    })
    // Dispose host-owned native inference transports whenever stopSession tears down the PTY.
    // A controlled platform restart uses this same boundary: the replacement must not reuse an
    // OpenCode serve that still carries the retiring process-config/token. detachSession does not
    // call this hook, so ordinary detach/hydrate keeps the existing serve/session reuse contract.
    emdash.setEmdashPtySessionpageTeardown(async (sessionId) => {
      // Do not revoke sender debt here: stopSession can reopen the same durable conversation/identity.
      // Revocation is permanent and belongs to the archive/delete reaper that removes that identity.
      await runSessionpagePtyTeardownSteps({
        stopTransport: async () => {
          await teardownSessionpageSessionRuntimes(sessionId)
        },
        // Settle and revoke any platform token this session held; leaving it alive would keep
        // billing a session that no longer exists.
        settlePlatform: () => {
          // The PTY exit callback can run outside the AsyncLocalStorage scope that marks a
          // controlled platform restart. Carry the retiring generation explicitly so that a
          // restart release cannot be mistaken for final session end and forget the recovery
          // target before the replacement owner is admitted.
          const expectedAccessSessionId = platformCredentialGenerationForSession(sessionId) ?? undefined
          return sessionpagePlatformHooks.release(
            sessionId,
            expectedAccessSessionId,
            emdashPlatformReleaseIntent(sessionId, expectedAccessSessionId),
          )
        },
        // claude 会话结束也要摘登记:否则下次投递会打给一个已经不存在的会话,报的还是 claude 的错、
        // 指不到「会话没了」这个成因。摘掉后投递会响亮地说「没有投递登记」。
        restoreCompatibilityOwner: () => {
          demoteSessionpageDeliveryOwnerFromRegistration((replaceAfterRelease) => {
            claudeSessionDelivery.teardown(sessionId, replaceAfterRelease)
          }, 'claude')
        },
      })
    })
    // TEST-ONLY, env-gated (GUGU_SESSION_TEST_HOOKS=1) — expose the session backend's control-channel entries + the
    // registry binding on the MAIN-process globalThis so a session-page fusion e2e can drive a
    // one-way inject and seed the addressing map through Playwright's app.evaluate (which runs in main).
    // Unset in production → NOT assigned → no product surface / no runtime probe. Exercises the REAL
    // injectEmdashPromptDetached + registry (only the caller is the test, not gugu's own agent.deliver).
    if (process.env.GUGU_SESSION_TEST_HOOKS === '1') {
      const testHooksTarget = globalThis as unknown as { __guguEmdashTestHooks?: unknown }
      testHooksTarget.__guguEmdashTestHooks = {
        readAgentInboxBatchAudit: () => readAgentInboxBatchAuditForTest(),
        injectEmdashPromptDetached: (sessionId: string, text: string, opts?: { steerIfBusy?: boolean }) =>
          emdash.injectEmdashPromptDetached(sessionId, text, opts),
        exportEmdashRawAcpLog: (sessionId: string) =>
          emdash.exportEmdashRawAcpLog(sessionId),
        emdashSessionSummaries: () => emdash.emdashSessionSummaries(),
        // otty e2e — deliver a real AgentEvent into the real pipeline (see embedded-boot).
        // 测试钩子转发的是不透明的 IPC 输入,形状由 e2e 自己保证(env-gated,生产不暴露)。
        emitSessionpageAgentEventForTest: (event: unknown) => emdash.emitSessionpageAgentEventForTest(event as AgentEvent),
        registerEmdashAgent: (reg: { guguAgentUserId: string; sessionId: string }) =>
          emdashAgentRegistry.registerEmdashAgent(reg),
        unregisterEmdashAgent: (guguAgentUserId: string) =>
          emdashAgentRegistry.unregister(guguAgentUserId),
        // #3816 — only the built black-box harness may fault the selected sessionpage cell. The actual
        // sendMessage/local-session path remains untouched; this changes only the main-process resolver.
        setSessionpageIntegrationOverride: (input: {
          providerId: string
          surface: 'acp' | 'tui'
          identity?: 'addressable' | 'none'
          messageTransport?: 'router' | 'local-session' | 'none'
        }) => setSessionpageSessionIntegrationOverrideForTest(input),
        clearSessionpageIntegrationOverrides: () => clearSessionpageSessionIntegrationOverridesForTest(),
        localSessionInjectionAudit: () => readLocalSessionInjectionAuditForTest(),
        clearLocalSessionInjectionAudit: () => clearLocalSessionInjectionAuditForTest(),
        localSessionDeliveryFailures: () => readLocalSessionDeliveryFailuresForTest(),
        clearLocalSessionDeliveryFailures: () => clearLocalSessionDeliveryFailuresForTest(),
        // Test-only read surface for black-box session-TUI delivery diagnostics. This deliberately exposes
        // only the selected identity/conversation mapping; production has no global probe.
        localSessionDeliveryOwner: (input: { agentUserId: string; sessionId?: string }) => ({
          liveSessionId: localSessionDeliveryTarget.liveSessionIdByAgent(input.agentUserId),
          deliveryKeyForSession: input.sessionId
            ? localSessionDeliveryTarget.deliveryKeyForSession?.(input.sessionId) ?? null
            : null,
          emdashBindings: emdashAgentRegistry.listBindingsForTest()
            .filter((binding) => binding.guguAgentUserId === input.agentUserId)
            .map((binding) => ({ sessionId: binding.sessionId })),
          opencodeServeAttachBinding: (() => {
            const sessionId = opencodeServeAttachSessionDelivery.liveSessionIdByAgent(input.agentUserId)
            return sessionId
              ? {
                  sessionId,
                  deliveryKeyForSession: opencodeServeAttachSessionDelivery.deliveryKeyForSession?.(sessionId) ?? null,
                }
              : null
          })(),
        }),
        // Write a local roster record (GUGU_HOME/agents) so a service-role-created agent's real
        // agent.deliver passes the dispatcher's findLocalAgentByGuguUserId gate and reaches the
        // session-page bridge without dispatching an on-device agent.create command. Test-only.
        createLocalAgentRecord: (rec: { gugu_user_id: string; name: string; agent_type: string; path: string }) =>
          createAgent(
            { name: rec.name, agent_type: rec.agent_type, path: rec.path, gugu_user_id: rec.gugu_user_id, prompt: '' },
            process.env,
          ),
        // Invoke the real session-page bridge directly so the negative beat can deterministically assert
        // fail-loud behavior for an agent with no live local session-page runtime.
        injectViaWrappedBridge: async (input: { agentUserId: string; text: string }) => {
          const bridge = createDeviceSessionpageBridge()
          if (!bridge.injectAgentInbox) throw new Error('session-page bridge has no injection entry')
          return bridge.injectAgentInbox({ agentUserId: input.agentUserId, text: input.text })
        },
      }
    }
    const emdashBoot = emdash.bootEmdashModule(ipcMain, {
      scheduleDiscovery: (work) => startupDiscovery.schedule(work),
    })
    void emdashBoot.then(() => {
      emdash.onAgentStatus(change => {
        if (change.reading?.status !== 'working') void assistantPanel.publish(change.sessionId).catch(() => {
          createLogger('assistant-panel').warn({},'Panel state publication will retry at the next host activity')
        })
      })
    }).catch(() => undefined)
    // 认回重启前留在 tmux 里的平台会话(#7120):它读 tmux 名与平台票账本,两样都是 boot 里段 2 迁移改的
    // (task-to-session 改 tmux 名、session-naming 改账本键)—— 先读就把旧名下活着的会话判死、删掉它的取票文件。
    // 所以与下面的开机重注册一样排在 boot 之后。只读本机、不等登录;boot 失败也照样跑,终端腿与启动结清都在等它落定。
    void emdashBoot.catch(() => undefined)
      .then(() => restorePlatformRelaySessions({ authProvider: desktopAuthProvider(), liveSessions: liveTmuxSessionIds }))
      .catch((error: unknown) => createLogger('stable-endpoint').error({ err: error }, '认回重启前的平台会话失败'))
    // 开机重注册读名册,而名册的键名是 boot 里那段名字迁移改的(embedded-boot.ts runSessionNamingOnce):
    // 先读就读到旧键,一条也登记不上,冷会话从此唤不醒。所以和下面的收残一样排在 boot 之后。
    // 路由等的就是这份 promise(waitUntilReady),它在 boot 开始的这一刻就换上,boot 期间的投递等着,
    // ❌ 掉到原生引擎去 spawn。
    // #4277/#5025 重注册**不等**归属:真问一次归属要等渲染进程就绪(真机实测约 2.7s),让路由多等那 2.7s
    // 不值。所以先按老行为全注册,再在归属定下来之后把别家的行摘掉(见下)。
    sessionpageAgentRehydration = emdashBoot.then(() =>
      registerExistingSessionpageAgents(process.env, { ownerUserId: null })
        .then((n) => {
          if (n > 0) console.log(`[sessionpage] re-registered ${n} persisted session-page agent binding(s)`)
        })
        .catch((err) => {
          console.warn(`[sessionpage] session-page agent re-registration failed: ${(err as Error).message}`)
          throw err
        }),
    )
    startSessionpageAgentRehydration(sessionpageAgentRehydration)
    void sessionpageAgentRehydration.catch(() => undefined)
    // 补偿:归属一确定就把明确属于别的账号的行摘掉。不挂在路由的关键路径上。
    void sessionpageAgentRehydration
      .then(() => bootOwnerWithin(60_000))
      .then((ownerUserId) => (ownerUserId ? unregisterForeignSessionpageAgents(process.env, ownerUserId) : 0))
      .then((released) => {
        if (released > 0)
          createLogger('sessionpage/boot').info(
            { foreignRows: released },
            '#5025 归属已确定,已确认别家账号的行不占本机投递路由',
          )
      })
      .catch((err) => {
        createLogger('sessionpage/boot').warn(
          { err: (err as Error).message },
          '#5025 摘除其他账号的任务页绑定失败(下次开机重试)',
        )
      })
    // S2b:没有本机投递 sweep 了 —— 聊天消息的耐久层在云端(消息本体+游标)。
    // 触发④(开机扫):persisted owner 重注册完成后,对本机 roster 逐 agent 读游标差,兜住离线期与 realtime 掉线。
    void sessionpageAgentRehydration
      .then(async () => {
        const { listAgents } = await import('@gugu/core/local/state/agents')
        const { agentsForOwner } = await import('@gugu/core/local/state/agentOwner')
        // #4277 只扫当前账号(与老行)的 agent —— 别家的行这个账号拉不到,只会扫出一行 400。
        const roster = agentsForOwner(await listAgents(process.env), await bootOwnerWithin(60_000))
        for (const agent of roster) {
          if (agent.gugu_user_id) kickInboxForAgent(agent.gugu_user_id, 'boot-scan')
        }
      })
      .catch((err) => createLogger('agent-inbox').warn({ err: (err as Error).message }, 'boot scan skipped'))
    await emdashBoot.then(
      // @@@2302 正向信号:产物启动冒烟(scripts/appimage-boot-smoke.sh)靠这一行断言「会话页
      // 后端活着」——只有失败日志的系统无法被冒烟断言。文案改动须同步冒烟脚本的 grep。
      async () => {
        console.log('[sessionpage] boot OK — session page backend serving')
        // 重注册在这里先做完,再起下面的一切(渲染层、生命周期恢复、收残):离线登记会摘掉同一 agent 的 live 登记
        // (local-session-delivery.ts registerOfflineInLocalMap),得赶在任何会话转 live 之前。失败照旧不拦启动。
        await sessionpageAgentRehydration.catch(() => undefined)
        // server 没有渲染层替它打开项目:先打开,再开始收发(否则重启后第一条消息 `Project … not found`)。
        if (SERVER_MODE) await emdash.openAllEmdashProjects()
        // #6264 桌面与 server 都是别的电脑的会话宿主(behavior gugu-server.md 第 8 条),见 handleShellChannel。
        emdash.setDeviceSessionHostShellHandlers(
          (channel) => remoteShellHandlers.get(channel) as ((...args: unknown[]) => unknown) | undefined,
        )
        // #6264 账号进程的本机套接字:SSH 装上的这台机器与桌面之间的整条设备连接(`gugu-server link`,见
        // server/device-link-host.ts)与 open-url(这台机器上的程序「打开网页」)都走它。开不出来,这台机器对桌面就是断的:
        // 响亮记一笔、不挡启动(聊天与云端通道照旧)。
        if (SERVER_MODE) {
          const link = createDeviceLinkHost({
            userId: () => process.env.GUGU_SERVER_ACCOUNT ?? null,
            createHandlers: () => createPrimaryDeviceRpcHandlers(),
            warn: (message) => createLogger('server/link').warn({}, message),
            // #7199 心跳随行报「隧道最近一次有流量」(会话页宿主的心跳不算):云电脑的管家据此判闲置。
            onActivity: () => noteTunnelActivity(),
          })
          await emdash.startSessionPtyAttachServer(app.getPath('userData'), { link,
            timeZone: context => applyOwnerTimeZoneContext(context), resume: since => {
            if (since !== undefined) recordDeviceSleep({ since, until: Date.now(), source: 'fc-confirmed' })
            resumeAccountMessaging('controller')
          } }).then(
            (server) => createLogger('server').info({ socket: server.socketPath }, '账号进程套接字已开(设备连接 link 与 open-url 走它)'),
            (err: unknown) => createLogger('server').error({ err }, '账号进程套接字开不出来 —— 设备连接(link)与 open-url 不可用'),
          )
          const stopResumeGapWatch = watchHostResumeGap(resumeAccountMessaging)
          app.once('will-quit', stopResumeGapWatch)
          // 远程隧道:别的电脑经中转连到这里的终端 / 浏览器 / 端口(不挡启动,失败原因留给 tunnel.open 答)。
          void startServerTunnelEndpoint()
        }
        // #6264 桌面:会话页打开 SSH 装上的机器上的「编程」会话时,问这里怎么连。
        if (sshMachineStore) {
          emdash.setDirectTerminalResolver(createDirectTerminalResolver({
            store: sshMachineStore,
            currentUserId: async () => {
              const auth = await desktopAuthProvider().getAuth().catch(() => null)
              return auth?.userId ?? null
            },
            // 开不出 askpass 时 ssh 退回在终端里自己问;记一笔,不挡终端。
            onAskpassError: (err: unknown) => createLogger('server').warn({ err }, '直连终端的 askpass 开不出来 —— ssh 会在终端里自己问密码'),
            // #6264「下次免密」:密码登上之后替人装咕咕的钥匙(钥匙在咕咕数据目录里,❌ 碰 ~/.ssh)。
            installKey: createMachineKeyInstaller({
              store: sshMachineStore,
              keyDir: guguKeyDir(app.getPath('userData')),
              log: (message, detail) => createLogger('server').info(detail ?? {}, message),
            }),
            // 远程隧道连通了的机器:浏览器 / 端口的转发骑在它那条共享连接上。
            ...(tunnelMachines ? { tunnels: tunnelMachines } : {}),
          }))
        }
        // #6387 扩展服务就绪之后才处理链接 —— 之前到的都在排队。
        flushPendingGuguLinks()
        // #6387 扩展服务就绪之后,会话开场才读得到扩展带来的 MCP 程序与 skill;程序经扩展网关给会话(#6615)。
        const onProblem = (message: string) => createLogger('extension-session').error({ message }, 'extension contribution left out of the session')
        const programHost = { nodeExecutable: process.execPath, toolsRuntime: toolsRuntimePath(), linkPrefix: `${GUGU_LINK_SCHEME}://ext`, onProblem }
        // 桌面是会话页的页签,server 是云浏览器(emdashAgentBrowser 在 server 上就是 cloudAgentBrowserBridge);装了 Browser Use 两边一样走 App。
        emdash.emdashExtensionPrograms().registerNative('browser-use', createBrowserAppProgram(() => emdash.emdashAgentBrowser()))
        if (!SERVER_MODE) {
          // #7317 Computer Use 的「电脑」页签:看的是 agent 经设备动作做的每一步电脑控制;App 的程序只给它的页面 preview_state。
          const programs = emdash.emdashExtensionPrograms()
          const computerUseApps = installedComputerUseApps(programs, emdash.emdashOnInstalledAppsChanged)
          computerUsePreviewInstance = createComputerUsePreview({
            nativeCursor: process.platform === 'darwin',
            peek: (target, options) => deviceActionsRuntime().peekWindow(target, options),
            programs: computerUseApps,
            notify: (program, method) => emdash.emdashNotifyFromNativeProgram(program, { method }),
            showIn: (program, target) => emdash.emdashOpenTaskPagesOfApp(target, program.extensionId),
          })
          programs.registerNative('computer-use', computerUsePreviewInstance.program)
          // Computer Use is the switch of this computer's computer control: installed and on = it has it. Each change
          // re-registers this computer's actions at once (other machines' agents read them), stops cua-driver when off,
          // and forgets what the 「电脑」 pages recorded (an App installed later never sees what came before).
          computerUseOn = () => computerUseApps().length > 0
          let computerUseWas = false
          const computerUseSwitched = () => {
            const on = computerUseOn()
            if (on === computerUseWas) return
            computerUseWas = on
            if (!on) computerUsePreviewInstance?.forget()
            deviceActionsRuntime().switchChanged()
          }
          emdash.emdashOnInstalledAppsChanged(computerUseSwitched)
          // Until now this computer had no computer control. The installed programs are known only once their source is
          // set just below: look then, and if Computer Use is on, say so.
          setImmediate(computerUseSwitched)
        }
        // The programs installed now, read at every call by the catalog, the gateway and the extension's own pages (#6635):
        // the very descriptors sessions get, and those of extensions that may not give tools too — every reader asks
        // agentToolsRefusal first. A broken skill was already reported when the session opened; only programs here.
        emdash.emdashExtensionPrograms().setSource(() =>
          extensionAgentPrograms(emdash.emdashExtensionAgentContributions(), { ...programHost, onProblem: () => {} }).programs)
        const extensionCatalog = createExtensionCatalog({
          programs: () => emdash.emdashExtensionPrograms(),
          onProblem,
          sessionContext: extensionCallerSessionContext,
          // A broken skill was reported when the session opened (extensionAgentPrograms below); the catalog only leaves it out.
          skills: () => extensionAgentPrograms(emdash.emdashExtensionAgentContributions(), { ...programHost, onProblem: () => {} }).skills,
          apps: () => emdash.emdashExtensionAgentContributions().map(({ manifest, enabled }) => ({
            manifest, enabled, givesAgents: givesAgentTools(manifest),
          })),
          market: () => cloudExtensionMarket().entries(),
        })
        setSessionExtensionCatalog({
          tools: (grantKey, agentUserId, name) => extensionCatalog.tools(grantKey, sessionpageSessionOfGrantKey(grantKey) ?? undefined, agentUserId, name),
          apps: (grantKey, withMarket) => extensionCatalog.apps(grantKey, withMarket),
          skills: (grantKey) => extensionCatalog.skills(grantKey),
        })
        setSessionExtensionBridge(async (session) => {
          // D-30 (主人 10-06「肯定是能选的啊」): an App's tools and skills reach this agent only where its owner gave them — this
          // computer's places (every agent unless the person chose), or a chat the agent is in. Read whenever asked (编号 4,
          // 10-12): a place given while this session runs counts from its next call; waited for here only when a skill or the
          // opening's App lines must be decided (the catalog and the native cards wait for it themselves, #5331).
          const provider = authProvider
          const readScope = () => (provider
            ? appScopeOf(session.subjectId, () => requireRuntimeAuth(provider, 'App scope'))
            : Promise.resolve<ReadonlySet<string>>(new Set())
          ).catch((error: unknown) => {
            onProblem(`Apps given at chats left out this time: ${(error as Error).message}`)
            return new Set<string>()
          })
          let contributions = emdash.emdashExtensionAgentContributions()
            .filter((contribution) => !emdash.emdashExtensionPrograms().agentToolsRefusal(contribution.extensionId))
            // Do not change the person's App settings or grants. Only this
            // assistant's opening uses the existing progressive-disclosure path.
            .map((contribution) => session.extensionTools === 'catalog'
              ? { ...contribution, disclosure: 'progressive' as const }
              : contribution)
          const inScope = (extensionId: string) => {
            const given = emdash.emdashAppGiven(extensionId)
            return inAppScope(given.here, given.app, readScope)
          }
          setSessionAppScope(session.grantKey, inScope)
          // Skills go into the session now or never: when there are any, the scope is waited for.
          if (contributions.some((contribution) => contribution.skillsDir)) {
            const kept = await Promise.all(contributions.map((contribution) => inScope(contribution.extensionId)))
            contributions = contributions.filter((_, index) => kept[index])
          }
          const { programs: installed, skills } = extensionAgentPrograms(contributions, programHost)
          // D-10:开场只给「完全披露」的扩展开网关卡,其余经 catalog_*。
          const full = new Set(contributions.filter((c) => c.disclosure === 'full').map((c) => c.extensionId))
          const programs = installed.filter((program) => full.has(program.extensionId))
          // 上下文工程第二批 P3 (D-27, owner 10-07 chose (c)): the opening names the Apps whose tools this session reaches
          // through the catalog — now or never, like a skill, so their scope is waited for too.
          const catalogApps = catalogAppsOf(contributions, installed)
          const appsKept = await Promise.all(catalogApps.map((app) => inScope(app.extensionId)))
          // Computer Use is this computer's, not a place's (#7317).
          const apps = catalogApps.filter((app, index) => app.computerUse || appsKept[index])
          // 网关起不来只让扩展工具缺席,❌ 把会话拖死 —— 会话永远要能开。
          const gateway = programs.length === 0 || !authProvider
            ? { servers: [], origins: [] }
            : await requireRuntimeAuth(authProvider, 'extension gateway')
              .then(({ userId }) => buildExtensionGateway(getExtensionGatewayHost(), { ...session, ownerUserId: userId }, programs, onProblem))
              .catch((error: unknown) => {
                onProblem(`extension gateway left out of the session: ${(error as Error).message}`)
                return { servers: [], origins: [] }
              })
          extensionCatalog.listedNatively(session.grantKey, gateway.origins.map((origin) => origin.extensionId))
          return { ...gateway, skills, apps }
        })
        // 资源库 → MCP:这条任务带上的那几台,经能力包送进去。包建好以后连同留在外面的(让给这一家自己的、
        // 这条腿收不到的、和咕咕自己的撞了的、资源库里已删的)记成这一次的事实,任务的 `/mcp` 面板读它。
        setSessionLibraryMcpBridge(async (sessionId) => {
          const picked = await emdash.emdashLibraryMcpForSession(sessionId)
          const servers = picked.servers.map((server) => ({
            name: server.name,
            transport: server.transport,
            ...(server.command ? { command: server.command } : {}),
            ...(server.args ? { args: server.args } : {}),
            ...(server.env ? { env: server.env } : {}),
            ...(server.cwd ? { cwd: server.cwd } : {}),
            ...(server.url ? { url: server.url } : {}),
            ...(server.headers ? { headers: server.headers } : {}),
            providers: [],
          }))
          return {
            servers,
            settle: ({ delivered, collided }) => {
              const leftOut = [...picked.leftOut, ...collided.map((item) => ({ name: item.name, reason: 'collides' as const, with: item.with }))]
              if (leftOut.length > 0) createLogger('library-mcp').info({ sessionId, leftOut }, 'library MCP left out of the session')
              void emdash.emdashRecordLibraryMcp(sessionId, { delivered, leftOut }).catch((error: unknown) =>
                createLogger('library-mcp').warn({ sessionId, error: String(error) }, 'could not record the library MCP delivery'))
            },
          }
        })
        // 订阅必须在 boot 之后:会话页后端主进程图被打成一个 esbuild 包,过早订阅会读到还没初始化的单例并抛
        // unhandledRejection —— 会话页后端直接起不来(e2e 的 launchApp 阶段现形,dev 的 vite 产物顺序
        // 不同所以只在生产打包里暴露)。
        emdash.onEmdashSessionpageReapTrigger(runSessionpageReap)
        // #113 这台机器的项目记到账号上(桌面与 server 同一份):现在记一次,之后一变就再记。订阅同上要在 boot 之后。
        deviceProjectsPublisher ??= createDeviceProjectsPublisher({
          getAuth: () => desktopAuthProvider().getAuth(),
          deviceId: () => localDeviceId(),
          client: (accessToken) => makeIdentityClient(accessToken) as unknown as DeviceProjectsRpcClient,
          records: () => emdash.listDeviceProjectRecords(),
          warn: (message, fields) => createLogger('device-projects').warn(fields, message),
        })
        try {
          emdash.onDeviceProjectsMaybeChanged(() => deviceProjectsPublisher?.notify())
        } catch (error) {
          createLogger('device-projects').error({ err: error }, '订不上项目变化:账号上这台机器的项目只在开机与登录时更新')
        }
        deviceProjectsPublisher.notify()
        // #4008 —— 把会话页会话的 agent 状态接成咕咕侧的运行事实:「它在不在干活」是**读**会话页的状态,
        // 不再从「有没有一条投递命令正在执行」反推 —— 用户在会话页自己敲的回合、agent 之间的接力、以及
        // 一注入就返回的 transport,在咕咕的单聊/列表/群里都如实显示运行中。
        // 与上面同一条纪律,而且还多一条:启动快照要读会话页后端的库,而 boot 之前那张表既没初始化、
        // 也还没跑 agentStatusWriter.settleAfterRestart —— 太早读会把上一个进程留下的 working 行当成现在时。
        agentStatusFeed.attach(
          {
            onAgentStatus: (cb) => emdash.onAgentStatus(cb),
            agentStatusSnapshot: () => emdash.agentStatusSnapshot(),
            onSessionsGone: (cb) => emdash.onSessionsGone(cb),
          },
          { env: process.env, warn: (message) => sessionpageActivityLogger.warn(message) },
        )
        // Deletion-sync boot pass (spec ⑨) — ONLY here: it reads the session backend's DB, which the boot above is
        // what initializes, so running it any earlier races an uninitialized database.
        runSessionpageReap('boot')
        // 删身份、读「项目 → 群」映射都要账号令牌,而开机那一刻归属未定、令牌
        // 拿不到(#5025):归属定下来之后再对一轮。令牌在归属定下与 session 真正恢复之间还有一小段空窗,
        // 所以有界地等它到位;等不到就喊出来,留给下一次触发。不在任何关键路径上。
        void bootOwnerWithin(60_000)
          .then(async (ownerUserId) => {
            if (!ownerUserId) return
            const deadline = Date.now() + 60_000
            while (Date.now() < deadline) {
              const auth = await getSessionpageAuth()
              if (auth) {
                // #6396 各前缀用到几号在这里就先取回来:它是一次云往返(实测 0.40 s),
                // 而它问的是账号级的事实,和「哪条会话」无关 ⇒ 不该挂在用户按下回车之后。
                if (auth.accessToken && auth.userId) {
                  refreshAgentNamingFacts({ accessToken: auth.accessToken, userId: auth.userId })
                }
                runSessionpageReap('boot-owner')
                return
              }
              await new Promise((resolve) => setTimeout(resolve, 500))
            }
            createLogger('sessionpage/reap').warn(
              { ownerUserId },
              'owner decided but no access token within 60s — the owner-scoped reap is left to the next trigger',
            )
          })
          .catch((err) =>
            createLogger('sessionpage/reap').warn({ err: (err as Error).message }, '#4277 boot-owner reap pass skipped'),
          )
      },
      (err) => {
        console.error('[sessionpage] boot failed — session page backend unavailable:', err)
        fatalSessionpageBoot(err)
      },
    )
  }
  if (!SERVER_MODE) loadMainWindowContents()
  startDeviceRuntimeWhenRendererReady()
  // server 的升级另有一套(后台下好、没有 agent 在跑时切换),❌ 走桌面这套弹界面的更新器。
  if (!SERVER_MODE) {
    purgeUpdaterCacheOnce()
    startAutoUpdateChecks()
  }

  // @@@2503 同一条理由的孪生:上一轮被硬杀的进程会把带中转令牌的 `--settings` 覆盖文件留在 tmpdir。
  // 令牌本身有硬过期(续期靠活着的进程驱动),但 0600 挡不住同一账号下的其它程序,没有理由留到自然过期。
  // fire-and-forget、不阻塞启动;只收「写它的那个 pid 已经不在」的文件,不误删同机另一个实例正在用的。
  void sweepStalePlatformSettingsFiles()
    .catch((err) => { console.error('[sessionpage] stale settings sweep failed:', err) })

  // Tray
  // @@@tray-icon-blank — 图标按 app 根解析(`app.getAppPath()`:开发态=仓库根,打包=Resources/app),
  // ❌ 别再按 `__dirname/../build-resources` 拼:main.js 在 apps/desktop/dist-electron/ 下,那条路指向不存在的
  // apps/desktop/build-resources/,于是 nativeImage 静默给空图 → 所有 mac 用户的菜单栏挂着一个透明空槽(owner 实机圈出)。
  // 空图直接抛,别再静默。资源规格见 scripts/gen-tray-icons.py:mac 模板图 16 + @2x 32(文件名以 Template
  // 结尾,系统按亮/暗/毛玻璃自己着色);Windows ICO / Linux PNG 各出黑白两套,按系统深浅色换。
  if (SERVER_MODE) {
    createLogger('server').info({ userData: app.getPath('userData'), signedInAs: serverAuth?.signedInUserId() ?? null }, '咕咕 server 已启动')
    // 忙闲写给守护进程(server-supervisor.ts、server-account-converge.ts):有会话或集成授权会被换版打断时才等空闲。
    // tmux 里的终端会话不随账号进程重启断,不拦换版(busyForVersionSwitch)。
    const activityFile = join(app.getPath('userData'), 'activity.json')
    // #6264 同一份读数也是升级看门狗判「新版本站稳了没有」的依据(server-upgrade-guard.ts):带上自己的版本与起始时刻。
    const activityStartedAt = Date.now()
    const reportActivity = (): void => {
      const busy = loadEmdashBridge()?.sessionpageBusyForVersionSwitch?.() ?? false
      try {
        writeFileSync(activityFile, JSON.stringify({
          busy,
          at: Date.now(),
          version: process.env.GUGU_TASK_HOST_VERSION ?? null,
          pid: process.pid,
          startedAt: activityStartedAt,
        }))
      } catch (error) {
        createLogger('server').warn({ err: error }, '忙闲写不进去')
      }
    }
    loadEmdashBridge()?.onSessionpageAuthorizationActivityChange?.(reportActivity)
    reportActivity()
    setInterval(reportActivity, 10_000).unref()
    return
  }
  tray = new Tray(loadTrayIcon())
  refreshTrayChrome()
  applyUnreadBadge()
  // mac 上装了 contextMenu 之后左键就是弹菜单,这个 click 只对 Windows / Linux 生效(左键直接把窗口拉起来)。
  tray.on('click', () => {
    focusMainWindow()
  })
  nativeTheme.on('updated', () => {
    // @@@5295 换深浅色要重画的是**带角标的**那张图,直接 loadTrayIcon() 会把角标抹掉。
    if (tray && process.platform !== 'darwin') applyUnreadBadge()
  })

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow()
    } else {
      focusMainWindow()
    }
  })
}).catch((error) => {
  // @@@3890⑦ 启动链的终结兜底。少了它,这段两百多步的 async 启动里**任何**一次 throw 都只换来
  // 全局 unhandledRejection 的一行日志,进程却继续活着:窗口没建、托盘没建、activate 没挂,
  // 单实例锁还占着 —— 用户看到「双击图标没反应」,连重开都没用。
  // 分两种:界面还没开始加载 = 没有可挽救的东西,收掉引擎组、非零退出,把单实例锁交出去,下一次启动才可能
  // 自然可用;界面已经在了 = 别把用户正在用的界面炸掉,只响亮记账。
  // ❌ 不按「有没有窗口」判:那个隐藏的空主窗口也算一个窗口,按它判就留下看不见的活死人(#6295)。
  createLogger('main').error({ err: error }, '启动链失败')
  if (!mainWindowContentsRequested) {
    killEnginesOnCrash('startup-failure')
    process.exit(1) // fail loud:非零退出 + 释放单实例锁,❌ 不留活死人进程
  }
})

// 窗口全关只发生在退出路径上(关窗被上面的 close 收进托盘),退出由 before-quit 编排;
// 挂着这个空监听是为了压掉 Electron「窗口全关即 app.quit()」的默认行为。
app.on('window-all-closed', () => {})
