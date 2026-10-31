import { observable, runInAction } from 'mobx';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ExtensionManifest } from '@shared/extensions/manifest';

vi.mock('@renderer/lib/ipc', () => ({
  rpc: { extensions: { list: vi.fn() } },
  events: { on: vi.fn(() => () => {}) },
}));

const { startAppPlacementSync } = await import('./app-placement-sync');
const { appPlacementStore } = await import('./app-placement-store');
const { installedExtensionsStore } = await import('./installed-extensions-store');

function manifest(id: string, tabNames: string[], opensFiles?: unknown, perSession?: true): ExtensionManifest {
  return {
    id,
    name: id,
    version: '1.0.0',
    defaultLocale: 'en',
    entry: 'index.html',
    contributes: { tabs: tabNames.map((name) => ({ name, title: name, ...(opensFiles ? { opensFiles } : {}), ...(perSession ? { perSession } : {}) })) },
  } as unknown as ExtensionManifest;
}

/** 一条会话的假布局:这条同步只碰 `groups[].pane.{tabOrder,entries,closeTab}`。 */
function fakeSession() {
  const tabOrder = observable.array<string>([]);
  const entries = observable.map<string, { kind: string; state?: unknown }>();
  const pane = {
    tabOrder,
    entries,
    closeTab: (tabId: string) =>
      runInAction(() => {
        tabOrder.remove(tabId);
        entries.delete(tabId);
      }),
  };
  const add = (tabId: string, kind: string, state?: unknown) =>
    runInAction(() => {
      tabOrder.push(tabId);
      entries.set(tabId, { kind, state });
    });
  return { layout: { groups: [{ paneId: 'p1', pane }] } as never, add, tabs: () => [...tabOrder] };
}

// #7052 behavior tab-extensions「一个 App 只有一份、放在哪就在哪」。
describe('startAppPlacementSync', () => {
  beforeEach(() => {
    for (const kind of [...appPlacementStore.placements.keys()]) appPlacementStore.take(kind);
    runInAction(() => {
      installedExtensionsStore.manifests = [
        manifest('timer', ['main']),
        manifest('kanban', ['board'], { session: ['.kanban.json'] }),
        manifest('computer', ['screen'], undefined, true),
      ];
    });
  });

  it('摆在这条会话的 App 页签留着;摆在别处、哪都没摆的收掉 —— 对话与内置页签不碰', () => {
    appPlacementStore.place('timer.main', { projectId: 'p', sessionId: 'a' });
    const a = fakeSession();
    a.add('chat', 'acp-chat', { sessionId: 'a' });
    a.add('t', 'timer.main', {});
    const stopA = startAppPlacementSync(a.layout, 'a');
    expect(a.tabs()).toEqual(['chat', 't']);

    // 改版前存下的布局:每条会话都有一枚 App 页签。读回来不是摆在这里的,收掉。
    const b = fakeSession();
    b.add('chat', 'acp-chat', { sessionId: 'b' });
    b.add('t', 'timer.main', { instanceId: 'old' });
    const stopB = startAppPlacementSync(b.layout, 'b');
    expect(b.tabs()).toEqual(['chat']);
    stopA();
    stopB();
  });

  it('放到另一条会话 = 从原来那条拿走:写一下摆放,原来那条自己收掉', () => {
    appPlacementStore.place('timer.main', { projectId: 'p', sessionId: 'a' });
    const a = fakeSession();
    a.add('t', 'timer.main', {});
    const stop = startAppPlacementSync(a.layout, 'a');
    expect(a.tabs()).toEqual(['t']);

    appPlacementStore.place('timer.main', { projectId: 'p', sessionId: 'b' });
    expect(a.tabs()).toEqual([]);
    stop();
  });

  it('为文件开的那种不归它管(一个文件一枚);有文件才有东西看的 App 没有常驻那一枚,有就收', () => {
    appPlacementStore.place('kanban.board', { projectId: 'p', sessionId: 'a' });
    const a = fakeSession();
    a.add('file', 'kanban.board', { filePath: 'todo.kanban.json' });
    a.add('bare', 'kanban.board', {});
    const stop = startAppPlacementSync(a.layout, 'a');
    expect(a.tabs()).toEqual(['file']);
    stop();
  });

  it('#7317 每个任务一份的页签:每条会话都留着自己那一枚,不看摆放 —— 不声明的照旧只留一处(对照)', () => {
    appPlacementStore.place('timer.main', { projectId: 'p', sessionId: 'a' });
    const a = fakeSession();
    a.add('screen', 'computer.screen', {});
    a.add('timer', 'timer.main', {});
    const b = fakeSession();
    b.add('screen', 'computer.screen', {});
    b.add('timer', 'timer.main', {});
    const stopA = startAppPlacementSync(a.layout, 'a');
    const stopB = startAppPlacementSync(b.layout, 'b');
    expect([a.tabs(), b.tabs()]).toEqual([['screen', 'timer'], ['screen']]);
    expect(appPlacementStore.of('computer.screen')).toBeUndefined();
    stopA();
    stopB();
  });

  it('#7317 每个任务一份的页签自己记着:App 清单还没读到(启动时)或 App 已不在,也不收 —— 没记着的照旧收(对照)', () => {
    runInAction(() => {
      installedExtensionsStore.manifests = [];
    });
    const a = fakeSession();
    a.add('mine', 'computer.screen', { perSession: true });
    a.add('unknown', 'computer.screen', {});
    const stop = startAppPlacementSync(a.layout, 'a');
    expect(a.tabs()).toEqual(['mine']);
    stop();
  });

  it('关掉一条会话里那一枚只拿走它在这里的摆放;别处的摆放不受影响', () => {
    appPlacementStore.place('timer.main', { projectId: 'p', sessionId: 'b' });
    appPlacementStore.take('timer.main', { sessionId: 'a' });
    expect(appPlacementStore.of('timer.main')).toEqual({ projectId: 'p', sessionId: 'b' });
    appPlacementStore.take('timer.main', { sessionId: 'b' });
    expect(appPlacementStore.of('timer.main')).toBeUndefined();
  });
});
