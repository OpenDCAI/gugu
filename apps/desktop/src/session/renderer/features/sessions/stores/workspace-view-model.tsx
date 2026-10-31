import { translateSessionMessage } from '@renderer/localization/locale-store';
import { toast } from '@renderer/lib/hooks/use-toast';
import { messageForUser } from '@/lib/userFacingError';
import type { ILifecycle } from '@gugu/session-shared';
import { computed, makeAutoObservable, observable, reaction, runInAction } from 'mobx';
import { DefaultSessionSeeder } from '@renderer/features/sessions/default-session-seeder';
import { startAppPlacementSync } from '@renderer/features/extensions/app-placement-sync';
import {
  clearExtensionAppStateSource,
  setExtensionAppStateSource,
} from '@renderer/features/extensions/app-state-reporter';
import { browserControlsRegistry } from '@renderer/features/browser/browser-controls-registry';
import type { BrowserTabResource } from '@renderer/features/browser/browser-tab-resource';
import type { SessionTabContext } from '@renderer/features/tabs/core/session-tab-context';
import { getDiffTabManager } from '@renderer/features/sessions/diff-view/stores/diff-tab-manager';
import { DiffViewStore } from '@renderer/features/sessions/diff-view/stores/diff-view-store';
import { EditorViewStore } from '@renderer/features/sessions/editor/stores/editor-view-store';
import type { FileTabResource } from '@renderer/features/sessions/editor/stores/file-tab-resource';
import { PreviewServerStore } from '@renderer/features/sessions/stores/preview-server-store';
import { TerminalTabViewStore } from '@renderer/features/sessions/terminals/terminal-tab-view-store';
import { type SidebarTab } from '@renderer/features/sessions/types';
import { sessionPageOnScreen } from '@renderer/app/sessions-on-screen';
import { appState } from '@renderer/lib/stores/app-state';
import { onMachineEvent } from '@renderer/lib/ipc';
import { machineRegistry } from '@renderer/lib/machine-routing';
import { snapshotRegistry } from '@renderer/lib/stores/snapshot-registry';
import { log } from '@renderer/utils/logger';
import {
  sessionChangedChannel,
} from '@shared/core/sessions/sessionEvents';
import { sessionTabKind } from '@renderer/features/sessions/session-tab-kind';
import { sessionRegistry } from '@renderer/features/sessions/stores/session-registry';
import { closeTabsOfSession, findChatPaneId, findConversationAnchor } from '../view/session-pane-policy';
import type { OpenedOutput } from '@gugu/session-chat-ui/opened-outputs';
import type { TerminalShellId } from '@shared/core/terminals/terminal-settings';
import { browserAddressKey } from '@shared/browser';
import type {
  DiffViewSnapshot,
  SessionViewSnapshot,
  TerminalDrawerActiveItem,
} from '@shared/view-state';
import { sessionTabView } from '../session-tab-registry';
import { PrStore } from './pr-store';
import type { SessionPageStore } from './session-store';
import { terminalRegistry } from './terminal-registry';
import { resolveWorkspacePath } from './workspace-path';
import { workspaceRegistry } from './workspace-registry';
import { openFileInSessionEditor } from './open-file-in-file-editor';
import { workspaceReachLabel, type WorkspaceSurface, type WorkspaceSurfaceWorkspace } from '../workspace-backend/workspace-surface';

export type RendererKind =
  | 'monaco'
  | 'markdown'
  | 'diff'
  | 'agents'
  | 'browser'
  | 'terminal'
  | 'other-file';

export class WorkspaceViewModel implements ILifecycle, WorkspaceSurface {
  sidebarTab: SidebarTab;
  isSidebarCollapsed: boolean;
  focusedRegion: 'main' | 'bottom';
  isTerminalDrawerOpen: boolean;
  terminalDrawerActiveItem: TerminalDrawerActiveItem | undefined;
  /** Stable sub-stores — live for the full WorkspaceViewModel lifetime. */
  readonly paneLayout: ReturnType<typeof sessionTabView.createPaneLayoutStore>;
  readonly terminalTabs: TerminalTabViewStore;
  readonly editorView: EditorViewStore;

