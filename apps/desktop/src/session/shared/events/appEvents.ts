import type { AgentInstallProgress } from '@gugu/session-core/workspace-server';
import type { SessionPaneTab, SessionPaneTabsResult } from '@gugu/session-core/session-record/contract';
import type { AgentInstallationStatus } from '@shared/core/agents/agent-payload';
import { defineEvent } from '@shared/lib/ipc/events';
import type { ShortcutSettingsKey, TabNavigationDirection } from '@shared/shortcuts';

// App editing actions (renderer → main, no payload)
export const appUndoChannel = defineEvent<void>('app:undo');
export const appRedoChannel = defineEvent<void>('app:redo');
export const appPasteChannel = defineEvent<void>('app:paste');

export type TerminalContextMenuAction = 'paste' | 'select-all' | 'clear';

export const terminalContextMenuActionChannel = defineEvent<{
  requestId: string;
  action: TerminalContextMenuAction;
}>('terminal-context-menu:action');

// Menu events (main → renderer, no payload)
export const menuOpenSettingsChannel = defineEvent<void>('menu:open-settings');
export const menuUndoChannel = defineEvent<void>('menu:undo');
export const menuRedoChannel = defineEvent<void>('menu:redo');
export const menuCloseTabChannel = defineEvent<void>('menu:close-tab');
export const menuQuitRequestedChannel = defineEvent<void>('menu:quit-requested');
export const menuGiveFeedbackChannel = defineEvent<void>('menu:give-feedback');

/** Emitted by main process when the window maximize state changes (Linux custom controls). */
export const windowMaximizeChangedChannel = defineEvent<{ maximized: boolean }>(
  'window:maximize-changed'
);

export const externalLinkOpenRequestedChannel = defineEvent<{ url: string }>(
  'external-link:open-requested'
);

export const tabNavigationShortcutChannel = defineEvent<{
  source: { kind: 'browser'; browserId: string };
  direction: TabNavigationDirection;
}>('tab-navigation:shortcut');

export const browserAppShortcutChannel = defineEvent<{
  source: { kind: 'browser'; browserId: string };
  shortcutKey: ShortcutSettingsKey;
}>('browser:app-shortcut');

export const notificationFocusSessionChannel = defineEvent<{
  projectId: string;
  sessionId: string;
}>('notification:focus-session');

/** Host-validated request to open a file without navigating away from the user's current surface. */
export const sessionOpenFileInPaneChannel = defineEvent<{
  requestId: string;
  projectId: string;
  sessionId: string;
  path: string;
  external: boolean;
  intent: 'preview' | 'pinned';
  /** 摩擦单 F122 The App to open it with (its tab, checked to claim the file): «open with X», not the resolver's pick. */
  tabKind?: string;
  /** 「用别的 App 打开」: everyone who opens it, the person picks (an App's `files.openWith(file, { ask: true })`). */
  ask?: boolean;
}>('session:open-file-in-pane');

/**
 * Renderer acknowledgement for a host-requested file tab.
 *
 * `openedWith` names the extension tab that took the file, or null for the built-in
 * editor. Which one opens a given type is decided in one place in the renderer — the
 * same place a click goes through — so the host reports that outcome instead of
 * predicting it.
 */
export const sessionOpenFileInPaneResultChannel = defineEvent<{
  requestId: string;
  success: boolean;
  error?: string;
  openedWith?: string | null;
  browserId?: string;
  tabs?: SessionPaneTab[];
}>('session:open-file-in-pane-result');

/** Host-validated request to open an HTTP(S) URL in the caller task's browser pane. */
export const sessionOpenBrowserInPaneChannel = defineEvent<{
  requestId: string;
  projectId: string;
  sessionId: string;
  url: string;
  intent: 'preview' | 'pinned';
  /** Browser Use resolves a persisted tab before restoring its page; ordinary open_in_tab still opens a URL. */
  acquire?: { browserId?: string; createIfMissing: boolean; deadline: number };
}>('session:open-browser-in-pane');

/** Renderer acknowledgement for a host-requested browser tab. */
export const sessionOpenBrowserInPaneResultChannel = defineEvent<{
  requestId: string;
  success: boolean;
  error?: string;
  browserId?: string;
  /** Browser Use 这一次新开了页签(会话原来一个浏览器页签都没有):宿主据此把它记成这条会话的产出。 */
  created?: boolean;
  tabs?: SessionPaneTab[];
}>('session:open-browser-in-pane-result');

/** Cancel a Browser Use acquisition that timed out or whose caller ended before the pane replied. */
export const sessionCancelBrowserAcquireChannel = defineEvent<{ requestId: string }>('session:cancel-browser-acquire');

