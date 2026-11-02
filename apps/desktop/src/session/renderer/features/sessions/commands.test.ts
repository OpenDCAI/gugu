import { beforeEach, describe, expect, it, vi } from 'vitest';
import { COMMANDS } from '@shared/commands';
import { createSessionCommandProvider } from './commands';

// ACP imports chat-ui which calls document.createElement at module load time.
// Stub out the entire chat-store chain to avoid the DOM dependency in node tests.
vi.mock('@renderer/features/sessions/acp/acp-chat-store', () => ({
  AcpChatStore: class {
    sessionId = '';
    dispose() {}
    bootstrap() {}
  },
}));
vi.mock('@renderer/features/sessions/acp/acp-chat-panel', () => ({
  AcpChatPanel: () => null,
}));
vi.mock('@renderer/features/browser/browser-tab-item', () => ({
  BrowserTabBarItem: () => null,
  BrowserTabBarItemDragPreview: () => null,
}));
vi.mock('@renderer/features/sessions/editor/file-tab-item', () => ({
  FileTabBarItem: () => null,
  FileTabBarItemDragPreview: () => null,
}));
vi.mock('@renderer/features/sessions/session-tab-item', () => ({
  SessionTabBarItem: () => null,
  SessionTabBarItemDragPreview: () => null,
}));
vi.mock('@renderer/features/sessions/diff-view/diff-tab-item', () => ({
  DiffTabBarItem: () => null,
  DiffTabBarItemDragPreview: () => null,
  diffGroupSuffix: (group: string) => `(${group})`,
}));
vi.mock('@renderer/features/sessions/session-title-utils', () => ({
  formatSessionTitleForDisplay: (_providerId: unknown, title: unknown) =>
    (title as string) ?? 'Conversation',
}));


const mocks = vi.hoisted(() => ({
  focusUrl: vi.fn(),
  getGitRepositoryStore: vi.fn(),
  getRegisteredSessionData: vi.fn(),
  getSessionGitWorktreeStore: vi.fn(),
  getSessionManagerStore: vi.fn(),
  getSessionPageStore: vi.fn(),
  getSessionView: vi.fn(),
  sessionRegistryGet: vi.fn(),
  focusedSessionId: vi.fn(),
  goBack: vi.fn(),
  goForward: vi.fn(),
  navigate: vi.fn(),
  openExternal: vi.fn(),
  reload: vi.fn(),
  getAppSettingValueSnapshot: vi.fn(),
  showModal: vi.fn(),
  startSideSession: vi.fn(),
  toast: vi.fn(),
  visibleSessionEntries: [
    { projectId: 'project-1', sessionId: 'conversation-1' },
    { projectId: 'project-1', sessionId: 'conversation-2' },
  ],
  clipboardWriteText: vi.fn(() => Promise.resolve({ success: true })),
  terminalEnabled: true,
}));

vi.mock('@renderer/features/browser/browser-controls-registry', () => ({
  browserControlsRegistry: {
    get: vi.fn(() => ({
      adapter: {
        canGoBack: () => true,
        canGoForward: () => true,
        goBack: mocks.goBack,
        goForward: mocks.goForward,
        reload: mocks.reload,
      },
      focusUrl: mocks.focusUrl,
    })),
  },
}));

vi.mock('@renderer/features/sessions/stores/session-selectors', () => ({
  getRegisteredSessionData: mocks.getRegisteredSessionData,
  getSessionGitWorktreeStore: mocks.getSessionGitWorktreeStore,
  getSessionManagerStore: mocks.getSessionManagerStore,
  getSessionPageStore: mocks.getSessionPageStore,
  getSessionView: mocks.getSessionView,
}));

vi.mock('@renderer/features/projects/stores/project-selectors', () => ({
  getGitRepositoryStore: mocks.getGitRepositoryStore,
}));