  /**
   * Returns the focused pane's PaneStore.
   * Callers outside the split-pane render tree use this to access tab state
   * without needing to know about multiple panes.
   */
  get activePane(): ReturnType<typeof sessionTabView.createPaneLayoutStore>['focusedPane'] {
    return this.paneLayout.focusedPane;
  }

  /**
   * Session-scoped: created in initialize() with live workspace git/pr references,
   * disposed and set to null in suspend().
   */
  diffView: DiffViewStore | null = null;
  prStore: PrStore | null = null;
  previewServers: PreviewServerStore | null = null;

  /** Permanent reactions (live as long as the view model). */
  private readonly _disposers: (() => void)[] = [];
  /** Session reactions (created in initialize, disposed in suspend). */
  private _sessionDisposers: (() => void)[] = [];

  private _snapshotDisposer: (() => void) | null = null;
  /** Saved whenever suspend() is called, restored in next initialize(). */
  private _savedDiffViewSnapshot: DiffViewSnapshot | undefined;
  private _isCreatingTerminal = false;

  private readonly _seeder: DefaultSessionSeeder;

  readonly sessionId: string;

  constructor(private readonly _sessionPageStore: SessionPageStore) {
    const sessionData = _sessionPageStore.data;
    this.sessionId = sessionData.id;

    // UI state defaults — overridden by restoreSnapshot when called
    this.sidebarTab = 'files';
    this.isSidebarCollapsed = true;
    this.focusedRegion = 'main';
    this.isTerminalDrawerOpen = false;
    this.terminalDrawerActiveItem = undefined;

    const workspaceId = sessionData.workspaceId ?? sessionData.id;
    const projectId = sessionData.projectId;

    const sessionCtx: SessionTabContext = {
      viewId: this.sessionId,
      place: { kind: 'session', sessionId: this.sessionId, projectId },
      projectId,
      workspaceId,
      sessionId: this.sessionId,
      get workspacePath(): string | undefined {
        return workspaceRegistry.get(projectId, workspaceId)?.path;
      },
      modelRootPath: `workspace:${workspaceId}`,
    };
    this.paneLayout = sessionTabView.createPaneLayoutStore(sessionCtx, {
      // 一条会话一条页签条:分屏只有并排一种(spec session-page「并排」)。
      singleStrip: true,
      onActiveTabChange: (tabId) => {
        if (!tabId) return;
        appState.history.push({
          kind: 'tab',
          projectId: sessionData.projectId,
          sessionId: this.sessionId,
          tabId,
        });
      },
    });
    // agent 打开的、从对话里点开的开在这条会话自己的对话右边(spec session-page「并排」)。
    this.paneLayout.setPairAnchor(() => findConversationAnchor(this.paneLayout, this.sessionId));
    this._seeder = new DefaultSessionSeeder(this.sessionId, this.paneLayout);
    this.terminalTabs = new TerminalTabViewStore(() => terminalRegistry.get(this.sessionId) ?? null);
    this.editorView = new EditorViewStore(this.paneLayout, sessionData.projectId, workspaceId);

    makeAutoObservable(this, {
      paneLayout: false,
      terminalTabs: false,
      editorView: false,
      diffView: observable.ref,
      activeRenderer: computed,
    });

    // Tell the engine whether this task is visible so panes can
    // fire onActivate() correctly when the view becomes visible.
    // 「可见」= 它在屏上 **且** 它已 provisioned:没挂好时主栏画的是「正在准备」,页签根本不在屏上(main-panel 只在
    // ready 时渲染页签)。只看路由时,一条从没打开过、被闲置回收过的会话一点开,聊天页签就在重新 provision 之前
    // 被激活,开场读不到工作区 ⇒「The engine could not start: No workspace found for session」。
    // 「在屏上」不只是路由那一条(#7052 一屏几块):摆在某一块里(会话页正显示着)、开在单独的窗里,都看得见。
    // 只认路由时,重启后没被选中的那块一直是空的,点它一下对话才出来(owner 2026-10-09 实机截图)。
    // 「在屏上」只在 app/sessions-on-screen.ts 一处定义,这里问的是「它的页在不在屏上」。
    const routed = () =>
      appState.navigation.currentViewId === 'session' &&
      (appState.navigation.viewParamsStore['session'] as { sessionId?: string } | undefined)?.sessionId === this.sessionId;
    this._disposers.push(
      reaction(
        () => _sessionPageStore.state === 'provisioned' && sessionPageOnScreen(this.sessionId),
        (isActive) => this.paneLayout.setViewActive(isActive),
        { fireImmediately: true }
      )
    );
    // Extension surfaces are told what the app is showing (#4068) —— 正看着的那一条,不是屏上每一条。Routed
    // through a single registered source rather than「active 报自己、inactive 报空」—— see app-state-reporter's
    // header for the race that costs.
    this._disposers.push(
      reaction(
        () => _sessionPageStore.state === 'provisioned' && routed(),
        (isShown) => {
          if (isShown) setExtensionAppStateSource(this.sessionId, projectId, this.paneLayout);
          else clearExtensionAppStateSource(this.sessionId);
        },
        { fireImmediately: true }
      )
    );
    // A task view torn down while it was the one on screen must stop being the
    // source, or the app state would keep describing panes that are gone.
    this._disposers.push(() => clearExtensionAppStateSource(this.sessionId));

    // Archiving removes the task from the active list; retire its tabs through the same local cleanup.
    this._disposers.push(
      onMachineEvent(machineRegistry.machineOf(projectId), sessionChangedChannel, ({ sessionId, projectId: eventProjectId, changes }) => {
        if (eventProjectId !== projectId || sessionId !== this.sessionId) return;
        if (!changes.archivedAt) return;
        this._retireSessionTabs(sessionId);
      })
    );
  }

