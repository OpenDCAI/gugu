import { describe, expect, it } from 'vitest';
import { closeTabsOfSession } from '@renderer/features/sessions/view/session-pane-policy';
import { createTabProvider, createTabRegistry } from './core/tab-provider-registry';
import { PaneLayoutStore } from './pane-layout-store';
import { createTabView } from './tab-view-factory';
import { paneSlotView } from './pane-slot-view';
import type { PaneStore } from './pane-store';

/**
 * 并排(spec session-page「并排」):agent 打开的、从对话里点开的开在对话右边,一条页签条上连成一对。
 * 一个最小的页签种类表:对话(chat)、文件(file,只开一份)、网页(page)、终端(term)。
 */
function provider(kind: string, mount: 'single' | 'multi' = 'multi') {
  return createTabProvider({
    kind,
    mount,
    resourceKey: (state: { id: string }) => state.id,
    initialize: () => ({ dispose: () => {} }),
    dispose: () => {},
    TabBarItem: () => null,
    TabBarItemDragPreview: () => null,
    TabContent: () => null,
  });
}

const ctx = { viewId: 's1', projectId: 'p1', workspaceId: 'w1', sessionId: 's1', modelRootPath: 'workspace:w1' };

function setup() {
  const registry = createTabRegistry([
    provider('chat', 'single'),
    provider('file', 'single'),
    provider('page'),
    provider('term'),
  ] as const);
  const layout = new PaneLayoutStore(registry, ctx);
  layout.open('chat', { id: 'conv' });
  const chatPane = layout.groups[0];
  const chatTabId = chatPane.pane.tabOrder[0];
  layout.setPairAnchor(() => {
    const group = layout.groups.find((g) => [...g.pane.entries.values()].some((e) => e.kind === 'chat'));
    const tab = group && [...group.pane.entries.values()].find((e) => e.kind === 'chat');
    return group && tab ? { paneId: group.paneId, tabId: tab.tabId } : null;
  });
  const pane = chatPane.pane as PaneStore;
  const idOf = (kind: string, id: string) =>
    [...pane.entries.values()].find((e) => e.kind === kind && (e.state as { id: string }).id === id)?.tabId;
  const label = (tabId: string | undefined) => {
    const entry = tabId ? pane.entries.get(tabId) : undefined;
    return entry ? `${entry.kind}:${(entry.state as { id: string }).id}` : String(tabId);
  };
  const shown = () => pane.shownTabIds.map(label);
  const strip = () => pane.tabOrder.map(label);
  return { layout, pane, chatTabId, idOf, label, shown, strip };
}

