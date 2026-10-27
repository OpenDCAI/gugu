import { reaction } from 'mobx';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  installSessionViewRequestBridge,
  REQUEST_TTL_MS,
  SESSION_VIEW_REQUEST_BRIDGE_KEY,
  sessionViewRequests,
  type SessionViewRequestBridge,
} from './session-view-requests';

describe('session view requests (#7167 聊天页模式按钮 → 会话页换展示)', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('a request left unclaimed past its deadline is dropped, not applied late (no surprise dialog)', () => {
    vi.useFakeTimers();
    sessionViewRequests.request('conv-late', 'code');
    vi.advanceTimersByTime(REQUEST_TTL_MS + 1);
    expect(sessionViewRequests.take('conv-late')).toBeUndefined();
    // 作废的也拿走了,不会一直挂着。
    expect(sessionViewRequests.pendingIds()).not.toContain('conv-late');
  });

  it('a request waits until a page takes it, and is taken exactly once', () => {
    sessionViewRequests.request('conv-1', 'code');
    expect(sessionViewRequests.pendingIds()).toContain('conv-1');
    expect(sessionViewRequests.take('conv-1')).toBe('code');
    // 认领即删:第二个认领者拿不到同一条(两份 provider 都挂着时只弹一个确认框)。
    expect(sessionViewRequests.take('conv-1')).toBeUndefined();
    expect(sessionViewRequests.pendingIds()).not.toContain('conv-1');
  });

  it('a later request for the same session replaces the earlier one (the last pick wins)', () => {
    sessionViewRequests.request('conv-2', 'code');
    sessionViewRequests.request('conv-2', 'general');
    expect(sessionViewRequests.take('conv-2')).toBe('general');
  });

  it('pending ids are observable: a page that loads later still sees a request made before it', () => {
    const seen: string[][] = [];
    const dispose = reaction(() => sessionViewRequests.pendingIds(), (ids) => seen.push(ids));
    sessionViewRequests.request('conv-3', 'general');
    dispose();
    expect(seen.at(-1)).toContain('conv-3');
    sessionViewRequests.take('conv-3');
  });

  it('the bridge the chat side reads is installed on window under the shared key', () => {
    const target = {} as Window;
    const opened: Array<[string, boolean]> = [];
    installSessionViewRequestBridge(target, {
      openChat: (chatId, beside) => opened.push([chatId, beside]),
    });
    const bridge = (target as unknown as Record<string, SessionViewRequestBridge>)[SESSION_VIEW_REQUEST_BRIDGE_KEY];
    bridge.request('conv-4', 'code');
    expect(sessionViewRequests.take('conv-4')).toBe('code');
    // gugu-dev#181 打开一条对话交给装桥时接上的那一下(这屏)。
    bridge.openChat('chat-1', true);
    expect(opened).toEqual([['chat-1', true]]);
  });
});