  /**
   * Close every chat tab (pty conversation / acp-chat / side-chat fork) bound to a conversation that
   * just left the session list — **deleted or archived, one rule for both verbs** — in every pane.
   * When that emptied the chat column, move it to a session that still exists — the most recently used
   * remaining root — so the column never idles on nothing while the task still has work in it;
   * with no session left the empty state shows.
   */
  private _retireSessionTabs(sessionId: string): void {
    // One MobX batch: closing the last tab of a pane arms that pane's auto-close, and the session pane
    // policy would otherwise start shuffling tool tabs into the vacated chat pane before the successor
    // is opened. The successor goes back into the SAME pane that showed the deleted session — never
    // into whichever pane happens to have focus (a terminal pane, say).
    runInAction(() => {
      const { displayedInPaneId } = closeTabsOfSession(this.paneLayout, sessionId);
      if (!displayedInPaneId || findChatPaneId(this.paneLayout)) return;

      // Roots first, most recently used first. "Root" is judged against what is left, not against the
      // stored parent edge: the main process promotes the deleted conversation's children to roots with
      // a separate change event that lands AFTER the delete event, so at this moment they still carry
      // the dead parent id.
      const sessions = sessionRegistry.get(this.sessionId)?.sessions;
      const remaining = Array.from(sessions?.values() ?? []).filter(
        (c) => c.data.id !== sessionId
      );
      const isRoot = (c: (typeof remaining)[number]) => {
        const parent = c.data.parentSessionId;
        return !parent || parent === sessionId || !sessions?.has(parent);
      };
      const lastUsed = (c: (typeof remaining)[number]) =>
        c.data.lastInteractedAt ? new Date(c.data.lastInteractedAt).getTime() : 0;
      remaining.sort((a, b) => Number(isRoot(b)) - Number(isRoot(a)) || lastUsed(b) - lastUsed(a));
      const next = remaining[0];
      if (!next) return;
      this.paneLayout.open(
        sessionTabKind(next.data.runtime),
        { sessionId: next.data.id },
        { preview: false, target: { paneId: displayedInPaneId } }
      );
    });
  }