describe('并排:agent 打开的开在对话右边', () => {
  it('正看着对话:那一页开在右边,两边同时看得见,焦点还在对话', () => {
    const { layout, pane, chatTabId, shown, strip } = setup();
    layout.open('term', { id: 't1' }, { activate: false });
    layout.open('file', { id: 'a.ts' }, { beside: true, activate: false });
    expect(shown()).toEqual(['chat:conv', 'file:a.ts']);
    expect(pane.activeTabId).toBe(chatTabId);
    // 一对挨着:右边那页紧跟在对话后面。
    expect(strip()).toEqual(['chat:conv', 'file:a.ts', 'term:t1']);
    expect(pane.resolvedTabs.map((t) => t.pairRole)).toEqual(['start', 'end', undefined]);
  });

  it('并排着又开一个:新的顶替右边,被顶下来的退成普通页签,点它就换回右边', () => {
    const { layout, pane, idOf, shown, strip } = setup();
    layout.open('file', { id: 'a.ts' }, { beside: true, activate: false });
    layout.open('page', { id: 'docs' }, { beside: true, activate: false });
    expect(shown()).toEqual(['chat:conv', 'page:docs']);
    expect(strip()).toEqual(['chat:conv', 'page:docs', 'file:a.ts']);
    pane.setActiveTab(idOf('file', 'a.ts')!);
    expect(shown()).toEqual(['chat:conv', 'file:a.ts']);
    expect(strip()).toEqual(['chat:conv', 'file:a.ts', 'page:docs']);
  });

  it('瞄一眼打开的被顶下来直接收掉,❌ 留一枚页签', () => {
    const { layout, pane, idOf, shown } = setup();
    layout.open('file', { id: 'a.ts' }, { beside: true, activate: false, preview: true });
    layout.open('page', { id: 'docs' }, { beside: true, activate: false });
    expect(shown()).toEqual(['chat:conv', 'page:docs']);
    expect(idOf('file', 'a.ts')).toBeUndefined();
    expect(pane.tabOrder).toHaveLength(2);
  });

  it('同一种瞄一眼再开一个:右边原地换内容,还是那一枚', () => {
    const { layout, pane, idOf, shown } = setup();
    layout.open('file', { id: 'a.ts' }, { beside: true, activate: false, preview: true });
    const tabId = idOf('file', 'a.ts');
    layout.open('file', { id: 'b.ts' }, { beside: true, activate: false, preview: true });
    expect(shown()).toEqual(['chat:conv', 'file:b.ts']);
    expect(idOf('file', 'b.ts')).toBe(tabId);
    expect(pane.tabOrder).toHaveLength(2);
  });

  it('正在并排时点别的页签:它换到右边,对话钉在左边不动', () => {
    const { layout, pane, idOf, shown } = setup();
    layout.open('term', { id: 't1' }, { activate: false });
    layout.open('file', { id: 'a.ts' }, { beside: true, activate: false });
    pane.setActiveTab(idOf('term', 't1')!);
    expect(shown()).toEqual(['chat:conv', 'term:t1']);
    expect(pane.livePair?.side).toBe(idOf('term', 't1'));
  });

  it('屏上只有一页时点别的页签:照旧换成它,❌ 拉对话进来', () => {
    const { layout, pane, idOf, shown } = setup();
    layout.open('term', { id: 't1' }, { activate: false });
    layout.open('page', { id: 'docs' }, { activate: false });
    pane.setActiveTab(idOf('term', 't1')!);
    expect(shown()).toEqual(['term:t1']);
    pane.setActiveTab(idOf('page', 'docs')!);
    expect(shown()).toEqual(['page:docs']);
    expect(pane.livePair).toBeNull();
  });

  it('用户正看着终端:agent 打开 ❌ 切走,一对只在页签条上连好;点对话就看到并排', () => {
    const { layout, pane, chatTabId, idOf, shown } = setup();
    layout.open('term', { id: 't1' });
    expect(shown()).toEqual(['term:t1']);
    layout.open('file', { id: 'a.ts' }, { beside: true, activate: false });
    expect(shown()).toEqual(['term:t1']);
    expect(pane.activeTabId).toBe(idOf('term', 't1'));
    expect(pane.livePair).toEqual({ anchor: chatTabId, side: idOf('file', 'a.ts'), sideAt: 'right', ratio: null });
    pane.setActiveTab(chatTabId);
    expect(shown()).toEqual(['chat:conv', 'file:a.ts']);
  });

  it('关掉右边那页:对话回到占满', () => {
    const { layout, pane, chatTabId, idOf, shown } = setup();
    layout.open('file', { id: 'a.ts' }, { beside: true, activate: false });
    pane.setActiveTab(idOf('file', 'a.ts')!);
    pane.closeTab(idOf('file', 'a.ts')!);
    expect(shown()).toEqual(['chat:conv']);
    expect(pane.activeTabId).toBe(chatTabId);
    expect(pane.livePair).toBeNull();
  });

  it('右键「拆开」:两枚变回普通页签,点着的那枚占满', () => {
    const { layout, pane, idOf, shown } = setup();
    layout.open('file', { id: 'a.ts' }, { beside: true, activate: false });
    pane.setActiveTab(idOf('file', 'a.ts')!);
    pane.separatePair();
    expect(shown()).toEqual(['file:a.ts']);
    expect(pane.resolvedTabs.every((t) => t.pairRole === undefined)).toBe(true);
  });

  it('放不下两页(各 220px):一对还连着,屏上只显示点着的那一页;拉宽了自动回并排', () => {
    const { layout, pane, shown } = setup();
    layout.open('file', { id: 'a.ts' }, { beside: true, activate: false });
    pane.setDimensions(400, 600);
    expect(shown()).toEqual(['chat:conv']);
    expect(pane.livePair).not.toBeNull();
    pane.setDimensions(441, 600);
    expect(shown()).toEqual(['chat:conv', 'file:a.ts']);
  });

  it('太窄时点别的页签:屏上只有一页,照旧换成它,一对不变', () => {
    const { layout, pane, idOf, shown } = setup();
    layout.open('term', { id: 't1' }, { activate: false });
    layout.open('file', { id: 'a.ts' }, { beside: true, activate: false });
    pane.setDimensions(300, 600);
    pane.setActiveTab(idOf('term', 't1')!);
    expect(shown()).toEqual(['term:t1']);
    expect(pane.livePair?.side).toBe(idOf('file', 'a.ts'));
  });

  it('同一页已经开着:请到右边,❌ 新开一枚', () => {
    const { layout, pane, idOf, shown } = setup();
    layout.open('file', { id: 'a.ts' }, { activate: false });
    layout.open('file', { id: 'a.ts' }, { beside: true, activate: false });
    expect(pane.tabOrder).toHaveLength(2);
    expect(shown()).toEqual(['chat:conv', 'file:a.ts']);
    expect(pane.livePair?.side).toBe(idOf('file', 'a.ts'));
  });

  it('会话已分成几格、焦点在终端那格:并排开在对话那一格,用户分出来的格不动', () => {
    const { layout, pane, shown } = setup();
    layout.open('term', { id: 't1' });
    layout.splitPane(layout.groups[0].paneId, 'right');
    const termPane = layout.groups.find((g) => g.pane !== pane)!;
    expect(layout.activePaneId).toBe(termPane.paneId);
    layout.open('file', { id: 'a.ts' }, { beside: true, activate: false });
    expect(shown()).toEqual(['chat:conv', 'file:a.ts']);
    expect(termPane.pane.tabOrder).toHaveLength(1);
    expect(layout.activePaneId).toBe(termPane.paneId);
  });

  it('它在用户自己分出的另一格里:留在原处、在那一格亮到前面,❌ 拽回对话旁边', () => {
    const { layout, pane } = setup();
    layout.open('file', { id: 'a.ts' });
    layout.open('term', { id: 't1' });
    layout.splitPane(layout.groups[0].paneId, 'right', pane.tabOrder.find((id) => pane.entries.get(id)?.kind === 'file'));
    const other = layout.groups.find((g) => g.pane !== pane)!;
    other.pane.open('term', { id: 't2' });
    layout.open('file', { id: 'a.ts' }, { beside: true, activate: false });
    const fileTab = [...other.pane.entries.values()].find((e) => e.kind === 'file')!;
    expect(other.pane.activeTabId).toBe(fileTab.tabId);
    expect(pane.livePair).toBeNull();
  });

  it('右边那页「向右分」:从并排里挪出来成一格,对话占满', () => {
    const { layout, pane, chatTabId, idOf, shown } = setup();
    layout.open('file', { id: 'a.ts' }, { beside: true, activate: false });
    layout.splitPane(layout.groups[0].paneId, 'right', idOf('file', 'a.ts'));
    expect(layout.groups).toHaveLength(2);
    expect(pane.livePair).toBeNull();
    expect(shown()).toEqual(['chat:conv']);
    expect(pane.activeTabId).toBe(chatTabId);
  });

  it('拖动页签:一对始终挨着', () => {
    const { layout, pane, strip } = setup();
    layout.open('term', { id: 't1' }, { activate: false });
    layout.open('file', { id: 'a.ts' }, { beside: true, activate: false });
    expect(strip()).toEqual(['chat:conv', 'file:a.ts', 'term:t1']);
    pane.reorderTabs(0, 2);
    expect(strip()).toEqual(['term:t1', 'chat:conv', 'file:a.ts']);
  });

  it('存下来、读回来还是那一对', () => {
    const { layout, pane, chatTabId, idOf } = setup();
    layout.open('file', { id: 'a.ts' }, { beside: true, activate: false });
    pane.setPairRatio(0.6);
    const saved = layout.snapshot;
    expect(saved.groups[0].tabManager.pair).toEqual({ anchorTabId: chatTabId, sideTabId: idOf('file', 'a.ts'), share: 0.6 });
    const { layout: restored } = setup();
    restored.restoreSnapshot(saved);
    expect(restored.groups[0].pane.livePair).toEqual({ anchor: chatTabId, side: idOf('file', 'a.ts'), sideAt: 'right', ratio: 0.6 });
  });

  it('人点开的(聊天里的链接、「输出」里重开):连好后并排亮到屏上,焦点在那一页', () => {
    const { layout, pane, idOf, shown } = setup();
    layout.open('term', { id: 't1' });
    expect(shown()).toEqual(['term:t1']);
    layout.open('file', { id: 'a.ts' }, { beside: true });
    expect(shown()).toEqual(['chat:conv', 'file:a.ts']);
    expect(pane.activeTabId).toBe(idOf('file', 'a.ts'));
  });

  it('人从「输出」重开一页已经开着的:请到右边并亮出来', () => {
    const { layout, pane, shown } = setup();
    layout.open('file', { id: 'a.ts' });
    expect(shown()).toEqual(['file:a.ts']);
    layout.open('term', { id: 't1' });
    layout.open('file', { id: 'a.ts' }, { beside: true });
    expect(shown()).toEqual(['chat:conv', 'file:a.ts']);
    expect(pane.tabOrder).toHaveLength(3);
  });

  it('没有对话可并排:照常开在焦点那一格', () => {
    const registry = createTabRegistry([provider('file', 'single'), provider('term')] as const);
    const layout = new PaneLayoutStore(registry, ctx);
    layout.setPairAnchor(() => null);
    layout.open('term', { id: 't1' });
    layout.open('file', { id: 'a.ts' }, { beside: true });
    const pane = layout.groups[0].pane;
    expect(pane.shownTabIds).toHaveLength(1);
    expect(pane.entries.get(pane.activeTabId!)?.kind).toBe('file');
  });
});

