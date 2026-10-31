// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { Command } from 'cmdk';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { conversationLink } from '@gugu/core/shared/ui/guguLink';
import { messageQuoteLink } from '@gugu/core/shared/ui/messageQuote';
import { publishChatSummaries } from '@/lib/chatSummariesBridge';
import { takeTaskReveal } from '@/hooks/useSourceMessageReveal';
import type { TaskTurnHit } from '@shared/core/search';
import { PaletteContentGroups, type PaletteScope } from './palette-content-groups';

const remote = vi.hoisted(() => ({
  opened: [] as unknown[],
  turns: vi.fn(),
  messages: vi.fn(),
}));
vi.mock('@/lib/guguLinks', () => ({ followLink: (target: unknown) => { remote.opened.push(target); return true; } }));
vi.mock('@renderer/lib/ipc', () => ({ rpc: { search: { taskTurns: remote.turns } } }));
vi.mock('@/lib/supabase', () => ({ chatDb: { rpc: remote.messages } }));
vi.mock('@renderer/localization/use-session-messages', () => ({ useSessionMessages: () => ({ translate: (key: string) => key }) }));

globalThis.ResizeObserver ??= class { observe() {} unobserve() {} disconnect() {} } as unknown as typeof ResizeObserver;
Element.prototype.scrollIntoView ??= () => {};

const CHAT = '0b1e7c1a-0000-4000-8000-000000000001';
const MESSAGE = '0b1e7c1a-0000-4000-8000-0000000000aa';
const turn: TaskTurnHit = { sessionId: 's1', projectId: 'p1', title: '登录修复', archived: false, itemId: 's1:turn:s3:m', role: 'assistant', excerpt: '登录页已经修好了', at: '2026-10-31 00:00:00' };

let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  remote.opened = [];
  remote.turns.mockReset().mockResolvedValue([turn]);
  remote.messages.mockReset().mockResolvedValue({ data: [{ id: MESSAGE, chat_id: CHAT, sender_name: '阿威', content: '明天一起看登录页' }], error: null });
  publishChatSummaries([{ id: CHAT, kind: 'group', unread_count: 0, name: '咕咕内测群', last_message_at: '2026-10-31T00:00:00Z' }]);
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
});

async function render(query: string, scope: PaletteScope) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  await act(async () => root.render(
    <QueryClientProvider client={client}>
      <Command shouldFilter={false}><Command.List><PaletteContentGroups query={query} scope={scope} groupClassName="" onClose={() => {}} /></Command.List></Command>
    </QueryClientProvider>,
  ));
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
}
const rows = () => [...host.querySelectorAll<HTMLElement>('[cmdk-item]')];

describe('palette task content and message hits', () => {
  it('shows both groups under all, and searches every chat the person is in', async () => {
    await render('登录', 'all');
    expect(rows().map((row) => row.textContent)).toEqual(['登录页已经修好了登录修复', '明天一起看登录页咕咕内测群 · 阿威']);
    expect(remote.turns).toHaveBeenCalledWith({ query: '登录' });
    expect(remote.messages).toHaveBeenCalledWith('message_search_as', { p_chat_id: null, p_query: '登录', p_limit: 5 });
  });

  it('opens a task at the found item, and a chat at the found message', async () => {
    await render('登录', 'all');
    await act(async () => rows()[0]!.click());
    expect(remote.opened).toEqual([{ kind: 'session', sessionId: 's1', projectId: 'p1' }]);
    expect(takeTaskReveal('s1')).toBe(messageQuoteLink({ kind: 'session', sessionId: 's1', itemId: 's1:turn:s3:m' }));
    expect(takeTaskReveal('s1')).toBeUndefined();
    await act(async () => rows()[1]!.click());
    expect(remote.opened[1]).toBe(conversationLink(CHAT, MESSAGE));
  });

  it('asks only the searched source for a narrowed scope', async () => {
    await render('登录', 'taskContent');
    expect(rows()).toHaveLength(1);
    expect(remote.messages).not.toHaveBeenCalled();
    await render('迁移', 'messages');
    expect(remote.turns).not.toHaveBeenCalledWith({ query: '迁移' });
    expect(remote.messages).toHaveBeenCalledWith('message_search_as', { p_chat_id: null, p_query: '迁移', p_limit: 30 });
  });

  it('says the message search failed instead of showing nothing', async () => {
    remote.messages.mockResolvedValue({ data: null, error: { message: 'permission denied for function message_search_as' } });
    await render('登录', 'messages');
    expect(host.querySelector('[role="alert"]')?.textContent).toBe('permission denied for function message_search_as');
  });
});