  get projectId(): string {
    return this._sessionPageStore.data.projectId;
  }

  get workspaceId(): string {
    return this._sessionPageStore.workspaceId ?? this.sessionId;
  }

  /** WorkspaceSurface:工作目录与 git(任务还没建好工作区时是 null)。 */
  get workspace(): WorkspaceSurfaceWorkspace | null {
    return this._workspace;
  }

  get previewServerUrls(): readonly string[] {
    return this.previewServers?.urls ?? [];
  }

  /** 会话在别的机器上、那台机器此刻够不着:说「离线,上次在线 X」;这台电脑上的永远够得着(null)。 */
  get unreachableLabel(): string | null {
    return workspaceReachLabel(this.projectId);
  }

  openFile(path: string, opts?: { beside?: boolean }): void {
    void openFileInSessionEditor(this.projectId, this.sessionId, path, opts);
  }

  /**
   * 文件走人点开文件的那条路(扩展认领、工作区外、已经删掉的提示都在那里);网页走 showPage(开着就切回去)。
   * 都开在对话右边:「输出」里是 agent 打开过的东西,重开和 agent 打开时同一个位置(spec session-page「并排」)。
   */
  reopenOutput(output: OpenedOutput): void {
    if (output.kind === 'file') {
      this.openFile(output.path, { beside: true });
      return;
    }
    this.showPage(output.url, { preview: false, reload: false, beside: true });
  }

  /**
   * 开一个网页:这条会话里已经开着同一个地址,就切过去,否则新开 —— ❌ 每开一次叠一个新页签(owner 10-06 那一排
   * 重名页签就是这么来的)。照 VS Code 的 Simple Browser:再 show 一次是回到已有的那一格。人点「+」新建浏览器页签
   * 不走这里,照旧新开。「同一个地址」看页签此刻的地址:人在那一格里点去了别处,它就不再是这一页。
   *
   * `reload`:切过去时要不要原地重载。agent 重开(`session_open_in_tab` url)= 是 —— 它多半刚改完文件,要看的就是
   * 新内容。人(从「输出」重开、端口列表)和 App(`gugu.openBrowserTab`)再点一次 = 否,只切过去,照浏览器
   * 「切换到已打开的标签」:重复点一个入口就把页面里没提交的状态冲掉,是摩擦。
   */
  showPage(
    url: string,
    {
      preview,
      reload,
      beside = false,
      activate = true,
    }: {
      preview: boolean;
      reload: boolean;
      /** 开在对话右边并排(spec session-page「并排」)。 */
      beside?: boolean;
      /** 和 beside 一起:agent 打开的传 false —— 用户正看着别的就不切走,一对只在页签条上连好。 */
      activate?: boolean;
    }
  ): void {
    const key = browserAddressKey(url);
    for (const group of this.paneLayout.groups) {
      const tab = group.pane.resolvedTabs.find(
        (t) => t.kind === 'browser' && browserAddressKey((t.resource as BrowserTabResource).session?.currentUrl ?? '') === key
      );
      if (!tab) continue;
      if (!preview) group.pane.pin(tab.tabId);
      // `beside`:同一页已经开着 = 请到对话右边,❌ 新开一枚(spec session-page「并排」)。
      if (!beside || !this.paneLayout.showBeside(tab.tabId, { reveal: activate })) {
        this.paneLayout.setActiveGroup(group.paneId);
        group.pane.setActiveTab(tab.tabId);
      }
      if (reload) browserControlsRegistry.get((tab.resource as BrowserTabResource).browserId)?.adapter?.reload();
      return;
    }
    if (beside) {
      this.paneLayout.open('browser', { initialUrl: url }, { preview, beside: true, activate });
      return;
    }
    this.activePane.open('browser', { initialUrl: url }, { preview });
  }

