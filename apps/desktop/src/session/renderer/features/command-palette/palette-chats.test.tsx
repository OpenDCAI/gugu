// @vitest-environment jsdom
import { Command } from 'cmdk';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { UI_EVENTS } from '@/lib/uiEvents';
import { conversationLink } from '@gugu/core/shared/ui/guguLink';
import { publishChatSummaries, publishContactSummaries } from '@/lib/chatSummariesBridge';
import { PaletteChatGroups } from './palette-chats';

// Quick switching searches object names; message contents belong to in-chat find.
const opened = vi.hoisted(() => ({ links: [] as string[] }));
vi.mock('@/lib/conversationLinks', () => ({ openConversationLink: (href: string) => { opened.links.push(href); return true; } }));
vi.mock('@renderer/localization/use-session-messages', () => ({
  useSessionMessages: () => ({ translate: (key: string, values?: { name?: string }) => (values?.name ? `${key}:${values.name}` : key) }),
}));
vi.mock('@renderer/features/projects/stores/project-groups-store', () => ({
  projectGroupsStore: { projectOfChat: (chatId: string) => (chatId === 'g-project' ? 'project-1' : undefined) },
}));

// cmdk 量列表高度用 ResizeObserver、把选中行滚进视野用 scrollIntoView,jsdom 都没有。
globalThis.ResizeObserver ??= class { observe() {} unobserve() {} disconnect() {} } as unknown as typeof ResizeObserver;
Element.prototype.scrollIntoView ??= () => {};
const TOPIC = '0b1e7c1a-0000-4000-8000-000000000002';

let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  opened.links = [];
  publishChatSummaries([
    { id: '0b1e7c1a-0000-4000-8000-000000000001', kind: 'group', name: '咕咕内测群', last_message_at: '2026-10-23T00:00:00Z', last_message_preview: 'Windows 包装上了' },
    { id: 'dm-1', kind: 'dm', name: '阿威', last_message_at: '2026-10-22T00:00:00Z', last_message_preview: '周四前对一下新手引导' },
    { id: TOPIC, kind: 'topic', name: '登录页白屏', source_chat_id: '0b1e7c1a-0000-4000-8000-000000000001', last_message_at: '2026-10-22T00:00:00Z' },
    { id: 'g-project', kind: 'group', name: '官网', last_message_at: '2026-10-23T00:00:00Z' },
  ]);
  publishContactSummaries([{ id: 'person-1', name: '阿威' }]);
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
});

async function render(query: string) {
  await act(async () => root.render(
    <Command shouldFilter={false}><Command.List><PaletteChatGroups query={query} groupClassName="" onClose={() => {}} /></Command.List></Command>,
  ));
}
const rows = () => [...host.querySelectorAll('[cmdk-item]')].map((row) => row.textContent);

describe('quick switcher groups and contacts', () => {
  it('lists groups and contacts, with project groups represented by projects', async () => {
    await render('');
    expect(rows()).toEqual(['咕咕内测群', '阿威']);
  });

  it('filters object names and leaves message contents and topics to their own searches', async () => {
    await render('内测');
    expect(rows()).toEqual(['咕咕内测群']);
    await render('阿威');
    expect(rows()).toEqual(['阿威']);
    await render('新手');
    expect(rows()).toEqual([]);
    await render('白屏');
    expect(rows()).toEqual([]);
  });

  it('opens a group through the existing conversation link', async () => {
    await render('内测');
    await act(async () => (host.querySelector('[cmdk-item]') as HTMLElement).click());
    expect(opened.links).toEqual([conversationLink('0b1e7c1a-0000-4000-8000-000000000001')]);
  });

  it('selects the existing contact details without creating a conversation', async () => {
    const openContact = vi.fn();
    window.addEventListener(UI_EVENTS.openContact, openContact);
    try {
      await render('阿威');
      await act(async () => (host.querySelector('[cmdk-item]') as HTMLElement).click());
      expect(openContact.mock.calls[0][0].detail).toBe('person-1');
      expect(opened.links).toEqual([]);
    } finally {
      window.removeEventListener(UI_EVENTS.openContact, openContact);
    }
  });
});