describe('并排:审阅补的几条', () => {
  /** 记下谁被 onActivate(「这一页上屏了」);file 页签可以否掉关闭。 */
  function tracked(opts?: { vetoFileClose?: boolean }) {
    const activated: string[] = [];
    const make = (kind: string, mount: 'single' | 'multi' = 'multi') =>
      createTabProvider({
        kind,
        mount,
        resourceKey: (state: { id: string; sessionId?: string }) => state.id,
        initialize: (entry: { state: { id: string } }) => ({ dispose: () => {}, onActivate: () => activated.push(`${kind}:${entry.state.id}`) }),
        dispose: () => {},
        ...(kind === 'file' && opts?.vetoFileClose ? { onBeforeClose: () => false } : {}),
        TabBarItem: () => null,
        TabBarItemDragPreview: () => null,
        TabContent: () => null,
      });
    const registry = createTabRegistry([make('acp-chat', 'single'), make('file', 'single'), make('term')] as const);
    const layout = new PaneLayoutStore(registry, ctx);
    layout.setViewActive(true);
    layout.open('acp-chat', { id: 'conv', sessionId: 's1' });
    const pane = layout.groups[0].pane as PaneStore;
    const chatTabId = pane.tabOrder[0];
    layout.setPairAnchor(() => ({ paneId: layout.groups[0].paneId, tabId: chatTabId }));
    const idOf = (kind: string, id: string) =>
      [...pane.entries.values()].find((e) => e.kind === kind && (e.state as { id: string }).id === id)?.tabId;
    return { layout, pane, chatTabId, idOf, activated, registry };
  }

  it('焦点在右边那页时,左边的对话也算上屏(onActivate),❌ 只唤醒拿着焦点的那枚', () => {
    const { layout, pane, idOf, activated } = tracked();
    layout.open('term', { id: 't1' });
    activated.length = 0;
    layout.open('file', { id: 'a.ts' }, { beside: true });
    expect(pane.activeTabId).toBe(idOf('file', 'a.ts'));
    expect(activated.sort()).toEqual(['acp-chat:conv', 'file:a.ts']);
  });

  it('重启读回时焦点在右边那页:左边的对话照样开场', () => {
    const { layout, idOf } = tracked();
    layout.open('file', { id: 'a.ts' }, { beside: true });
    const saved = layout.snapshot;
    expect(saved.groups[0].tabManager.activeTabId).toBe(idOf('file', 'a.ts'));
    const { layout: restored, activated } = tracked();
    activated.length = 0;
    restored.restoreSnapshot(saved);
    expect(activated.sort()).toEqual(['acp-chat:conv', 'file:a.ts']);
  });

  it('右边那页暂时成了占位(App 停用):存档照样留着这一对', () => {
    const { layout, pane, chatTabId, idOf, registry } = tracked();
    layout.open('file', { id: 'a.ts' }, { beside: true, activate: false });
    registry.unregister('file');
    expect(pane.livePair).toBeNull();
    expect(layout.snapshot.groups[0].tabManager.pair).toEqual({ anchorTabId: chatTabId, sideTabId: idOf('file', 'a.ts') });
  });

  it('瞄一眼的被顶下来也先问一句:被否了就留成普通页签,❌ 悄悄扔掉', async () => {
    const { layout, pane, idOf } = tracked({ vetoFileClose: true });
    layout.open('file', { id: 'a.ts' }, { beside: true, activate: false, preview: true });
    layout.open('term', { id: 't1' }, { beside: true, activate: false });
    await Promise.resolve();
    expect(idOf('file', 'a.ts')).toBeDefined();
    expect(pane.livePair?.side).not.toBe(idOf('file', 'a.ts'));
  });

  it('删除会话时焦点在右边那页:认得出对话正在屏上(好补开下一条)', () => {
    const { layout } = tracked();
    layout.open('file', { id: 'a.ts' }, { beside: true });
    const { displayedInPaneId } = closeTabsOfSession(layout as never, 's1');
    expect(displayedInPaneId).toBe(layout.groups[0].paneId);
  });

  it('要开在对话旁边、却没有对话:照常开,照常就是切过去', () => {
    const { layout, pane, idOf } = tracked();
    layout.setPairAnchor(() => null);
    layout.open('file', { id: 'a.ts' }, { beside: true, activate: false });
    expect(pane.activeTabId).toBe(idOf('file', 'a.ts'));
  });
});