  get isViewActive(): boolean {
    return (
      appState.navigation.currentViewId === 'session' &&
      (appState.navigation.viewParamsStore['session'] as { sessionId?: string } | undefined)?.sessionId === this.sessionId
    );
  }

  private get _workspace() {
    const workspaceId = this._sessionPageStore.workspaceId;
    if (!workspaceId) return null;
    const projectId = this._sessionPageStore.data.projectId;
    return workspaceRegistry.get(projectId, workspaceId) ?? null;
  }

  // -------------------------------------------------------------------------
  // Computed
  // -------------------------------------------------------------------------

  get activeRenderer(): RendererKind {
    const desc = this.activePane.activeEntry;
    if (desc?.kind === 'diff') return 'diff';
    if (desc?.kind === 'browser') return 'browser';
    if (desc?.kind === 'terminal') return 'terminal';
    const resource = this.activePane.activeResourceOfKind<FileTabResource>('file');
    if (!resource) return 'agents';
    if (resource.contentType === 'markdown' && resource.viewMode === 'preview') return 'markdown';
    if (resource.contentType === 'text' || resource.viewMode === 'source') return 'monaco';
    return 'other-file';
  }

  get snapshot(): SessionViewSnapshot {
    return {
      sidebarTab: this.sidebarTab,
      isSidebarCollapsed: this.isSidebarCollapsed,
      focusedRegion: this.focusedRegion,
      isTerminalDrawerOpen: this.isTerminalDrawerOpen,
      terminalDrawerActiveItem: this.terminalDrawerActiveItem,
      terminals: this.terminalTabs.snapshot,
      editor: this.editorView.snapshot,
      diffView: this.diffView?.snapshot ?? this._savedDiffViewSnapshot,
    };
  }

  // -------------------------------------------------------------------------
  // Lifecycle
  // -------------------------------------------------------------------------

  /**
   * Restore persisted UI state from a saved snapshot. Call this before
   * initialize() so the reaction baseline is correct.
   */
  restoreSnapshot(savedSnapshot: SessionViewSnapshot): void {
    const savedTab = savedSnapshot.sidebarTab as string | undefined;
    // Snapshots from before the Conversations flyout was retired may still say
    // 'conversations' — coerce them instead of resurrecting the panel.
    this.sidebarTab = savedTab === 'changes' || savedTab === 'files' ? savedTab : 'files';
    this.isSidebarCollapsed = savedSnapshot.isSidebarCollapsed ?? true;
    this.focusedRegion = savedSnapshot.focusedRegion === 'bottom' ? 'bottom' : 'main';
    this.isTerminalDrawerOpen = savedSnapshot.isTerminalDrawerOpen ?? false;
    this.terminalDrawerActiveItem = savedSnapshot.terminalDrawerActiveItem;

    // Pass the aggregate blob as fallback so the persistor can migrate legacy
    // tabGroups/tabManager/conversations fields when no dedicated key exists yet.
    this._seeder.markConsumed(this.paneLayout.hydrate(savedSnapshot));

    if (savedSnapshot.terminals) {
      this.terminalTabs.restoreSnapshot(savedSnapshot.terminals);
    }
    if (savedSnapshot.editor) {
      this.editorView.restoreSnapshot(savedSnapshot.editor);
    }
    if (savedSnapshot.diffView) {
      this._savedDiffViewSnapshot = savedSnapshot.diffView;
    }
  }

  /**
   * 没有聚合快照时只恢复页签布局(#6799)。有聚合快照时由 restoreSnapshot 恢复,❌ 两处都调(会恢复两遍)。
   * 什么都没存时不动 seeder:挂起后再 provision 的同一个视图模型,❌ 因此把用户关掉的初始会话又开回来。
   */
  restoreTabs(): void {
    if (this.paneLayout.hydrate()) this._seeder.markConsumed(true);
  }

