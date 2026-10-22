// @vitest-environment jsdom
import { Command } from 'cmdk';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { conversationLink } from '@gugu/core/shared/ui/conversationLink';
import { publishChatSummaries } from '@/lib/chatSummariesBridge';
import { PaletteChatGroups } from './palette-chats';

// gugu-dev#181 ⑯ ⌘K 面板里的对话和话题:按名字、最后一句就地筛;选中一条 = 点它的对话链接(壳的 openChatBlock 那一处:
// 话题 = 源对话 + 分栏,项目群开项目块)。项目群不在这里(它在「项目」里)。
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
    { id: 'g-src', kind: 'group', name: '咕咕内测群', last_message_at: '2026-10-23T00:00:00Z', last_message_preview: 'Windows 包装上了' },
    { id: 'dm-1', kind: 'dm', name: '阿威', last_message_at: '2026-10-22T00:00:00Z', last_message_preview: '周四前对一下新手引导' },
    { id: TOPIC, kind: 'topic', name: '登录页白屏', source_chat_id: 'g-src', last_message_at: '2026-10-22T00:00:00Z' },
    { id: 'g-project', kind: 'group', name: '官网', last_message_at: '2026-10-23T00:00:00Z' },
  ]);
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

describe('the ⌘K panel’s chats and topics', () => {
  it('lists recent chats without project groups or topics when empty', async () => {
    await render('');
    expect(rows()).toEqual(['咕咕内测群palette.groupChat', '阿威palette.directChat']);
  });

  it('finds a chat by its last line and a topic by its name', async () => {
    await render('新手');
    expect(rows()).toEqual(['阿威周四前对一下新手引导']);
    await render('白屏');
    expect(rows()).toEqual(['登录页白屏palette.topicIn:咕咕内测群']);
  });

  it('opens a topic the way its conversation link opens', async () => {
    await render('白屏');
    await act(async () => (host.querySelector('[cmdk-item]') as HTMLElement).click());
    expect(opened.links).toEqual([conversationLink(TOPIC)]);
  });
});
