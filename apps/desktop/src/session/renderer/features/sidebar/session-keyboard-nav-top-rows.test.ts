// @vitest-environment jsdom
import { observable, runInAction } from 'mobx';
import { describe, expect, it, vi } from 'vitest';

/**
 * owner 2026-10-23「我点击 new task 之后再点其它的平级的按钮, new task 的选中态背景不会自动消失」:侧栏顶上三行
 * 「新建任务 / 会话历史 / 已安排」同时有两行亮着。三行亮的规矩是同一条 —— 主区正看着它;「新建任务」那一行多一层
 * 键盘光标的底色(left-sidebar.tsx),而点过它之后光标一直停在它身上,主区去了会话历史也不走。
 */

const navigation = observable({ currentViewId: 'new-session' as string, viewParamsStore: {} as Record<string, unknown> });
vi.mock('@renderer/lib/stores/app-state', () => ({
  appState: { navigation },
  sidebarStore: { navChain: [{ kind: 'new-session' }, { kind: 'project', projectId: 'design' }] },
}));

const { sessionKeyboardNav } = await import('./session-keyboard-nav');

/** The three top rows as left-sidebar.tsx lights them: active view, plus the keyboard cursor's layer on New task. */
const litRows = () => [
  (navigation.currentViewId === 'new-session' || navigation.currentViewId === 'home' || sessionKeyboardNav.cursor?.kind === 'new-session') && 'new-task',
  navigation.currentViewId === 'session-history' && 'session-history',
  navigation.currentViewId === 'automations' && 'automations',
  (navigation.currentViewId === 'project' || sessionKeyboardNav.cursor?.kind === 'project') && 'project',
].filter(Boolean);

describe('the sidebar top rows: exactly one is lit, the one the main area shows', () => {
  it('clicking New task, then Task history, then Scheduled, then New task again', () => {
    const click = (view: string) => runInAction(() => {
      if (view === 'new-session') sessionKeyboardNav.syncCursorFromPointer({ kind: 'new-session' });
      navigation.currentViewId = view;
    });
    click('new-session');
    expect(litRows()).toEqual(['new-task']);
    click('session-history');
    expect(litRows(), 'the cursor does not stay on New task once the main area left it').toEqual(['session-history']);
    click('automations');
    expect(litRows()).toEqual(['automations']);
    click('new-session');
    expect(litRows()).toEqual(['new-task']);
  });

  // owner 2026-10-23 又撞到一次:在新建任务页选了项目,页面跳进那个项目,「新建任务」那一行还亮着。
  // 光标只是一次还没落地的键盘移动;主区去了哪,亮的就是哪 —— 这一屏只有一份「当前在哪」,❌ 跳转时补一句「清掉光标」。
  it('New task, then a project picked on the new-task page: only the project is lit', () => {
    runInAction(() => {
      sessionKeyboardNav.syncCursorFromPointer({ kind: 'new-session' });
      navigation.currentViewId = 'new-session';
    });
    expect(litRows()).toEqual(['new-task']);
    runInAction(() => {
      navigation.viewParamsStore = { project: { projectId: 'design' } };
      navigation.currentViewId = 'project';
    });
    expect(litRows()).toEqual(['project']);
    expect(sessionKeyboardNav.cursor).toEqual({ kind: 'project', projectId: 'design' });
  });
});
