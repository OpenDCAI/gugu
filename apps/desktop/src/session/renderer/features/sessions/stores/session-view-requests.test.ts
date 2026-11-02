import { describe, expect, it, vi } from 'vitest';
import {
  SESSION_VIEW_REQUEST_BRIDGE_KEY,
  installSessionViewRequestBridge,
  type SessionViewRequestBridge,
} from './session-view-requests';

describe('session page bridge', () => {
  it('preserves resource intent across the host and session bundle boundary', () => {
    const target = {} as Window;
    const openChat = vi.fn();
    installSessionViewRequestBridge(target, { openChat });
    const bridge = (target as unknown as Record<string, SessionViewRequestBridge>)[SESSION_VIEW_REQUEST_BRIDGE_KEY];
    bridge.openChat('owned-dm', false, 'resource');
    expect(openChat).toHaveBeenCalledWith('owned-dm', false, 'resource');
  });
  it('the bridge the chat side reads is installed on window under the shared key', () => {
    const target = {} as Window;
    const opened: Array<[string, boolean]> = [];
    installSessionViewRequestBridge(target, {
      openChat: (chatId, beside) => opened.push([chatId, beside]),
    });
    const bridge = (target as unknown as Record<string, SessionViewRequestBridge>)[SESSION_VIEW_REQUEST_BRIDGE_KEY];
    // gugu-dev#181 打开一条对话交给装桥时接上的那一下(这屏)。
    bridge.openChat('chat-1', true);
    expect(opened).toEqual([['chat-1', true]]);
  });
});
