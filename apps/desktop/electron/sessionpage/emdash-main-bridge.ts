// @@@sessionpage — gugu-side esbuild ENTRY for the session-page backend bundle. The session backend is a
// cohesive submodule (owner #43), not a set of gugu subsystems: its boot orchestration lives on its OWN
// side (apps/desktop/electron/session/main/embedded-boot.ts), which exposes exactly ONE entry
// `bootEmdashModule` (+ `disposeEmdashModule`). This file merely re-exports that module entry so the
// `gugu-bundle-emdash-taskpage` esbuild plugin (vite.config.mts) has a stable entry point to bundle
// → dist-electron/taskpage/emdash-main-bridge.cjs. The host (gugu main.ts) requires that .cjs and calls
// the ONE entry + bridges IPC — it never reaches into the session backend's DB / pty / services individually.
export { injectEmdashPromptDetached } from '../session/main/core/acp/inject-prompt'
export { recordConfirmedDeviceSleep } from '../session/main/core/activity/collector'
export {
  bootEmdashModule,
  setSessionAdmissionPreparation,
  assistantPanelLocal,
  readCurrentActivityInput,
  disposeEmdashModule,
  emdashRpcRouter,
  // @@@sessionpage TASKPAGE-FUSION — control-channel entries: the host injects a new ACP turn into a
  // live session-page conversation (inter-agent messaging in the 任务 tab) + reads live-session summaries for
  // a liveness pre-check. Both fail-loud; never a pty write.
  cancelEmdashTurn,
  ensureEmdashSession,
  reloadEmdashSession,
  applyEmdashSessionModelSelection,
  // #6396 宿主往活会话里递一件事(改名告知一行 + agent 下一轮开头的新身份)。
  announceEmdashSession,
  exportEmdashRawAcpLog,
  emdashSessionSummaries,
  emdashSessionpageSessionFacts,
  // @@@sessionpage TASKPAGE-FUSION — a project's display name, so the host can name the gugu group it
  // mirrors that project onto (spec ⑨「项目 = 群」) without deep-importing the session backend's projects/DB layer.
  emdashProjectName,
  emdashProjectRoot,
  emdashTakeBirthGroup,
  // 资源库 → MCP:这条任务带上的那几台(会话能力包的桥问它)。
  emdashLibraryMcpForSession,
  emdashRecordLibraryMcp,
  // #4277 日志按账号分文件:宿主在 owner 边界处叫它,会话页那份 gugu-task.log 跟着切。
  setSessionpageLogFileOwner,
  emdashSessionExists,
  // #7167 私聊头部模式按钮:这条会话现在以哪种展示开。
  emdashSessionView,
  emdashStopSession,
  emdashSessionProvisionInput,
  startSessionpageAgentSession,
  ensureSessionpageAgentInstalled,
  openAllEmdashProjects,
  disposeSessionpageAgentSession,
  // #7199 个人助理搬走:它在那条会话上排的已安排一并撤掉(retireSessionpageAgent 用;漏在这张清单外只会在真搬家时才炸)。
  removeSessionSchedules,
  type SessionpageAgentSessionProvisioner,
  type SessionpageAgentSessionStartInput,
  type SessionpageAgentSessionProvisioned,
  emdashOpenSessionFile,
  // @@@sessionpage TASKPAGE-FUSION — the live-conversation set + a "something may have been removed"
  // trigger, so the host can reconcile its contacts/groups projection and reap agents whose conversation
  // was archived or deleted (spec ⑨ 删除必同步 — 不能只同步增).
  emdashSessionpageInventory,
  onEmdashSessionpageReapTrigger,
  runSessionAction,
  // agent 的 session_* 跨机器(owner 2026-09-30):别的机器发来的动作、本机发起方的自述、「这个 id 在不在本机」。
  // 同 runEmdashExtensionAction 那条教训:漏在这张清单外只会在真有人跨机器时才炸。
  runRemoteSessionAction,
  sessionCallerFacts,
  localSessionIds,
  // 宿主的唤醒入口要读它:引擎进程在不在跑、归宿主还是 tmux(漏在这里只会在唤醒时才发现)。
  sessionProcess,
  setOtherMachines,
  // #7341 第二步 项目跨设备:`projects.*` 的项目群四件事由宿主实现(sessionpage-project-group-binding.ts),
  // 对照变了经 notify 让渲染层重读。漏在这张清单外只会在有人「并进来」时才炸。
  setProjectGroupHost,
  notifyProjectGroupBindingChanged,
  type ProjectGroupHost,
  // agent 的 session_* 跨机器:别的机器问 `agentSession.*` 时由宿主答;别的机器上的 App 发来的消息由这台的 App 发信答。
  setAgentSessionHost,
  answerAppMessage,
  spawnAgentForExtension,
  answerAppReadFile,
  answerAppCall,
  // @@@2374 —— `gugu_session` 的 app_* 动作分派。宿主(main.ts)按 `EmdashBridgeModule`
  // 调它,而那只是个 TS 类型:漏在这张清单外**不会**有任何编译期或加载期报错,直到 agent 真
  // 去建/装扩展,才在回合中间收到一句被压缩过的 `Jt.runEmdashExtensionAction is not a
  // function`。#3873 把动作接进 main.ts 时没同步这里,于是打包版的 app_* 从那天起就
  // 全是坏的(dev 上实证)。
  runEmdashExtensionAction,
  // #6387 系统交给咕咕的 gugu://ext/… 链接。同上一条教训:漏在这里只会在有人点链接时才发现。
  openEmdashLink,
  // #6387 每条会话开场时读:已启用扩展带来的 MCP 程序与 skill。
  emdashExtensionAgentContributions,
  // #6615 扩展网关经它调 main 托管的扩展程序。
  emdashExtensionPrograms,
  // D-30 每条会话开场时读:一个 App 在这台电脑上给了哪些地方,和它在库里的身份。
  emdashAppGiven,
  // F14 少了它,app_check 在哪儿都不列 —— 而症状只是「agent 从来不自检」。
  emdashExtensionCheckAvailable,
  // 少了它,guide_read apps-ui 只有字没有图 —— agent 写之前看不到咕咕的样子长什么样。
  emdashLookPicture,
  // @@@sessionpage TASKPAGE-FUSION otty-state — subscribe to the consolidated agent-attention count
  // (agents blocked on the human) so the host can badge the 任务 sidebar tab.
  onEmdashAttentionChanged,
  // #4008 —— 会话页会话的 agent 状态(working/…)是「这个 agent 在不在干活」的事实源;宿主读它、发布成
  // 权威 activity,咕咕的单聊/会话列表/群于是显示同一件事,而不再各自从投递命令的执行区间反推。
  onAgentStatus,
  agentStatusSnapshot,
  onSessionsGone,
  // TEST-ONLY (host exposes env-gated) — feed a real AgentEvent into the real pipeline for the otty e2e.
  emitSessionpageAgentEventForTest,
  emitSessionpageAgentEvent,
  emitSessionpageAgentFailure,
  // @@@sessionpage TASKPAGE-FUSION — register a gugu-built MCP injector so session-page codex sessions get
  // the gugu MCP send tool + gugu identity at session start (enables the target agent to reply).
  // @@@5301 会话页 agent 通知正文的注入口(见 notification-copy.ts)。
  setSessionAgentNotificationCopy,
  // 宿主的界面语言的注入口(见 host-locale.ts)。
  setSessionHostLocale,
  setEmdashMcpInjector,
  // @@@2503 平台额度:给走咕咕模型的 Chat UI(ACP)会话按会话签发中转令牌并随 `_meta` 送进适配器。
  setEmdashPlatformInjector,
  setPlatformRecoveryReadyGate,
  setEmdashPlatformCheckpoint,
  setEmdashPlatformRelease,
  withEmdashPlatformSessionRestart,
  // 模型目录第二遍探测的占位凭据注入口(实现在宿主的 harness-catalog-probe-env.ts)。
  setProbePlatformEnvResolver,
  // @@@4972 会话发现工具的「咕咕提供的模型」读取口 —— 宿主装的就是 composer 那条 IPC 调的
  // 同一个 sessionpagePlatformCatalog,于是 agent 查到的和用户看到的是同一次计算。
  setPlatformModelCatalogResolver,
  // @@@sessionpage TASKPAGE-FUSION — register the PTY-divert hook + teardown so a session-page codex TUI
  // conversation runs as `codex --remote … resume <tid>` against a gugu-started app-server (native TUI +
  // socket delivery, same session); teardown disposes that app-server when the conversation truly ends.
  setEmdashPtySessionpageHook,
  setEmdashPtySessionpageTeardown,
  // #4653 —— 对话页「新建 Agent」首轮的 route=chat 信封解析口。宿主不装它,一条声明了启动通道
  // 的 PTY 会话在对话页首轮就会 fail loud(❌ 不退回裸文本、更 ❌ 不退回 pty 打字)。
  setEmdashPtyChatStartupEnvelope,
  setSessionMessageRouter,
  // 手机看管 agent 的设备 RPC 处理器。经桥拿 ⇒ 与 router / conversation provider 同一份实例;
  // 宿主直接 import 会打出第二份,写侧的运行时状态就都看不见了。
  createSessionpageSessionDeviceRpcHandlers,
  // 随心跳上云的会话状态摘要:机器离线后手机只剩它可读。同上,经桥拿。
  sessionpageSessionDigest,
  // server 换版看的忙闲(activity.json)。同上,经桥拿。
  sessionpageBusyForVersionSwitch,
  setSessionLiveNotifier,
  listPendingSessionDirectMessages,
  acceptPendingSessionDirectMessage,
  recordFailedSessionDirectMessage,
  // 会话可用那一刻要排一次 outbox：收件箱 pull 的本机投影只捞 session-direct 行，
  // 用户打的第一句是 ordinary，只有 drain 能送出去（codex 的 90s 死锁即出在这一格）。
  drainSessionMessageOutboxById,
  setLocalSessionDeliveryBridge,
  type LocalSessionDeliveryBridge,
  // @@@sessionpage 导入本机会话 (spec session-page-import) — 把 gugu 侧的本机 transcript 扫描/解析
  // 注入给会话页；不注入时会话页的导入入口自动隐藏。
  setEmdashLocalSessionSource,
  type LocalSessionSource,
  // @@@2374 — 宿主把自己的 renderer 通道交给扩展 relay。❌ 别让会话页这侧相对 import
  // `electron/ipc-bridge`:那样只会把它复制进本 bundle,复制品的窗口永不被赋值,
  // 于是 setTabTitle / setTabBadge / openBrowserTab / reportError / compose
  // 五个动词一律「Renderer not ready」(实机实证)。
  setExtensionHostWindowChannel,
  setUserLibraryOwner,
  setLoginShellPathRehydrator,
  setLoginShellEnvProvider,
  setPlatformCredentialsProbe,
  type ExtensionHostWindowChannel,
  type EmdashRpcRouter,
  type SessionAction,
  type SessionCallerContext
} from '@main/embedded-boot'
// @@@2374 — <webview> 准入策略。单独导出是为了让宿主在**加载到本模块时**就能装上,
// 不必等 bootEmdashModule 成功(它可失败,失败后宿主继续跑)。注册幂等。
export { registerWebviewAttachPolicy } from '@main/app/webview-policy'
// #6615 问题 11 扩展网关给程序盖的调用方上下文(任务、工作副本),每次调用现读。
export { agentSessionContext as emdashAgentSessionContext } from '@main/core/extensions/extension-agent-context'
// #7191 会话的 agent 操作它会话页里的浏览器页签:宿主的 MCP 层(Playwright 工具)经它拿到连那个页签的 transport。
export { agentBrowserBridge as emdashAgentBrowser } from '@main/core/browser/agent-browser'
// @@@touchid-passkey 网页要选通行密钥时,对话框挂在那张网页此刻所在、看得见的咕咕窗口上(停放着 / 窗口收起 ⇒ 无)。
export { visibleHostOfPage as emdashVisibleHostOfPage } from '@main/core/browser/browser-page-views'
// #7317 Computer Use 的「电脑」页签:宿主告诉 App 的页面「有新的一步」,任务第一次用电脑时把那一页开到任务里。
export { notifyFromNativeProgram as emdashNotifyFromNativeProgram } from '@main/core/extensions/extension-programs'
export { openTaskPagesOfApp as emdashOpenTaskPagesOfApp } from '@main/core/sessions/session-orchestration'
// #7317 Computer Use 是电脑控制的开关:App 装上 / 卸掉 / 启用 / 停用,这台电脑的电脑控制当场跟着变。
export { onInstalledAppsChanged as emdashOnInstalledAppsChanged } from '@main/core/extensions/extension-bridge'
// #6264「别的机器上的编程只给用 SSH 装上的机器」:
//  · server 模式:账号进程开本机套接字,设备连接(`gugu-server link`)与 open-url 经它到账号进程;
//  · 桌面:宿主注入「这台机器怎么直连」(SSH 一步装好时记下的映射),会话页据此开直连终端。
export { startSessionPtyAttachServer } from '@main/core/pty/attach/start-attach-server'
export { broadcastDeviceSessionHostEvent, setDeviceSessionHostShellHandlers } from '@main/host-ws/device-session-host'
export { setDirectTerminalResolver, type DirectTerminalResolver } from '@main/core/pty/direct-terminal/controller'
// #113 这台机器的项目记到账号上:那一份,与「它可能变了」的信号(订阅在 boot 之后,同 onEmdashSessionpageReapTrigger)。
export { listDeviceProjectRecords, onDeviceProjectsMaybeChanged } from '@main/core/projects/operations/device-project-records'