/**
 * 一条会话一条页签条(owner 2026-10-14「同一个问题」):分屏只有并排一种 —— 向右分 / 向下分 / 拖到边上 / ⌘\
 * 和 agent 打开的是同一件事;任意两页都能并排,左右或上下;拆开 = 不分屏,之后不再自动并排。
 */
describe('并排:手动分屏、拆开', () => {
  function single() {
    const base = setup();
    const layout = new PaneLayoutStore(base.layout['_registry' as never], ctx, undefined, { singleStrip: true });
    layout.open('chat', { id: 'conv' });
    const pane = layout.groups[0].pane as PaneStore;
    const chatTabId = pane.tabOrder[0];
    layout.setPairAnchor(() => ({ paneId: layout.groups[0].paneId, tabId: chatTabId }));
    const idOf = (kind: string, id: string) =>
      [...pane.entries.values()].find((e) => e.kind === kind && (e.state as { id: string }).id === id)?.tabId;
    const label = (tabId: string | undefined) => {
      const entry = tabId ? pane.entries.get(tabId) : undefined;
      return entry ? `${entry.kind}:${(entry.state as { id: string }).id}` : String(tabId);
    };
    return {
      layout,
      pane,
      chatTabId,
      idOf,
      shown: () => pane.shownTabIds.map(label),
      strip: () => pane.tabOrder.map(label),
    };
  }

  it('右键「向右分」= 和屏上那页并排,❌ 再分出一格带自己的页签条', () => {
    const { layout, pane, idOf, shown } = single();
    layout.open('term', { id: 't1' }, { activate: false });
    pane.splitTab(idOf('term', 't1')!, 'right');
    expect(layout.groups).toHaveLength(1);
    expect(shown()).toEqual(['chat:conv', 'term:t1']);
    expect(pane.activeTabId).toBe(idOf('term', 't1'));
  });

  it.each(['right', 'left', 'top', 'bottom'] as const)('replacing the %s side only inserts the incoming tab; the outgoing tab keeps its neighbors', (edge) => {
    const { layout, pane, idOf } = single();
    for (const id of ['anchor', 'old', 'between', 'incoming', 'last']) layout.open('term', { id }, { activate: false });
    const anchor = idOf('term', 'anchor')!, old = idOf('term', 'old')!, incoming = idOf('term', 'incoming')!;
    pane.setActiveTab(anchor);
    pane.splitBeside(old, edge);
    const before = [...pane.tabOrder];
    pane.setActiveTab(incoming);
    expect(pane.tabOrder.filter((id) => id !== incoming)).toEqual(before.filter((id) => id !== incoming));
    expect(Math.abs(pane.tabOrder.indexOf(incoming) - pane.tabOrder.indexOf(anchor))).toBe(1);
    expect(pane.livePair?.side).toBe(incoming);
    const replaced = [...pane.tabOrder];
    pane.setActiveTab(old);
    expect(pane.tabOrder.filter((id) => id !== old)).toEqual(replaced.filter((id) => id !== old));
  });

  it('opening beside the anchor and closing a tab preserve the remaining order', () => {
    const { layout, pane, idOf } = single();
    for (const id of ['old', 'middle', 'last']) layout.open('term', { id }, { activate: false });
    pane.splitBeside(idOf('term', 'old')!, 'right');
    const before = [...pane.tabOrder];
    layout.open('file', { id: 'new.ts' }, { beside: true, activate: false });
    const added = idOf('file', 'new.ts')!;
    expect(pane.tabOrder.filter((id) => id !== added)).toEqual(before);
    const middle = idOf('term', 'middle')!;
    pane.closeTab(middle);
    expect(pane.tabOrder.filter((id) => id !== added)).toEqual(before.filter((id) => id !== middle));
  });

  it('drag previews use the final pair-aware insertion without mutating the stored order', () => {
    const { layout, pane, idOf } = single();
    for (const id of ['old', 'middle', 'last']) layout.open('term', { id }, { activate: false });
    pane.splitBeside(idOf('term', 'old')!, 'right');
    const before = [...pane.tabOrder];
    const preview = pane.previewTabOrder(1, 3);
    expect(pane.tabOrder).toEqual(before);
    expect(preview).not.toEqual(before);
    pane.reorderTabs(1, 3);
    expect(pane.tabOrder).toEqual(preview);
    expect(pane.tabOrder.slice(-2)).toEqual(before.slice(0, 2));
  });

  it('同一种页签也能并排:两个文件', () => {
    const { layout, pane, idOf, shown } = single();
    layout.open('file', { id: 'a.ts' });
    layout.open('file', { id: 'b.ts' }, { activate: false });
    pane.splitTab(idOf('file', 'b.ts')!, 'right');
    expect(shown()).toEqual(['file:a.ts', 'file:b.ts']);
  });

  it('向下分 = 上下叠着;拖到左边 / 上边 = 摆在那一边,页签条上的先后跟着屏上', () => {
    const { layout, pane, idOf, shown, strip } = single();
    layout.open('term', { id: 't1' }, { activate: false });
    pane.setActiveTab(pane.tabOrder[0]);
    pane.splitTab(idOf('term', 't1')!, 'bottom');
    expect(pane.pairSlots?.vertical).toBe(true);
    expect(shown()).toEqual(['chat:conv', 'term:t1']);
    pane.splitBeside(idOf('term', 't1')!, 'left');
    expect(pane.pairSlots?.vertical).toBe(false);
    expect(shown()).toEqual(['term:t1', 'chat:conv']);
    expect(strip()).toEqual(['term:t1', 'chat:conv']);
    expect(pane.resolvedTabs.map((t) => t.pairRole)).toEqual(['start', 'end']);
  });

  it('拖到内容区的边上 = 在那一边并排(会话那一格不变成两格)', () => {
    const { layout, pane, idOf, shown } = single();
    layout.open('term', { id: 't1' }, { activate: false });
    layout.handleDragEnd(idOf('term', 't1')!, `pane-edge-top-${layout.groups[0].paneId}`);
    expect(layout.groups).toHaveLength(1);
    expect(shown()).toEqual(['term:t1', 'chat:conv']);
    expect(pane.pairSlots?.vertical).toBe(true);
  });

  it('挪的正是屏上那页:另一边放上一枚看过的', () => {
    const { layout, pane, idOf, shown } = single();
    layout.open('term', { id: 't1' }, { activate: false });
    layout.open('page', { id: 'docs' }, { activate: false });
    pane.setActiveTab(idOf('term', 't1')!);
    pane.splitTab(idOf('term', 't1')!, 'right');
    expect(shown()).toEqual(['chat:conv', 'term:t1']);
  });

  it('并排着再分一页:它顶替另一页,钉住的那页不动', () => {
    const { layout, pane, idOf, shown } = single();
    layout.open('file', { id: 'a.ts' }, { beside: true, activate: false });
    layout.open('term', { id: 't1' }, { activate: false });
    pane.splitTab(idOf('term', 't1')!, 'bottom');
    expect(shown()).toEqual(['chat:conv', 'term:t1']);
    expect(pane.pairSlots?.vertical).toBe(true);
  });

  it('只有一页、太窄 / 太矮:分不出来,说为什么', () => {
    const { layout, pane, idOf } = single();
    expect(pane.tabSplitBlocked(pane.tabOrder[0], 'right')).toBe('only-tab');
    layout.open('term', { id: 't1' }, { activate: false });
    pane.setDimensions(400, 900);
    expect(pane.tabSplitBlocked(idOf('term', 't1')!, 'right')).toBe('too-small');
    expect(pane.tabSplitBlocked(idOf('term', 't1')!, 'bottom')).toBeNull();
  });

  it('拆开 = 不分屏:之后 agent 打开的只多一枚页签、不切走;人点开的切过去,也不并排', () => {
    const { layout, pane, chatTabId, idOf, shown } = single();
    layout.open('file', { id: 'a.ts' }, { beside: true, activate: false });
    pane.separatePair();
    expect(shown()).toEqual(['chat:conv']);
    layout.open('page', { id: 'docs' }, { beside: true, activate: false });
    expect(pane.livePair).toBeNull();
    expect(pane.activeTabId).toBe(chatTabId);
    expect(idOf('page', 'docs')).toBeDefined();
    layout.open('term', { id: 't1' }, { beside: true });
    expect(pane.livePair).toBeNull();
    expect(shown()).toEqual(['term:t1']);
  });

  it('拆开之后自己再分屏:agent 打开的又开在对话旁边', () => {
    const { layout, pane, idOf, shown } = single();
    layout.open('file', { id: 'a.ts' }, { beside: true, activate: false });
    pane.separatePair();
    pane.splitTab(idOf('file', 'a.ts')!, 'right');
    expect(pane.splitDeclined).toBe(false);
    pane.setActiveTab(pane.tabOrder[0]);
    layout.open('page', { id: 'docs' }, { beside: true, activate: false });
    expect(shown()).toEqual(['chat:conv', 'page:docs']);
  });

  it('关掉另一页 ≠ 拆开:下次 agent 打开照样并排', () => {
    const { layout, pane, idOf, shown } = single();
    layout.open('file', { id: 'a.ts' }, { beside: true, activate: false });
    pane.closeTab(idOf('file', 'a.ts')!);
    expect(pane.splitDeclined).toBe(false);
    layout.open('page', { id: 'docs' }, { beside: true, activate: false });
    expect(shown()).toEqual(['chat:conv', 'page:docs']);
  });

  it('⌘\\:没并排 = 和上一枚看过的并排(左右照页签条上的先后);并排着 = 拆开', () => {
    const { layout, pane, idOf, shown, strip } = single();
    layout.open('term', { id: 't1' });
    pane.toggleSplit();
    expect(shown()).toEqual(['chat:conv', 'term:t1']);
    expect(strip()).toEqual(['chat:conv', 'term:t1']);
    expect(pane.activeTabId).toBe(idOf('term', 't1'));
    pane.toggleSplit();
    expect(pane.livePair).toBeNull();
    expect(pane.splitDeclined).toBe(true);
    expect(pane.activeTabId).toBe(idOf('term', 't1'));
  });

  it('摆法和「拆开过」存下来、读回来照旧', () => {
    const { layout, pane, idOf } = single();
    layout.open('term', { id: 't1' }, { activate: false });
    pane.splitTab(idOf('term', 't1')!, 'bottom');
    const saved = layout.snapshot;
    expect(saved.groups[0].tabManager.pair?.sideAt).toBe('bottom');
    const again = single();
    again.layout.restoreSnapshot(saved);
    expect(again.layout.groups[0].pane.pairSlots?.vertical).toBe(true);
    pane.separatePair();
    expect(layout.snapshot.groups[0].tabManager.splitDeclined).toBe(true);
    const third = single();
    third.layout.restoreSnapshot(layout.snapshot);
    expect(third.layout.groups[0].pane.splitDeclined).toBe(true);
  });

  it('以前分成上下两格的存档:合成一条页签条,两格屏上那页上下并排回来,份额照旧', () => {
    const { layout } = single();
    layout.restoreSnapshot({
      groups: [
        { groupId: 'g1', tabManager: { tabs: [{ kind: 'extension', extensionKind: 'chat', tabId: 'c', isPreview: false, state: { id: 'conv' } }], activeTabId: 'c' } },
        {
          groupId: 'g2',
          tabManager: {
            tabs: [
              { kind: 'extension', extensionKind: 'term', tabId: 't', isPreview: false, state: { id: 't1' } },
              { kind: 'extension', extensionKind: 'page', tabId: 'p', isPreview: false, state: { id: 'docs' } },
            ],
            activeTabId: 'p',
          },
        },
      ],
      activeGroupId: 'g2',
      paneSizes: [70, 30],
      layout: { split: 'vertical', sizes: [70, 30], children: [{ pane: 'g1' }, { pane: 'g2' }] },
    } as never);
    expect(layout.groups).toHaveLength(1);
    const pane = layout.groups[0].pane;
    expect(pane.tabOrder).toEqual(['c', 'p', 't']);
    expect(pane.livePair).toEqual({ anchor: 'c', side: 'p', sideAt: 'bottom', ratio: null });
    expect(pane.activeTabId).toBe('p');
  });

  it('对话被摆到了另一边,agent 再打开:顶替另一页,摆法不动,从此钉住对话', () => {
    const { layout, pane, chatTabId, idOf, shown, strip } = single();
    layout.open('file', { id: 'a.ts' }, { preview: false });
    pane.splitTab(chatTabId, 'right');
    expect(shown()).toEqual(['file:a.ts', 'chat:conv']);
    pane.setPairRatio(0.7);
    layout.open('page', { id: 'docs' }, { beside: true, activate: false });
    expect(shown()).toEqual(['page:docs', 'chat:conv']);
    expect(pane.livePair).toMatchObject({ anchor: chatTabId, side: idOf('page', 'docs'), ratio: 0.7 });
    // 被顶下来的退成普通页签,❌ 和对话连成一对。
    expect(strip()).toEqual(['file:a.ts', 'page:docs', 'chat:conv']);
  });

  it('点页签条打头的对话:它还在打头、摆到左边,钉住的那页挨在后面,两页宽窄照旧', () => {
    const { layout, pane, chatTabId, idOf, shown, strip } = single();
    layout.open('term', { id: 't1' });
    layout.open('page', { id: 'docs' }, { preview: false, activate: false });
    pane.splitTab(idOf('page', 'docs')!, 'right');
    pane.setPairRatio(0.7);
    expect(strip()).toEqual(['chat:conv', 'term:t1', 'page:docs']);
    pane.setActiveTab(chatTabId);
    expect(strip()).toEqual(['chat:conv', 'term:t1', 'page:docs']);
    expect(shown()).toEqual(['chat:conv', 'term:t1']);
    expect(pane.livePair?.ratio).toBeCloseTo(0.3);
  });

  it('task and group layouts keep a refocused first conversation pinned by the same pairing rule', () => {
    const outputs = (['session', 'chat'] as const).map((host) => {
      const conversation = host === 'session' ? 'acp-chat' : 'chat';
      const view = createTabView([provider(conversation, 'single'), provider('term', 'single')]);
      const layout = view.createPaneLayoutStore({ viewId: host, place: host === 'session'
        ? { kind: 'session', sessionId: 'task', projectId: 'project' }
        : { kind: 'chat', chatId: 'group' } }, { singleStrip: true });
      layout.open(conversation, { id: 'Conversation' });
      const pane = layout.groups[0].pane;
      for (const id of ['X', 'Anchor', 'Y']) layout.open('term', { id }, { activate: false });
      const idOf = (name: string) => [...pane.entries.values()].find(entry => (entry.state as { id: string }).id === name)!.tabId;
      const labels = () => pane.tabOrder.map(id => (pane.entries.get(id)!.state as { id: string }).id);
      layout.setPairAnchor(() => ({ paneId: layout.groups[0].paneId, tabId: idOf('Conversation') }));
      pane.setActiveTab(idOf('Anchor'));
      pane.splitBeside(idOf('Y'), 'right');
      expect(labels()).toEqual(['Conversation', 'X', 'Anchor', 'Y']);
      pane.setActiveTab(idOf('Conversation'));
      const output = { order: labels(), sideAt: pane.livePair?.sideAt, ratio: pane.livePair?.ratio };
      layout.dispose();
      return output;
    });
    expect(outputs[0]).toEqual(outputs[1]);
    expect(outputs[0]).toEqual({ order: ['Conversation', 'Anchor', 'X', 'Y'], sideAt: 'left', ratio: null });
  });

  it('拖一对里的一枚:它落在松手处,另一枚跟过去,❌ 弹回原处', () => {
    const { layout, pane, idOf, strip } = single();
    layout.open('term', { id: 't1' }, { activate: false });
    layout.open('page', { id: 'docs' }, { activate: false });
    layout.open('file', { id: 'a.ts' }, { beside: true, activate: false });
    expect(strip()).toEqual(['chat:conv', 'file:a.ts', 'term:t1', 'page:docs']);
    pane.reorderTabs(pane.tabOrder.indexOf(idOf('file', 'a.ts')!), 3);
    expect(strip()).toEqual(['term:t1', 'page:docs', 'chat:conv', 'file:a.ts']);
  });

  it('换摆法、前一格换了一页:两页宽窄照旧', () => {
    const { layout, pane, idOf } = single();
    layout.open('file', { id: 'a.ts' }, { beside: true, activate: false });
    pane.setPairRatio(0.7);
    pane.splitBeside(idOf('file', 'a.ts')!, 'left');
    expect(pane.pairSlots?.first).toBe(idOf('file', 'a.ts'));
    expect(pane.livePair?.ratio).toBeCloseTo(0.3);
  });

  it('看着这一对之外的页签按 ⌘\\ = 和上一枚看过的分屏,❌ 拆开一对屏上看不见的', () => {
    const { layout, pane, idOf, shown } = single();
    layout.open('term', { id: 't1' });
    layout.open('file', { id: 'a.ts' }, { beside: true, activate: false });
    expect(pane.activeTabId).toBe(idOf('term', 't1'));
    pane.toggleSplit();
    expect(pane.splitDeclined).toBe(false);
    expect(shown()).toEqual(['chat:conv', 'term:t1']);
  });

  it('重开关掉的页签落在一对中间:一对重新挨着', () => {
    const { layout, pane, idOf, strip } = single();
    layout.open('term', { id: 't1' }, { activate: false });
    pane.closeTab(idOf('term', 't1')!);
    layout.open('file', { id: 'a.ts' }, { beside: true, activate: false });
    pane.setDimensions(300, 900);
    pane.reopenClosedTab();
    expect(strip()).toEqual(['chat:conv', 'file:a.ts', 'term:t1']);
  });

  it('两个文件并排:「屏上那个文件」是点着的那一边', () => {
    const { layout, pane, idOf } = single();
    layout.open('file', { id: 'a.ts' });
    layout.open('file', { id: 'b.ts' }, { activate: false });
    pane.splitTab(idOf('file', 'b.ts')!, 'right');
    expect(pane.activeEntryOfKind('file')?.tabId).toBe(idOf('file', 'b.ts'));
    pane.setActiveTab(idOf('file', 'a.ts')!);
    expect(pane.activeEntryOfKind('file')?.tabId).toBe(idOf('file', 'a.ts'));
  });
});

