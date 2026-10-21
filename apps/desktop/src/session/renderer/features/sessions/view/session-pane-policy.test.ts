import { reaction } from 'mobx';
import { describe, expect, it } from 'vitest';
import { createTabProvider, createTabRegistry } from '@renderer/features/tabs/core/tab-provider-registry';
import { PaneLayoutStore } from '@renderer/features/tabs/pane-layout-store';
import { activeChatSessionId, findChatPaneId, replaceSessionTab } from './session-pane-policy';

// #7052 对话是会话的第一枚页签,可以在任何一格:「当前会话」= 正看着的那条对话。
type Tab = { tabId: string; kind: string; isActive: boolean; sessionId?: string };
const pane = (paneId: string, tabs: Tab[]) => ({
  paneId,
  pane: {
    resolvedTabs: tabs,
    entries: new Map(tabs.map((t) => [t.tabId, { kind: t.kind, state: t.sessionId ? { sessionId: t.sessionId } : {} }])),
  },
});
const layoutOf = (activePaneId: string, groups: ReturnType<typeof pane>[]) => ({ activePaneId, groups }) as never;

describe('current session on a session page (#7052)', () => {
  it('聚焦着的那一格前面是对话 → 就是它', () => {
    const layout = layoutOf('b', [
      pane('a', [{ tabId: 'a1', kind: 'acp-chat', isActive: true, sessionId: 'root' }]),
      pane('b', [{ tabId: 'b1', kind: 'session', isActive: true, sessionId: 'child' }]),
    ]);
    expect(findChatPaneId(layout)).toBe('b');
    expect(activeChatSessionId(layout)).toBe('child');
  });

  it('聚焦着的那一格前面不是对话(终端)→ 前面是对话的那一格', () => {
    const layout = layoutOf('b', [
      pane('a', [{ tabId: 'a1', kind: 'acp-chat', isActive: true, sessionId: 'root' }]),
      pane('b', [{ tabId: 'b1', kind: 'terminal', isActive: true }]),
    ]);
    expect(findChatPaneId(layout)).toBe('a');
    expect(activeChatSessionId(layout)).toBe('root');
  });

  it('哪一格前面都不是对话 → 收着对话页签的那一格里的那条', () => {
    const layout = layoutOf('a', [
      pane('a', [
        { tabId: 'a1', kind: 'acp-chat', isActive: false, sessionId: 'root' },
        { tabId: 'a2', kind: 'browser', isActive: true },
      ]),
    ]);
    expect(findChatPaneId(layout)).toBe('a');
    expect(activeChatSessionId(layout)).toBe('root');
  });

  it('一条对话都没开 → 没有当前会话', () => {
    const layout = layoutOf('a', [pane('a', [{ tabId: 'a1', kind: 'terminal', isActive: true }])]);
    expect(findChatPaneId(layout)).toBeUndefined();
    expect(activeChatSessionId(layout)).toBeUndefined();
  });
});

describe('换一种展示:同一条会话的对话页签原地换种类', () => {
  // 真的页签布局(不是替身):这两条判的正是页签条与「一块空了就关掉」之间的时序。
  const fake = (kind: string) =>
    createTabProvider({
      kind,
      resourceKey: (state: { sessionId?: string; id?: string }) => state.sessionId ?? state.id ?? '',
      initialize: () => ({ dispose: () => {} }),
      dispose: () => {},
      TabBarItem: () => null,
      TabBarItemDragPreview: () => null,
      TabContent: () => null,
    });
  const registry = createTabRegistry([fake('session'), fake('acp-chat'), fake('terminal')] as const);
  const ctx = { viewId: 'v', projectId: 'p', workspaceId: 'w', sessionId: 's1', modelRootPath: 'workspace:w' };

  /** 按顺序开好这几枚,并盯着这一块有没有哪一刻一枚页签都没有(keepBlockFilled 看的就是这个)。 */
  function blockWith(tabs: Array<[kind: string, state: Record<string, string>]>) {
    const layout = new PaneLayoutStore(registry, ctx);
    for (const [kind, state] of tabs) layout.open(kind, state);
    let sawEmpty = false;
    const stop = reaction(
      () => layout.groups.length === 1 && layout.groups[0].pane.tabOrder.length === 0,
      (empty) => {
        if (empty) sawEmpty = true;
      }
    );
    const kinds = () => layout.groups[0].pane.tabOrder.map((id) => layout.groups[0].pane.entries.get(id)?.kind);
    return { layout, kinds, sawEmpty: () => sawEmpty, stop };
  }

  it('块里只有对话那一枚:换完这一块不曾空过(空过一刻就被关掉,一屏几块时整组散掉)', () => {
    const block = blockWith([['acp-chat', { sessionId: 's1' }]]);
    replaceSessionTab(block.layout as never, 's1', 'session');
    expect(block.kinds()).toEqual(['session']);
    expect(block.sawEmpty()).toBe(false);
    block.stop();
  });

  it('对话排第一、后面有终端:换完还排第一,不跑到终端后面', () => {
    const block = blockWith([
      ['acp-chat', { sessionId: 's1' }],
      ['terminal', { id: 't1' }],
    ]);
    replaceSessionTab(block.layout as never, 's1', 'session');
    expect(block.kinds()).toEqual(['session', 'terminal']);
    block.stop();
  });

  it('会话分了两格(对话独占左格、终端在右格):换完左格还在,对话仍在左格', () => {
    const block = blockWith([
      ['acp-chat', { sessionId: 's1' }],
      ['terminal', { id: 't1' }],
    ]);
    const left = block.layout.groups[0];
    const terminalTab = left.pane.tabOrder[1];
    expect(block.layout.splitPane(left.paneId, 'right', terminalTab)).toBe(true);
    expect(block.layout.groups).toHaveLength(2);
    replaceSessionTab(block.layout as never, 's1', 'session');
    expect(block.layout.groups.map((g) => g.paneId)[0]).toBe(left.paneId);
    expect(block.layout.groups.map((g) => g.pane.tabOrder.map((id) => g.pane.entries.get(id)?.kind))).toEqual([['session'], ['terminal']]);
    block.stop();
  });

  it('对话被挪到第二枚:换完仍在第二枚', () => {
    const block = blockWith([
      ['terminal', { id: 't1' }],
      ['session', { sessionId: 's1' }],
      ['terminal', { id: 't2' }],
    ]);
    replaceSessionTab(block.layout as never, 's1', 'acp-chat');
    expect(block.kinds()).toEqual(['terminal', 'acp-chat', 'terminal']);
    block.stop();
  });
});