// 归档命令自 #5413 起点名**当前打开的那条会话**(spec session-graph:标签说「归档任务」,动的是这条
// conversation),所以它读的是 registry 与 pane 那个「谁在前台」的判定,❌ 不再是 sessionManager.archiveSession。
vi.mock('@renderer/features/sessions/stores/session-registry', () => ({
  sessionRegistry: {
    get: mocks.sessionRegistryGet,
    // #5665 名下子会话跨 task 数:这份替身里「整个项目」就是 get 登记过的那几张表合起来。
    allSessions: () => {
      const merged = new Map<string, unknown>();
      for (const { sessionId } of mocks.visibleSessionEntries) {
        const manager = mocks.sessionRegistryGet(sessionId) as
          | { sessions: Map<string, unknown> }
          | undefined;
        for (const [id, session] of manager?.sessions ?? []) merged.set(id, session);
      }
      return merged;
    },
  },
}));
vi.mock('@renderer/features/sessions/pane-selectors', () => ({
  focusedSessionId: mocks.focusedSessionId,
  activeSessionId: vi.fn(),
}));

vi.mock('./start-side-session', () => ({
  startSideSession: mocks.startSideSession,
  canStartSideSession: () => true,
}));
vi.mock('@renderer/lib/modal/modal-provider', () => ({
  showModal: mocks.showModal,
}));

vi.mock('@renderer/lib/ipc', () => ({
  rpc: {
    app: {
      openExternal: mocks.openExternal,
      clipboardWriteText: mocks.clipboardWriteText,
    },
  },
}));

vi.mock('@renderer/lib/hooks/use-toast', () => ({
  toast: mocks.toast,
}));