  /**
   * Called when the task becomes provisioned. Creates session-scoped stores
   * (DiffViewStore, DiffTabLifecycleStore) and starts session-dependent reactions.
   */
  initialize(): void {
    if (this._snapshotDisposer) return; // already active

    const workspace = this._workspace;
    if (!workspace) return; // defensive — should always have workspace when provisioned

    const sessionData = this._sessionPageStore.data;
    const workspaceId = this._sessionPageStore.workspaceId!;
    this.previewServers = new PreviewServerStore({
      projectId: sessionData.projectId,
      workspaceId,
    });
    this.previewServers.start();
    this.prStore = new PrStore(
      sessionData.projectId,
      workspaceId,
      workspace.gitRepository,
      this._sessionPageStore
    );

    // Create DiffViewStore with live git/pr references from the workspace.
    this.diffView = new DiffViewStore(workspace.gitWorktree, this.prStore);
    if (this._savedDiffViewSnapshot) {
      this.diffView.restoreSnapshot(
        normalizeDiffSnapshotPaths(this._savedDiffViewSnapshot, workspace.path)
      );
    }

    getDiffTabManager(workspaceId).bindSession({
      gitWorktree: workspace.gitWorktree,
      pr: this.prStore,
      diffView: this.diffView,
    });

    // Register snapshot with the persistence layer.
    this._snapshotDisposer = snapshotRegistry.register(`session:${this.sessionId}`, () => this.snapshot);
    this.paneLayout.startPersistence();

    // Open the default conversation tab only after provision has registered the task
    // provider in the main process. If tab state was restored, even an empty tab list
    // represents the user's persisted choice.
    this._seeder.start();

    // 只留下摆在这条会话里的 App(behavior tab-extensions「一个 App 只有一份」)—— 接在 hydrate/seed 之后,
    // 存下来的布局复原出来,摆在别处的那几枚当场收掉。
    this._disposers.push(startAppPlacementSync(this.paneLayout, this.sessionId));

    const closeEmptyTerminalDrawerDisposer = reaction(
      () => {
        const terminals = terminalRegistry.get(this.sessionId);
        return {
          isDrawerOpen: this.isTerminalDrawerOpen,
          isCreatingTerminal: this._isCreatingTerminal,
          isLoaded: terminals?.isLoaded ?? false,
          terminalCount: terminals?.terminals.size ?? 0,
        };
      },
      (state, previous) => {
        if (
          state.isDrawerOpen &&
          !state.isCreatingTerminal &&
          state.isLoaded &&
          state.terminalCount === 0 &&
          (previous === undefined || previous.terminalCount > 0 || !previous.isLoaded)
        ) {
          runInAction(() => {
            this.setTerminalDrawerOpen(false);
            this.terminalDrawerActiveItem = undefined;
          });
        }
      },
      { fireImmediately: true }
    );
    this._sessionDisposers.push(closeEmptyTerminalDrawerDisposer);

    // Open this view's file-tree projection now that the workspace is provisioned
    // (it keeps its registered scopes in step with the expanded folders itself).
    this.editorView.startFiles(workspace.path);
  }

  /**
   * Called when the task becomes unprovisioned. Persists the DiffView state and
   * tears down session-scoped stores and reactions. Stable state (tabs, sidebar)
   * is preserved so it survives re-provisioning.
   */
  suspend(): void {
    this._seeder.stop();

    // Persist DiffView state before disposing.
    if (this.diffView) {
      this._savedDiffViewSnapshot = this.diffView.snapshot;
      this.diffView.dispose();
      this.diffView = null;
    }
    getDiffTabManager(this._sessionPageStore.workspaceId!).unbindSession();
    this.prStore?.dispose();
    this.prStore = null;
    this.previewServers?.dispose();
    this.previewServers = null;

    // Stop snapshot persistence.
    this._snapshotDisposer?.();
    this._snapshotDisposer = null;
    this.paneLayout.stopPersistence();

    // Dispose session-scoped reactions before tearing down the projection they drive.
    for (const d of this._sessionDisposers) d();
    this._sessionDisposers = [];

    // Close this view's file-tree projection subscription.
    this.editorView.disposeFiles();
  }

