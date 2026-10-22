import { observable, runInAction } from 'mobx';
import { afterEach, describe, expect, it, vi } from 'vitest';

const navigation = vi.hoisted(() => ({ current: null as null | { currentViewId: string; viewParamsStore: Record<string, unknown> } }));
const blocks = vi.hoisted(() => ({ current: null as null | { sessions: Array<{ blockId: string; projectId: string; sessionId: string }> } }));
const report = vi.hoisted(() => vi.fn((_ids: string[]) => Promise.resolve()));
vi.mock('@renderer/lib/stores/app-state', () => ({
  appState: {
    get navigation() {
      return navigation.current;
    },
  },
}));
vi.mock('./screen-layout', () => ({
  screenLayout: {
    get sessions() {
      return blocks.current!.sessions;
    },
    blockOfSession: (sessionId: string) => blocks.current!.sessions.find((s) => s.sessionId === sessionId),
  },
}));
vi.mock('@renderer/lib/ipc', () => ({ rpc: { sessions: { reportSessionsOnScreen: report } } }));
vi.mock('@renderer/utils/logger', () => ({ log: { warn: vi.fn() } }));

const { auxWindows } = await import('./aux-windows');
const { sessionPageOnScreen, sessionPagesOnScreen, sessionsOnScreen, wireSessionsOnScreenReport } = await import('./sessions-on-screen');

const home = { windowPanes: new Map(), returnFromWindow: () => {} };

function setup(view: { currentViewId: string; sessionId?: string }, onBlocks: string[] = []) {
  navigation.current = observable({
    currentViewId: view.currentViewId,
    viewParamsStore: view.sessionId ? { session: { projectId: 'p', sessionId: view.sessionId } } : {},
  });
  blocks.current = observable({ sessions: onBlocks.map((sessionId, i) => ({ blockId: `b${i}`, projectId: 'p', sessionId })) });
}

afterEach(() => {
  for (const id of [...auxWindows.windows.keys()]) auxWindows.remove(id);
  report.mockClear();
});

describe('sessions on screen', () => {
  it('a session whose tab is open in its own window is on screen, while its page is not', () => {
    setup({ currentViewId: 'session', sessionId: 'b' });
    auxWindows.add({ kind: 'tab', projectId: 'p', sessionId: 'a', paneId: 'pane-1', home });
    expect(sessionsOnScreen().sort()).toEqual(['a', 'b']);
    // 页不在屏上:页签窗那一格自己就算看得见,会话页仍按「它的页看不看得见」判(workspace-view-model)。
    expect(sessionPageOnScreen('a')).toBe(false);
    expect(sessionPageOnScreen('b')).toBe(true);
  });

  it('every session in a block of the screen, and a whole session window, are on screen', () => {
    setup({ currentViewId: 'session', sessionId: 'a' }, ['a', 'c']);
    auxWindows.add({ kind: 'session', projectId: 'p', sessionId: 'd' });
    expect(sessionsOnScreen().sort()).toEqual(['a', 'c', 'd']);
    expect(['a', 'c', 'd'].every(sessionPageOnScreen)).toBe(true);
  });

  it('names the project of every session on screen, once per session', () => {
    setup({ currentViewId: 'session', sessionId: 'a' }, ['a', 'c']);
    auxWindows.add({ kind: 'tab', projectId: 'q', sessionId: 'e', paneId: 'pane-2', home });
    auxWindows.add({ kind: 'tab', projectId: 'p', sessionId: 'a', paneId: 'pane-3', home });
    expect(sessionPagesOnScreen()).toEqual([
      { projectId: 'p', sessionId: 'a' },
      { projectId: 'p', sessionId: 'c' },
      { projectId: 'q', sessionId: 'e' },
    ]);
  });

  it('off the session view, the blocks are not on screen; windows still are', () => {
    setup({ currentViewId: 'home', sessionId: 'a' }, ['a', 'c']);
    auxWindows.add({ kind: 'tab', projectId: 'p', sessionId: 'e', paneId: 'pane-2', home });
    expect(sessionsOnScreen()).toEqual(['e']);
  });

  it('reports the set to main whenever it changes, and only then', () => {
    setup({ currentViewId: 'session', sessionId: 'b' });
    const stop = wireSessionsOnScreenReport();
    expect(report).toHaveBeenLastCalledWith(['b']);
    const id = auxWindows.add({ kind: 'tab', projectId: 'p', sessionId: 'a', paneId: 'pane-1', home });
    expect(report).toHaveBeenLastCalledWith(['a', 'b']);
    // 同一条会话再多一枚页签窗:屏上的会话没变,不再报。
    auxWindows.add({ kind: 'tab', projectId: 'p', sessionId: 'a', paneId: 'pane-2', home });
    expect(report).toHaveBeenCalledTimes(2);
    runInAction(() => auxWindows.remove(id));
    expect(report).toHaveBeenCalledTimes(2);
    for (const other of [...auxWindows.windows.keys()]) runInAction(() => auxWindows.remove(other));
    expect(report).toHaveBeenLastCalledWith(['b']);
    expect(report).toHaveBeenCalledTimes(3);
    stop();
  });
});