export const sessionManageTabsChannel = defineEvent<{
  requestId: string; projectId: string; sessionId: string; tabId?: string;
}>('session:manage-tabs');

export const sessionManageTabsResultChannel = defineEvent<SessionPaneTabsResult & {
  requestId: string; success: boolean; error?: string;
}>('session:manage-tabs-result');

/**
 * #6264 预览要别的机器上的一块字节(`gugu-preview://` 的远端登记,见 preview-protocol.ts):
 * 主进程问渲染层,渲染层经 `workspace.files.readChunk`(按项目所在的机器路由)去那台机器取。
 */
export const remotePreviewReadChannel = defineEvent<{
  requestId: string;
  projectId: string;
  workspaceId: string;
  path: string;
  offset: number;
  length: number;
}>('session:remote-preview-read');

/** 渲染层取回来的那一块(base64,与读文件动词同形),或那台机器给的原因码。 */
export const remotePreviewReadResultChannel = defineEvent<{
  requestId: string;
  chunk?: { size: number; etag: string | null; data: string };
  errorCode?: string;
}>('session:remote-preview-read-result');

/**
 * Host-validated request to bring up a tab contributed by an installed extension.
 * `tabKind` is the runtime `<extension-id>.<tab-name>` string; the renderer opens it
 * through the pane layout, which is what takes a runtime kind.
 */
export const sessionOpenExtensionInPaneChannel = defineEvent<{
  requestId: string;
  projectId: string;
  sessionId: string;
  tabKind: string;
  intent: 'preview' | 'pinned';
  /**
   * #6387 The person asked for this from outside the session page — clicked an extension's
   * banner or a `gugu://ext/…` link. Bring the task on screen and reuse a tab of this kind
   * that is already open there, instead of stacking a new one per click.
   */
  reveal?: boolean;
  /** With `reveal`: the exact tab to bring forward when it is still open (a banner's own tab). */
  tabId?: string;
  /**
   * #7317 The host brings it up on its own (a task's first use of Computer Use): one already open anywhere in the task is
   * left where it is and as it is — ❌ moved beside the conversation again, ❌ brought forward.
   */
  ifAbsent?: boolean;
}>('session:open-extension-in-pane');

/** Renderer acknowledgement for a host-requested extension tab. */
export const sessionOpenExtensionInPaneResultChannel = defineEvent<{
  tabs?: SessionPaneTab[];
  requestId: string;
  success: boolean;
  error?: string;
}>('session:open-extension-in-pane-result');

export const ptyStartedChannel = defineEvent<{
  id: string;
}>('pty:started');

export type PlanEvent = {
  type: 'write_blocked' | 'remove_blocked';
  root: string;
  path: string;
  code?: string;
  message?: string;
};

export const planEventChannel = defineEvent<PlanEvent>('plan:event');

export const ptyDataChannel = defineEvent<string>('pty:data');

export const ptyExitChannel = defineEvent<{
  exitCode: number;
  signal?: number;
}>('pty:exit');

/** Emitted by main process when a PTY is definitively killed (e.g. on deleteTask/deleteConversation). */
export const ptyKilledChannel = defineEvent<{ id: string }>('pty:killed');

/** Emitted by main process when a lifecycle/dev-server shell session is created.
 *  These sessions are standalone PTYs — they are NOT backed by a DB conversation record.
 *  The renderer uses sessionId (not conversationId) to connect to the PTY terminal.
 */
export const shellSessionStartedChannel = defineEvent<{
  sessionId: string;
  /** Opaque UUID identifying this PTY session — not a DB conversationId. */
  ptySessionId: string;
  ptyId: string;
  title: string;
}>('shell:session-started');

/** Emitted when an agent installation status changes (probe, install, update, or selection change). */
export const agentInstallationStatusUpdatedChannel = defineEvent<AgentInstallationStatus>(
  'agent:installation-status-updated'
);

/**
 * 一次安装进行中的实时读数。
 *
 * 为什么另开一条通道而不是塞进上面那条：状态事件答的是「装没装、什么版本」，一次安装只发几次；
 * 进度是每秒一条的流，两者的频率和消费者都不同，混在一起会让状态缓存被高频事件反复作废。
 *
 * ❌ 下游不许拿 `bytesDone / bytesTotal` 以外的东西凑百分比：`bytesTotal` 缺席就是
 * 「这次量不出分母」，界面应当只显示已完成量与速度（product spec）。
 */
export const agentInstallProgressChannel = defineEvent<AgentInstallProgress>('agent:install-progress');
