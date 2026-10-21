import { beforeEach, describe, expect, it, vi } from 'vitest';

const modal = vi.hoisted(() => ({ last: null as null | Record<string, (...args: unknown[]) => void> & { description?: string } }));
const view = vi.hoisted(() => ({ layout: null as unknown }));

vi.mock('@renderer/lib/modal/modal-provider', () => ({
  showModal: (_id: string, args: Record<string, (...a: unknown[]) => void>) => {
    modal.last = args;
  },
}));
vi.mock('./stores/session-selectors', () => ({
  getSessionView: () => (view.layout ? { paneLayout: view.layout } : undefined),
}));
vi.mock('@renderer/localization/locale-store', () => ({
  translateSessionMessage: (key: string, values?: Record<string, unknown>) =>
    values ? `${key}:${JSON.stringify(values)}` : key,
}));

import { confirmCloseSessionTab } from './close-session-tab-flow';

const ctx = { viewId: 'v', projectId: 'p', sessionId: 's1', workspaceId: 'w', modelRootPath: 'm' };

/** 一块会话:左边一格(会话自己那枚 + 侧边聊天),右边一格(浏览器)。 */
function layout() {
  const closed: string[] = [];
  const pane = (tabs: Array<[string, string, unknown]>) => ({
    tabOrder: tabs.map(([id]) => id),
    entries: new Map(tabs.map(([id, kind, state]) => [id, { kind, state }])),
    requestCloseTabs: async (ids: readonly string[]) => {
      closed.push(...ids);
    },
  });
  return {
    closed,
    groups: [
      { pane: pane([['own', 'session', { sessionId: 's1' }], ['side', 'side-chat', {}]]) },
      { pane: pane([['web', 'browser', {}]]) },
    ],
  };
}

describe('关掉会话自己那枚页签:它还开着别的页签就问「会话和页签都关 / 只关会话」(#7097)', () => {
  beforeEach(() => {
    modal.last = null;
    view.layout = null;
  });

  it('会话和页签都关:先把别的页签一枚枚关掉,再关它自己', async () => {
    const l = layout();
    view.layout = l;
    const answer = confirmCloseSessionTab('s1', ctx, { alone: true });
    expect(modal.last?.description).toContain('"count":2');
    modal.last!.onSuccess({});
    expect(await answer).toBe(true);
    expect(l.closed).toEqual(['side', 'web']);
  });

  it('只关会话:别的页签不动;Esc / 点外面:什么都不关', async () => {
    const l = layout();
    view.layout = l;
    const only = confirmCloseSessionTab('s1', ctx, { alone: true });
    modal.last!.onCancel();
    expect(await only).toBe(true);
    expect(l.closed).toEqual([]);

    const dismissed = confirmCloseSessionTab('s1', ctx, { alone: true });
    modal.last!.onClose();
    expect(await dismissed).toBe(false);
    expect(l.closed).toEqual([]);
  });

  it('选了「会话和页签都关」以后弹窗收起,❌ 被当成「不关」', async () => {
    const l = layout();
    view.layout = l;
    const answer = confirmCloseSessionTab('s1', ctx, { alone: true });
    modal.last!.onSuccess({});
    modal.last!.onClose();
    expect(await answer).toBe(true);
  });

  it('不问的三种:一排里关、开在这里的子会话那枚、它没开别的页签', () => {
    view.layout = layout();
    expect(confirmCloseSessionTab('s1', ctx, { alone: false })).toBe(true);
    expect(confirmCloseSessionTab('child', ctx, { alone: true })).toBe(true);
    view.layout = { groups: [{ pane: { tabOrder: ['own'], entries: new Map([['own', { kind: 'session', state: { sessionId: 's1' } }]]), requestCloseTabs: async () => {} } }] };
    expect(confirmCloseSessionTab('s1', ctx, { alone: true })).toBe(true);
    expect(modal.last).toBeNull();
  });
});