// 归档命令走 archive-session-flow(与侧栏那一行、会话页 ⋯ 菜单同一条),它读设置、发文案、打日志。
vi.mock('@renderer/features/settings/app-settings-client', () => ({
  getAppSettingValueSnapshot: mocks.getAppSettingValueSnapshot,
  setAppSettingsValueInCache: vi.fn(),
  updateAppSettingsRequest: vi.fn(() => Promise.resolve()),
  invalidateAppSettingsKey: vi.fn(),
}));
vi.mock('@renderer/features/settings/use-terminal-enabled', () => ({
  terminalEnabledSnapshot: () => mocks.terminalEnabled,
}));
vi.mock('@renderer/localization/locale-store', () => ({
  translateSessionMessage: (key: string) => key,
}));
vi.mock('@renderer/utils/logger', () => ({
  log: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));

// 归档后离开视图的判据读的是「此刻正站在哪个 view / 哪条会话」(leave-session-view.ts):侧栏归档别人
// 那一行时不该把人踢走。所以这份替身必须把导航状态摆成真的 —— 只给一个 navigate 桩,判据会当场早退,
// 于是这条命令看起来「不导航」,而真机上它导航。
vi.mock('@renderer/lib/stores/app-state', () => ({
  appState: {
    navigation: {
      navigate: mocks.navigate,
      currentViewId: 'session',
      viewParamsStore: { session: { projectId: 'project-1', sessionId: 'conversation-1' } },
    },
  },
}));

function activeBrowserTab() {
  const session = {
    browserId: 'browser-1',
    projectId: 'project-1',
    workspaceId: 'workspace-1',
    sessionId: 'conversation-1',
    profileId: 'default',
    partition: 'persist:gugu-browser-profile',
    currentUrl: 'example.com',
    title: 'Example',
    isLoading: false,
    canGoBack: false,
    canGoForward: false,
    createdAt: 1,
    updatedAt: 1,
  };
  return {
    kind: 'browser',
    tabId: 'browser-tab-1',
    isActive: true,
    isPreview: false,
    state: { initialUrl: 'example.com', session },
    resource: { session },
  };
}

describe('createSessionCommandProvider', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Provide a minimal document global for DOM-querying commands.
    // The node test environment does not have a DOM; we stub querySelector
    // to return null by default (commands gracefully no-op).
    (globalThis as Record<string, unknown>).document = {
      querySelector: vi.fn(() => null),
    };
    mocks.getGitRepositoryStore.mockReturnValue(undefined);
    mocks.getSessionPageStore.mockReturnValue({
      state: 'provisioned',
      setPinned: vi.fn(),
    });
    mocks.getSessionManagerStore.mockReturnValue({
      archiveSession: vi.fn(),
    });
    mocks.focusedSessionId.mockReturnValue('conversation-1');
    mocks.sessionRegistryGet.mockReturnValue({
      archiveSession: vi.fn(() => Promise.resolve({ archived: [], unreached: [] })),
      sessions: new Map([['conversation-1', { data: {} }]]),
    });
    mocks.getSessionView.mockReturnValue({
      isSidebarCollapsed: false,
      isTerminalDrawerOpen: false,
      openNewTerminal: vi.fn(),
      setFocusedRegion: vi.fn(),
      setSidebarCollapsed: vi.fn(),
      setSidebarTab: vi.fn(),
      setTerminalDrawerOpen: vi.fn(),
      paneLayout: {
        open: vi.fn(),
        focusedPane: { id: 'pane-1' },
      },
      terminalTabs: {
        tabs: [],
      },
      activePane: {
        resolvedTabs: [{ id: 'tab-1' }],
        setNextTabActive: vi.fn(),
        setPreviousTabActive: vi.fn(),
        setTabActiveIndex: vi.fn(),
      },
    });
    mocks.visibleSessionEntries = [
      { projectId: 'project-1', sessionId: 'conversation-1' },
      { projectId: 'project-1', sessionId: 'conversation-2' },
    ];
    mocks.getSessionGitWorktreeStore.mockReturnValue(undefined);
    mocks.getRegisteredSessionData.mockReturnValue({
      id: 'conversation-1',
      isPinned: false,
    });

  });

  it('only exposes catalogued command ids', () => {
    for (const command of createSessionCommandProvider('project-1', 'conversation-1').getCommands()) {
      expect(command.id in COMMANDS).toBe(true);
    }
  });

  // spec session-resume:任务内不再有「新建会话」这个动作 —— 新建必须带首轮,那个只填标题的
  // 弹窗给不出首轮。⌘T 现在分一支临时的侧边任务;真正的新建走 app.newSession。
  it('⌘T 分出侧边任务,不再打开任何创建弹窗', () => {
    const provider = createSessionCommandProvider('project-1', 'conversation-1');

    const command = provider.getCommands().find((candidate) => candidate.id === 'session.sideSession');

    command?.execute();

    expect(mocks.startSideSession).toHaveBeenCalledWith('project-1', 'conversation-1');
  });

  // #7052 会话页没有右边那块面板了(对话与工具页签同排):任务里不再有「右侧栏」这条命令。
  it('会话里没有「右侧栏」命令', () => {
    const ids = createSessionCommandProvider('project-1', 'conversation-1').getCommands().map((c) => c.id);
    expect(ids).not.toContain('session.toggleRightSidebar');
  });

  // #6780 旧侧栏两个页签的接班人:走空态 /「+」菜单同一个开页签入口,开在这个会话自己的页签条里。
  it.each([
    ['session.sidebarChanges', 'sidebarChanges', ['review', {}]],
    ['session.sidebarFiles', 'sidebarFiles', ['workspace.main', {}, { preview: false }]],
  ] as const)('%s 打开对应页签', (id, _shortcutKey, openArgs) => {
    const view = {
      ...mocks.getSessionView(),
      paneLayout: { open: vi.fn() },
    };
    mocks.getSessionView.mockReturnValue(view);
    const command = createSessionCommandProvider('project-1', 'conversation-1')
      .getCommands()
      .find((candidate) => candidate.id === id);

    command?.execute();

    expect(view.paneLayout.open).toHaveBeenCalledWith(...openArgs);
    expect(view.setSidebarTab).not.toHaveBeenCalled();
    expect(view.setSidebarCollapsed).not.toHaveBeenCalled();
  });

  // 阳控:那条命令(和它开的弹窗)真的没了 —— 只断言「没被调用」时,一个拼错的 id
  // 也能让上面那条绿,所以这里同时钉「找不到旧命令」。
  it('[阳控] 旧的「新建会话」命令与右分屏变体都已不存在', () => {
    const ids = createSessionCommandProvider('project-1', 'conversation-1')
      .getCommands()
      .map((command) => command.id);

    expect(ids).not.toContain('task.newConversation');
    expect(ids).not.toContain('task.newConversationSplitRight');
    expect(ids).toContain('session.sideSession');
  });

  it('opens a browser tab from the browser command', () => {
    const provider = createSessionCommandProvider('project-1', 'conversation-1');

    const command = provider.getCommands().find((candidate) => candidate.id === 'session.openBrowser');
    const sessionView = mocks.getSessionView.mock.results.at(-1)?.value ?? mocks.getSessionView();

    command?.execute();

    expect(sessionView.paneLayout.open).toHaveBeenCalledWith('browser', {});
    expect(sessionView.setFocusedRegion).toHaveBeenCalledWith('main');
  });

  it('executes active browser commands through the browser controls registry', () => {
    const sessionView = mocks.getSessionView();
    sessionView.activePane.resolvedTabs = [activeBrowserTab()];
    mocks.getSessionView.mockReturnValue(sessionView);
    const provider = createSessionCommandProvider('project-1', 'conversation-1');

    provider
      .getCommands()
      .find((candidate) => candidate.id === 'session.browserReload')
      ?.execute();
    provider
      .getCommands()
      .find((candidate) => candidate.id === 'session.browserFocusUrl')
      ?.execute();
    provider
      .getCommands()
      .find((candidate) => candidate.id === 'session.browserOpenExternal')
      ?.execute();
    provider
      .getCommands()
      .find((candidate) => candidate.id === 'session.browserCopyUrl')
      ?.execute();

    expect(mocks.reload).toHaveBeenCalledWith();
    expect(mocks.focusUrl).toHaveBeenCalledWith();
    expect(mocks.openExternal).toHaveBeenCalledWith('https://example.com/');
    expect(mocks.clipboardWriteText).toHaveBeenCalledWith('https://example.com/');
  });

  it.each([
    [true, true],
    [false, false],
  ])('reflects browser history availability in the command state', (canGoBack, canGoForward) => {
    const sessionView = mocks.getSessionView();
    const tab = activeBrowserTab();
    tab.resource.session.canGoBack = canGoBack;
    tab.resource.session.canGoForward = canGoForward;
    sessionView.activePane.resolvedTabs = [tab];
    mocks.getSessionView.mockReturnValue(sessionView);
    const provider = createSessionCommandProvider('project-1', 'conversation-1');

    const commands = provider.getCommands();
    const goBack = commands.find((candidate) => candidate.id === 'session.browserGoBack');
    const goForward = commands.find((candidate) => candidate.id === 'session.browserGoForward');

    expect(goBack?.enabled).toBe(canGoBack);
    expect(goForward?.enabled).toBe(canGoForward);
    if (canGoBack && canGoForward) {
      goBack?.execute();
      goForward?.execute();
      expect(mocks.goBack).toHaveBeenCalledWith();
      expect(mocks.goForward).toHaveBeenCalledWith();
    }
  });

  it('opens a new terminal as a tab from the terminal command', () => {
    mocks.terminalEnabled = true;
    const openTerminalAsTab = vi.fn();
    mocks.getSessionView.mockReturnValue({
      ...mocks.getSessionView(),
      openTerminalAsTab,
    });
    const provider = createSessionCommandProvider('project-1', 'conversation-1');

    const command = provider
      .getCommands()
      .find((candidate) => candidate.id === 'session.newTerminal');

    command?.execute();

    expect(openTerminalAsTab).toHaveBeenCalled();
  });

  it('offers no terminal commands while the terminal setting is off', () => {
    mocks.terminalEnabled = false;
    const ids = createSessionCommandProvider('project-1', 'conversation-1').getCommands().map((command) => command.id);

    expect(ids).not.toContain('session.newTerminal');
    expect(ids).not.toContain('session.viewTerminals');
  });

  it('archives the focused session and leaves its view', async () => {
    // 主进程报回这一次收走的清单(#6083);这里不看 toast,给空清单即可。
    const archiveSession = vi.fn(() => Promise.resolve({ archived: [], unreached: [] }));
    mocks.sessionRegistryGet.mockReturnValue({
      archiveSession,
      sessions: new Map([['conversation-1', { data: {} }]]),
    });
    mocks.getAppSettingValueSnapshot.mockReturnValue({ confirmBeforeArchive: false });
    const provider = createSessionCommandProvider('project-1', 'conversation-1');

    const command = provider.getCommands().find((candidate) => candidate.id === 'task.archive');

    expect(command?.enabled).toBe(true);
    command?.execute();
    await Promise.resolve();
    await Promise.resolve();

    // 按键静默归档时按**默认范围**走:一个不弹的确认不能替用户勾上递归。
    expect(archiveSession).toHaveBeenCalledWith('conversation-1', { withChildren: false, removeSocialIdentity: true });
    // 这条会话就是此刻打开的那一条:归档成功后离开它的视图。
    expect(mocks.navigate).toHaveBeenCalledWith('project', { projectId: 'project-1' });
  });

  // 「Mod+Shift+E」是默认绑好的键。归档前询问开着时,它必须先问 —— 否则一次误触就把当前会话收走,
  // 而那正是这条设置存在的理由。
  it('asks first when the archive confirmation is on', () => {
    // 主进程报回这一次收走的清单(#6083);这里不看 toast,给空清单即可。
    const archiveSession = vi.fn(() => Promise.resolve({ archived: [], unreached: [] }));
    mocks.sessionRegistryGet.mockReturnValue({
      archiveSession,
      sessions: new Map([['conversation-1', { data: {} }]]),
    });
    mocks.getAppSettingValueSnapshot.mockReturnValue({ confirmBeforeArchive: true });
    const provider = createSessionCommandProvider('project-1', 'conversation-1');

    provider.getCommands().find((candidate) => candidate.id === 'task.archive')?.execute();

    expect(archiveSession).not.toHaveBeenCalled();
    const call = mocks.showModal.mock.calls.at(-1);
    expect(call?.[0]).toBe('confirmActionModal');
    (
      call?.[1] as { onSuccess: (r: { dontAskAgain: boolean; scopeChecked: boolean; optionChecked: boolean }) => void }
    ).onSuccess({ dontAskAgain: false, scopeChecked: false, optionChecked: true });
    expect(archiveSession).toHaveBeenCalledWith('conversation-1', { withChildren: false, removeSocialIdentity: true });
  });

  it('keeps archived tasks from running the archive command', () => {
    mocks.getRegisteredSessionData.mockReturnValue({
      id: 'conversation-1',
      isPinned: false,
      archivedAt: '2026-07-09T00:00:00.000Z',
    });
    const provider = createSessionCommandProvider('project-1', 'conversation-1');

    const command = provider.getCommands().find((candidate) => candidate.id === 'task.archive');

    expect(command?.enabled).toBe(false);
  });

  /** 它点名的是当前打开的那条会话 ⇒ 没有打开任何会话时这一格灰掉,❌ 让一个按键去归档它没点名的东西。 */
  it('没有打开任何会话时这一格灰掉', () => {
    mocks.focusedSessionId.mockReturnValue(undefined);
    const provider = createSessionCommandProvider('project-1', 'conversation-1');

    const command = provider.getCommands().find((candidate) => candidate.id === 'task.archive');

    expect(command?.enabled).toBe(false);
  });

  it('shows an error and stays on the task when archiving fails', async () => {
    const archiveSession = vi.fn(() => Promise.reject(new Error('archive failed')));
    mocks.sessionRegistryGet.mockReturnValue({
      archiveSession,
      sessions: new Map([['conversation-1', { data: {} }]]),
    });
    mocks.getAppSettingValueSnapshot.mockReturnValue({ confirmBeforeArchive: false });
    const provider = createSessionCommandProvider('project-1', 'conversation-1');

    const command = provider.getCommands().find((candidate) => candidate.id === 'task.archive');

    command?.execute();
    await Promise.resolve();
    await Promise.resolve();

    expect(archiveSession).toHaveBeenCalled();
    expect(mocks.navigate).not.toHaveBeenCalled();
    expect(mocks.toast).toHaveBeenCalledWith(
      expect.objectContaining({ title: 'task.archiveTaskFailed', variant: 'destructive' })
    );
  });

  describe('focus & accessibility commands', () => {
    function mockDocument(querySelector: (...args: unknown[]) => unknown) {
      (globalThis as Record<string, unknown>).document = { querySelector };
    }

    it('focuses the first focusable element in the left sidebar', () => {
      const focusable = { focus: vi.fn() };
      const sidebar = { querySelector: vi.fn(() => focusable) };
      mockDocument((selector: unknown) =>
        selector === '[data-region="left-sidebar"]' ? sidebar : null
      );

      const provider = createSessionCommandProvider('project-1', 'conversation-1');
      const command = provider
        .getCommands()
        .find((candidate) => candidate.id === 'session.focusSidebar');

      command?.execute();

      expect(sidebar.querySelector).toHaveBeenCalledWith('[tabindex="0"], button, a, input');
      expect(focusable.focus).toHaveBeenCalled();
    });

    it('does nothing when left sidebar is not in the DOM', () => {
      mockDocument(() => null);

      const provider = createSessionCommandProvider('project-1', 'conversation-1');
      const command = provider
        .getCommands()
        .find((candidate) => candidate.id === 'session.focusSidebar');

      expect(() => command?.execute()).not.toThrow();
    });

    it.each([
      [false, 'Pin Task'],
      [true, 'Unpin Task'],
    ])('reports and toggles the current task pin state', (isPinned, label) => {
      const setPinned = vi.fn();
      mocks.getSessionPageStore.mockReturnValue({
        state: 'provisioned',
        setPinned,
      });
      mocks.getRegisteredSessionData.mockReturnValue({
        id: 'conversation-1',
        isPinned,
      });

      const provider = createSessionCommandProvider('project-1', 'conversation-1');
      const command = provider.getCommands().find((candidate) => candidate.id === 'task.pin');

      expect(command?.label).toBe(label);
      expect(command?.enabled).toBe(true);
      command?.execute();

      expect(setPinned).toHaveBeenCalledWith(!isPinned);
    });

    it('focuses the TipTap editor in the composer region', () => {
      const input = { focus: vi.fn() };
      const composer = { querySelector: vi.fn(() => input) };
      mockDocument((selector: unknown) =>
        selector === '[data-region="composer"]' ? composer : null
      );

      const provider = createSessionCommandProvider('project-1', 'conversation-1');
      const command = provider
        .getCommands()
        .find((candidate) => candidate.id === 'session.focusComposer');

      command?.execute();

      expect(composer.querySelector).toHaveBeenCalledWith(
        '.tiptap[contenteditable="true"], .ProseMirror[contenteditable="true"], [contenteditable="true"], textarea'
      );
      expect(input.focus).toHaveBeenCalled();
    });

    it('does nothing when composer region is not in the DOM', () => {
      mockDocument(() => null);

      const provider = createSessionCommandProvider('project-1', 'conversation-1');
      const command = provider
        .getCommands()
        .find((candidate) => candidate.id === 'session.focusComposer');

      expect(() => command?.execute()).not.toThrow();
    });

    it('stages all files via the git worktree store', () => {
      const stageAllFiles = vi.fn(() => Promise.resolve());
      mocks.getSessionGitWorktreeStore.mockReturnValue({
        stageAllFiles,
        isBranchPublished: true,
        branchName: 'main',
      });

      const provider = createSessionCommandProvider('project-1', 'conversation-1');
      const command = provider
        .getCommands()
        .find((candidate) => candidate.id === 'session.stageAll');

      expect(command?.enabled).toBe(true);
      command?.execute();

      expect(stageAllFiles).toHaveBeenCalled();
    });

    it('disables stageAll when git store is unavailable', () => {
      mocks.getSessionGitWorktreeStore.mockReturnValue(undefined);

      const provider = createSessionCommandProvider('project-1', 'conversation-1');
      const command = provider
        .getCommands()
        .find((candidate) => candidate.id === 'session.stageAll');

      expect(command?.enabled).toBe(false);
    });

    it.each([
      ['session.timelineNext', 0, 1],
      ['session.timelineNext', 2, 0],
      ['session.timelinePrev', 1, 0],
      ['session.timelinePrev', 0, 2],
    ])('moves to the adjacent timeline tick and wraps at the edge', (commandId, selectedIndex, targetIndex) => {
      const ticks = [0, 1, 2].map((tickIndex) => ({
        dataset: { tickSelected: tickIndex === selectedIndex ? 'true' : 'false', tickIndex: String(tickIndex) },
        click: vi.fn(),
      }));
      const timeline = { querySelectorAll: vi.fn(() => ticks) };
      mockDocument((selector: unknown) =>
        selector === '[data-region="session-timeline"]' ? timeline : null
      );

      const provider = createSessionCommandProvider('project-1', 'conversation-1');
      const command = provider
        .getCommands()
        .find((candidate) => candidate.id === commandId);

      command?.execute();

      expect(ticks[targetIndex].click).toHaveBeenCalled();
    });

    it('does nothing for timeline commands when timeline is not in the DOM', () => {
      mockDocument(() => null);

      const provider = createSessionCommandProvider('project-1', 'conversation-1');
      const next = provider
        .getCommands()
        .find((candidate) => candidate.id === 'session.timelineNext');
      const prev = provider
        .getCommands()
        .find((candidate) => candidate.id === 'session.timelinePrev');

      expect(() => next?.execute()).not.toThrow();
      expect(() => prev?.execute()).not.toThrow();
    });
  });
});