describe('并排:同一种页签时另一页单独挂一份内容', () => {
  it('两个文件并排:另一页那份只看得到它那一枚,原来那份看不到它;换了另一页,两份跟着变', () => {
    const { layout, pane, idOf } = setup();
    layout.open('file', { id: 'a.ts' });
    layout.open('file', { id: 'b.ts' }, { activate: false });
    layout.open('file', { id: 'c.ts' }, { activate: false });
    const rest = paneSlotView(pane, 'rest');
    const side = paneSlotView(pane, 'side');
    // 还没并排:原来那份就是这一格本身。
    expect(rest.resolvedTabs).toHaveLength(pane.resolvedTabs.length);
    pane.splitTab(idOf('file', 'b.ts')!, 'right');
    expect(side.activeEntryOfKind('file')?.tabId).toBe(idOf('file', 'b.ts'));
    expect(rest.activeEntryOfKind('file')?.tabId).toBe(idOf('file', 'a.ts'));
    expect(rest.resolvedTabs.some((t) => t.tabId === idOf('file', 'b.ts'))).toBe(false);
    expect(side.resourcesOfKind('file')).toHaveLength(1);
    pane.setActiveTab(idOf('file', 'c.ts')!);
    expect(side.activeEntryOfKind('file')?.tabId).toBe(idOf('file', 'c.ts'));
    expect(rest.resolvedTabs.some((t) => t.tabId === idOf('file', 'b.ts'))).toBe(true);
    // 焦点、动作照原样转给这一格。
    expect(side.resolvedActiveTabId).toBe(pane.resolvedActiveTabId);
  });

  it('两页不是同一种:另一页那份什么都看不到,原来那份就是这一格', () => {
    const { layout, pane } = setup();
    layout.open('file', { id: 'a.ts' }, { beside: true, activate: false });
    const side = paneSlotView(pane, 'side');
    const rest = paneSlotView(pane, 'rest');
    expect(side.resolvedTabs).toHaveLength(0);
    expect(rest.shownTabIds).toEqual(pane.shownTabIds);
    // 只改列出来的几样:原型上的 toString 之类照原样取。
    expect(() => String(rest)).not.toThrow();
  });
});