  /**
   * Full teardown: suspend + dispose all permanent stores and reactions.
   * Call only when the task is being permanently removed.
   */
  dispose(): void {
    this.suspend();
    appState.history.prune((e) => e.kind === 'tab' && e.sessionId === this.sessionId);
    for (const d of this._disposers) d();
    this._seeder.dispose();
    this.paneLayout.dispose();
    this.terminalTabs.dispose();
    this.editorView.dispose();
  }

  // -------------------------------------------------------------------------
  // Actions
  // -------------------------------------------------------------------------

  activateLastTabOfKind(kind: 'session' | 'file' | 'diff' | 'browser' | 'terminal'): void {
    const tabId = [...this.activePane.tabOrder]
      .reverse()
      .find((id) => this.activePane.entries.get(id)?.kind === kind);
    if (!tabId) return;
    this.activePane.setActiveTab(tabId);
  }

  setSidebarTab(v: SidebarTab): void {
    this.sidebarTab = v;
  }

  setSidebarCollapsed(collapsed: boolean): void {
    this.isSidebarCollapsed = collapsed;
  }

  // Single source of truth for whether the changes panel is actually visible. SessionSidebar
  // hides it via ShowHide (display: none) based on this, and usePanelLayout must defer
  // imperative panel resizes to exactly the same condition (ENG-1559).
  get isChangesPanelVisible(): boolean {
    return !this.isSidebarCollapsed && this.sidebarTab === 'changes';
  }

  setFocusedRegion(region: 'main' | 'bottom'): void {
    this.focusedRegion = region;
  }

  setTerminalDrawerOpen(open: boolean): void {
    this.isTerminalDrawerOpen = open;
    this.setFocusedRegion(open ? 'bottom' : 'main');
  }

  setTerminalDrawerActiveItem(item: TerminalDrawerActiveItem): void {
    this.terminalDrawerActiveItem = item;
  }

  /**
   * @@@sessionpage layout — create a terminal and open it as a
   * workspace-panel tab (spec 会话页: terminals are named tabs, not a drawer).
   */
  async openTerminalAsTab(shell?: TerminalShellId): Promise<void> {
    const terminalId = await this._createDefaultTerminal(shell);
    if (!terminalId) return;
    this.paneLayout.open('terminal', { terminalId, preview: false });
  }

  async openNewTerminal(shell?: TerminalShellId): Promise<string | undefined> {
    this.isTerminalDrawerOpen = true;
    this.setFocusedRegion('bottom');

    const terminalId = await this._createDefaultTerminal(shell);
    if (!terminalId) return undefined;
    runInAction(() => {
      this.terminalTabs.setActiveTab(terminalId);
      this.terminalDrawerActiveItem = { kind: 'terminal', id: terminalId };
    });
    return terminalId;
  }

  private async _createDefaultTerminal(shell?: TerminalShellId): Promise<string | undefined> {
    if (this._isCreatingTerminal) return undefined;

    this._isCreatingTerminal = true;
    try {
      const terminal = await terminalRegistry.get(this.sessionId)?.createDefaultTerminal(shell);
      if (!terminal) return undefined;
      return terminal.id;
    } catch (error) {
      log.error('Failed to create terminal:', error);
      toast({ title: translateSessionMessage('terminal.createFailed'), description: messageForUser(error), tier: 'error' });
      return undefined;
    } finally {
      runInAction(() => {
        this._isCreatingTerminal = false;
      });
    }
  }
}

function normalizeDiffSnapshotPaths(
  snapshot: DiffViewSnapshot,
  workspacePath: string
): DiffViewSnapshot {
  const activeFile = snapshot.activeFile;
  if (!activeFile || activeFile.group === 'pr') return snapshot;
  return {
    ...snapshot,
    activeFile: {
      ...activeFile,
      path: resolveWorkspacePath(workspacePath, activeFile.path),
    },
  };
}
