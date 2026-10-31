import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppCommand, CommandProvider } from './types';

const mocks = vi.hoisted(() => ({
  navigate: vi.fn(),
  showModal: vi.fn(),
  register: vi.fn(),
  navigation: {
    currentViewId: 'home',
    viewParamsStore: {} as Record<string, unknown>,
  },
}));

vi.mock('@renderer/features/sidebar/session-keyboard-nav', () => ({ sessionKeyboardNav: { startRename: vi.fn() } }));
vi.mock('@renderer/lib/stores/app-state', () => ({
  appState: {
    navigation: {
      get currentViewId() {
        return mocks.navigation.currentViewId;
      },
      get viewParamsStore() {
        return mocks.navigation.viewParamsStore;
      },
      navigate: mocks.navigate,
      lastNonLibraryView: 'home',
    },
    history: { canGoBack: false, canGoForward: false, back: vi.fn(), forward: vi.fn() },
  },
}));
vi.mock('@renderer/lib/modal/modal-provider', () => ({ showModal: mocks.showModal }));
vi.mock('./registry', () => ({ commandRegistry: { register: mocks.register } }));
vi.mock('@renderer/lib/components/nav-buttons', () => ({ applyHistoryEntry: vi.fn() }));
vi.mock('@renderer/lib/open-shell-settings', () => ({ openShellSettings: vi.fn() }));
vi.mock('@renderer/lib/open-shell-feedback', () => ({ openShellFeedback: vi.fn() }));
vi.mock('@renderer/lib/theme/host-theme', () => ({ toggleHostTheme: vi.fn() }));

import { setupAppCommandProvider } from './app-commands';

function appCommands(): AppCommand[] {
  setupAppCommandProvider();
  const provider = mocks.register.mock.calls.at(-1)?.[0] as CommandProvider;
  return provider.getCommands();
}

describe('app.newTask (⌘N / command palette "New Task")', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // #5690: it used to open `taskModal`, the old title + linked-issue dialog that
  // behavior session-resume says must not exist. New tasks start from a first message.
  it('goes to the project home composer instead of opening the old create dialog', () => {
    mocks.navigation.currentViewId = 'session';
    mocks.navigation.viewParamsStore = { session: { projectId: 'project-1', sessionId: 'task-1' } };

    const newSession = appCommands().find((command) => command.id === 'app.newSession');
    expect(newSession).toBeDefined();
    newSession!.execute();

    expect(mocks.navigate).toHaveBeenCalledWith('project', { projectId: 'project-1' });
    expect(mocks.showModal).not.toHaveBeenCalled();
  });

  // gugu-dev#181 ⑯ 哪一页都有(⌘K 面板的建议操作在哪一页都是那几项):不在项目里 = 侧栏「新建会话」那一行,去新建会话页。
  it('outside a project goes to the new task page', () => {
    mocks.navigation.currentViewId = 'home';
    mocks.navigation.viewParamsStore = {};

    appCommands().find((command) => command.id === 'app.newSession')!.execute();
    expect(mocks.navigate).toHaveBeenCalledWith('new-session');
  });
});