describe('并排:页面自己声明在对话旁边多宽(sideWidth,owner 10-26)', () => {
  function declared() {
    const sized = (kind: string, px: number) => ({ ...provider(kind, 'single'), sideWidth: () => px });
    const registry = createTabRegistry([provider('chat', 'single'), sized('folder', 480), sized('info', 360), provider('file', 'single')] as const);
    const layout = new PaneLayoutStore(registry, ctx);
    layout.open('chat', { id: 'conv' });
    const group = layout.groups[0];
    const chatTabId = group.pane.tabOrder[0];
    layout.setPairAnchor(() => ({ paneId: group.paneId, tabId: chatTabId }));
    const pane = group.pane as PaneStore;
    pane.setDimensions(1600, 900);
    const sideWidth = () => Math.round((1 - pane.pairShare) * 1600);
    return { layout, pane, chatTabId, sideWidth };
  }

  it('声明了宽的那页照它的像素;两页对等(都没声明)一半一半;至多一半', () => {
    const { layout, pane, sideWidth } = declared();
    layout.open('folder', { id: 'f' }, { beside: true });
    expect(sideWidth()).toBe(480);
    layout.open('file', { id: 'a.md' }, { beside: true });
    expect(pane.pairShare).toBe(0.5);
    pane.setDimensions(600, 900);
    layout.open('folder', { id: 'f' }, { beside: true });
    expect(pane.pairShare).toBe(0.5);
  });

  it('文件夹 → 群信息 → 文件夹:换进来的页用它自己声明的宽,❌ 接着用上一页拖出来的比例;双击分界回到声明', () => {
    const { layout, pane, sideWidth } = declared();
    layout.open('folder', { id: 'f' }, { beside: true });
    pane.setPairRatio(0.5);
    expect(sideWidth()).toBe(800);
    layout.open('info', { id: 'i' }, { beside: true });
    expect(sideWidth()).toBe(360);
    layout.open('folder', { id: 'f' }, { beside: true });
    expect(sideWidth()).toBe(480);
    pane.setPairRatio(0.6);
    expect(sideWidth()).toBe(640);
    pane.setPairRatio(null);
    expect(sideWidth()).toBe(480);
  });

  it('没拖过的存档不记比例,读回来照声明;10-26 之前存的 ratio 一律不读(断代),也照声明', () => {
    const { layout, pane, chatTabId } = declared();
    layout.open('folder', { id: 'f' }, { beside: true });
    const saved = layout.snapshot;
    expect(saved.groups[0].tabManager.pair).not.toHaveProperty('share');
    const old = { ...saved, groups: [{ ...saved.groups[0], tabManager: { ...saved.groups[0].tabManager, pair: { anchorTabId: chatTabId, sideTabId: pane.livePair!.side, ratio: 0.62 } as never } }] };
    const again = declared();
    again.layout.restoreSnapshot(old);
    again.layout.groups[0].pane.setDimensions(1600, 900);
    expect(again.layout.groups[0].pane.livePair?.ratio).toBeNull();
    expect(Math.round((1 - again.layout.groups[0].pane.pairShare) * 1600)).toBe(480);
  });

  it('页签上的「最大化 / 还原」:并排那一页 = 拆开它占满;拆开后点着的它 = 回到对话旁边;对话那一枚没有', () => {
    const { layout, pane, chatTabId } = declared();
    layout.open('folder', { id: 'f' }, { beside: true });
    const side = pane.livePair!.side;
    expect(pane.tabFill(chatTabId)).toBeNull();
    expect(pane.tabFill(side)?.full).toBe(false);
    pane.tabFill(side)!.toggle();
    expect(pane.shownTabIds).toEqual([side]);
    expect(pane.tabFill(side)?.full).toBe(true);
    pane.tabFill(side)!.toggle();
    expect(pane.shownTabIds).toEqual([chatTabId, side]);
  });
});
