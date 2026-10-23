/**
 * #7333 IM 会话列表在母版角色里:行仍是「头像 + 两行」的控件形态(ListRow,圆角 8,❌ 套胶囊 nav),
 * 名字 / 预览 = 紧凑界面 14/20,时间 = 标注 12/18,未读数 = 18 高的墨色计数(反相字),选中 = 中性 --selected,
 * 悬停 = --hover,键盘焦点有环;话题子行名字 14/20,「更多 · N」12/18;「添加联系人」弹层标题 16/24。
 * 渲染的是真 ChatListPanel(共享 testHarness 的会话 store);只换掉设备、agent 在线态与加人搜索体这三处外部依赖。
 */
import { chat, createNode, createReactHarness, displayIdentity, renderWithAppProviders } from '../../../../../../../tests/support/testHarness';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { userEvent } from 'vitest/browser';
import { i18n } from '@/i18n';
import '@/i18n/registerMessagingCatalog';
import '@/i18n/registerMainCatalog';
import '@/styles/tokens.css';
import { until, untilStable } from '../../../../../../../tests/support/awaitCondition';
import { drainTopicSplitRequest } from '@/lib/topicSplitRequest';

vi.mock('@gugu/core/cloud/config', async (original) => ({ ...(await original<object>()), getSupabaseUrl: () => 'http://supabase.test.local', getSupabaseAnonKey: () => 'test-anon-key' }));
vi.mock('@/store/devicesContext', async (original) => ({ ...(await original<object>()), useDevicesStore: () => ({ devices: [] }) }));
vi.mock('@/hooks/useAgentDisplayStatus', async (original) => ({ ...(await original<object>()), useAgentDisplayStatuses: () => ({}) }));
vi.mock('@/components/AddFriendSearch', () => ({ AddFriendSearch: () => null }));

const { ChatListPanel } = await import('@/components/ChatListPanel');

const CAPTION = { size: 12, leading: 18 } as const;
const COMPACT = { size: 14, leading: 20 } as const;
const TITLE = { size: 16, leading: 24 } as const;
const px = (value: string) => Number.parseFloat(value) || 0;
const tier = (element: Element | null | undefined) => {
  if (!element) return null;
  const style = getComputedStyle(element);
  return { size: px(style.fontSize), leading: Math.round(px(style.lineHeight)) };
};
const token = (name: string) => {
  const probe = document.createElement('i');
  probe.style.cssText = `position:absolute;transition:none;background-color:var(${name})`;
  document.body.append(probe);
  const value = getComputedStyle(probe).backgroundColor;
  probe.remove();
  return value;
};

const now = Date.now();
const recent = new Date(now - 5 * 60_000).toISOString();
const longAgo = new Date(now - 60 * 24 * 60 * 60_000).toISOString();
const chats = [
  chat({ id: 'dm-1', kind: 'dm', peer_user_id: 'peer-lin', name: '', avatar: null, last_message_at: recent, last_message_preview: '周六去爬山吗?', unread_count: 3 }),
  chat({ id: 'grp-1', kind: 'group', name: '周末小组', avatar: null, last_message_at: recent, last_message_preview: '好的', member_user_ids: ['peer-lin'] }),
  chat({ id: 't-live', kind: 'topic', name: '去哪儿', source_chat_id: 'grp-1', last_message_at: recent, unread_count: 1 }),
  chat({ id: 't-sunk', kind: 'topic', name: '上个月的事', source_chat_id: 'grp-1', last_message_at: longAgo, unread_count: 0 }),
];

let harness: ReturnType<typeof createReactHarness>;
beforeAll(async () => {
  await i18n.changeLanguage('zh-CN');
});
afterEach(() => harness?.cleanup());

async function renderList(activeChatId = 'grp-1', onChatSelected = vi.fn(), mobile = false) {
  harness = createReactHarness();
  harness.container.style.cssText = 'width: 320px; height: 640px; display: flex;';
  await renderWithAppProviders(
    harness,
    createNode(ChatListPanel, { activeTab: 'chats', mobile, onOpenAgentCreateDraft: vi.fn(), onChatSelected }),
    { chat: { chats, activeChatId, identitiesById: { 'peer-lin': displayIdentity('peer-lin', { display_name: '林知夏' }) } } },
  );
  await until('the chat rows rendered', () => harness.container.querySelector('[data-chat-row="dm-1"]') !== null);
  return harness.container;
}

describe('the IM chat list in the master\'s roles (#7333)', () => {
  it('a sidebar topic activation requests a split toggle on its source', async () => {
    const root = await renderList();
    await userEvent.click(root.querySelector<HTMLElement>('[data-topic-subrow="t-live"]')!);
    expect(drainTopicSplitRequest('grp-1')).toEqual({
      chatId: 't-live', name: '去哪儿', sourceChatId: 'grp-1', focusComposer: true, toggle: true,
    });
  });

  it('#7589 only a source with topics has a chevron; repeated clicks fold all its subrows without navigating', async () => {
    const onChatSelected = vi.fn();
    const root = await renderList('grp-1', onChatSelected);
    const source = () => root.querySelector<HTMLElement>('[data-chat-row="grp-1"]')!;
    const plain = root.querySelector<HTMLElement>('[data-chat-row="dm-1"]')!;
    expect(plain.hasAttribute('aria-expanded')).toBe(false);
    expect(plain.querySelector('button[aria-expanded]')).toBeNull();
    expect(source().getAttribute('aria-expanded')).toBe('true');
    const disclosure = () => source().querySelector<HTMLButtonElement>('button[aria-expanded]')!;
    expect(disclosure().getAttribute('aria-expanded')).toBe('true');
    expect(root.querySelector('[data-topic-subrow="t-live"]')).not.toBeNull();
    expect(root.querySelector('[data-testid="topic-sunk-section"]')).not.toBeNull();

    await userEvent.click(source().querySelector<HTMLElement>('.gg-list-row-title')!);
    await until('source topics fold', () => source().getAttribute('aria-expanded') === 'false');
    expect(root.querySelector('[data-topic-subrow="t-live"]')).toBeNull();
    expect(root.querySelector('[data-testid="topic-sunk-section"]')).toBeNull();
    expect(disclosure().getAttribute('aria-expanded')).toBe('false');
    expect(source().getAttribute('aria-selected')).toBe('true');
    expect(onChatSelected).not.toHaveBeenCalled();

    await userEvent.click(source().querySelector<HTMLElement>('.gg-list-row-title')!);
    await until('source topics unfold', () => root.querySelector('[data-topic-subrow="t-live"]') !== null);
    expect(source().getAttribute('aria-expanded')).toBe('true');
    expect(disclosure().getAttribute('aria-expanded')).toBe('true');
    expect(root.querySelector('[data-testid="topic-sunk-section"]')).not.toBeNull();
    expect(onChatSelected).not.toHaveBeenCalled();
  });

  it('#7589 selecting a different source navigates without folding its topics', async () => {
    const onChatSelected = vi.fn();
    const root = await renderList('dm-1', onChatSelected);
    const source = () => root.querySelector<HTMLElement>('[data-chat-row="grp-1"]')!;
    await userEvent.click(source().querySelector<HTMLElement>('.gg-list-row-title')!);
    expect(source().getAttribute('aria-expanded')).toBe('true');
    expect(root.querySelector('[data-topic-subrow="t-live"]')).not.toBeNull();
    expect(onChatSelected).toHaveBeenCalledExactlyOnceWith('composer');
  });

  it.each(['grp-1', 'dm-1'])('the chevron toggles topics without navigation when %s is selected', async (activeChatId) => {
    const onChatSelected = vi.fn();
    const root = await renderList(activeChatId, onChatSelected);
    const source = () => root.querySelector<HTMLElement>('[data-chat-row="grp-1"]')!;
    const disclosure = () => source().querySelector<HTMLButtonElement>('button[aria-expanded]')!;

    await userEvent.click(disclosure());
    await until('the button collapses topics', () => source().getAttribute('aria-expanded') === 'false');
    expect(root.querySelector('[data-topic-subrow="t-live"]')).toBeNull();
    expect(root.querySelector('[data-testid="topic-sunk-section"]')).toBeNull();
    expect(source().getAttribute('aria-selected')).toBe(String(activeChatId === 'grp-1'));
    expect(onChatSelected).not.toHaveBeenCalled();

    disclosure().focus();
    await userEvent.keyboard('{Enter}');
    await until('keyboard activates only the button', () => source().getAttribute('aria-expanded') === 'true');
    expect(root.querySelector('[data-topic-subrow="t-live"]')).not.toBeNull();
    expect(source().getAttribute('aria-selected')).toBe(String(activeChatId === 'grp-1'));
    expect(onChatSelected).not.toHaveBeenCalled();
  });

  it('mobile row clicks navigate while only the chevron changes topic visibility', async () => {
    const onChatSelected = vi.fn();
    const root = await renderList('grp-1', onChatSelected, true);
    const source = () => root.querySelector<HTMLElement>('[data-chat-row="grp-1"]')!;
    const title = () => source().querySelector<HTMLElement>('.gg-list-row-title')!;

    await userEvent.click(title());
    expect(source().getAttribute('aria-expanded')).toBe('true');
    expect(root.querySelector('[data-topic-subrow="t-live"]')).not.toBeNull();
    expect(onChatSelected).toHaveBeenCalledExactlyOnceWith('composer');

    await userEvent.click(source().querySelector<HTMLButtonElement>('button[aria-expanded]')!);
    await until('mobile disclosure collapses topics', () => source().getAttribute('aria-expanded') === 'false');
    expect(onChatSelected).toHaveBeenCalledTimes(1);
    await userEvent.click(title());
    expect(source().getAttribute('aria-expanded')).toBe('false');
    expect(onChatSelected).toHaveBeenCalledTimes(2);
  });

  it('#7589 collapsed topics are skipped by keyboard navigation and Enter restores them', async () => {
    const root = await renderList();
    const source = () => root.querySelector<HTMLElement>('[data-chat-row="grp-1"]')!;
    source().focus();
    await userEvent.keyboard('{ArrowDown}');
    await until('expanded topic receives focus', () => document.activeElement?.getAttribute('data-chat-row') === 't-live');
    await userEvent.click(source().querySelector<HTMLElement>('.gg-list-row-title')!);
    await until('topics collapse', () => source().getAttribute('aria-expanded') === 'false');
    source().focus();
    await userEvent.keyboard('{ArrowDown}');
    expect(document.activeElement?.getAttribute('data-chat-row')).toBe('grp-1');
    await userEvent.keyboard('{Enter}');
    await until('keyboard unfolds topics', () => root.querySelector('[data-topic-subrow="t-live"]') !== null);
    await userEvent.keyboard('{ArrowDown}');
    await until('restored topic receives focus', () => document.activeElement?.getAttribute('data-chat-row') === 't-live');
  });

  it('a row is avatar + two lines: name and preview 14/20, time 12/18, the unread count an 18px ink chip; corners 8, not a capsule', async () => {
    const root = await renderList();
    const row = root.querySelector<HTMLElement>('[data-chat-row="dm-1"]')!;
    expect(tier(row.querySelector('.gg-list-row-title'))).toEqual(COMPACT);
    expect(getComputedStyle(row.querySelector('.gg-list-row-title')!).fontWeight, 'an unread row\'s name is not emphasised').toBe('600');
    expect(tier(row.querySelector('.gg-list-row-subtitle'))).toEqual(COMPACT);
    expect(tier(row.querySelector('.gg-list-row-meta'))).toEqual(CAPTION);
    const count = row.querySelector<HTMLElement>('.gg-chip[data-tone="accent"]')!;
    expect(count.textContent).toBe('3');
    expect(tier(count)).toEqual(CAPTION);
    expect(Math.round(count.getBoundingClientRect().height)).toBe(18);
    expect(getComputedStyle(count).backgroundColor).toBe(token('--primary'));
    expect(getComputedStyle(row).borderRadius, 'the row became a capsule').toBe('8px');
    expect(row.querySelector('.gg-list-row-leading img, .gg-list-row-leading svg, .gg-list-row-leading [class*="avatar"]'), 'the row lost its avatar').not.toBeNull();
    const lines = row.querySelectorAll('.gg-list-row-line');
    expect(lines.length, 'the row is not two lines').toBe(2);
  });

  it('selected is the neutral --selected; hover lays --hover; the keyboard ring shows on focus', async () => {
    const root = await renderList();
    const selected = root.querySelector<HTMLElement>('[data-chat-row="grp-1"]')!;
    await untilStable('the selected row settles', () => getComputedStyle(selected).backgroundColor);
    expect(getComputedStyle(selected).backgroundColor).toBe(token('--selected'));
    const row = root.querySelector<HTMLElement>('[data-chat-row="dm-1"]')!;
    await userEvent.hover(row);
    await untilStable('the hovered row settles', () => getComputedStyle(row).backgroundColor);
    expect(getComputedStyle(row).backgroundColor).toBe(token('--hover'));
    await userEvent.unhover(row);
    row.focus();
    await userEvent.keyboard('{ArrowDown}');
    const focused = document.activeElement as HTMLElement;
    expect(focused.matches(':focus-visible'), 'the arrow-key focus is not :focus-visible').toBe(true);
    expect(getComputedStyle(focused).outlineStyle).toBe('solid');
  });

  it('a topic sub-row\'s name is 14/20; the "more · N" bar under it is 12/18', async () => {
    const root = await renderList();
    const sub = root.querySelector<HTMLElement>('[data-topic-subrow="t-live"]')!;
    expect(tier(sub.querySelector('.gg-list-row-title > span') ?? sub.querySelector('.gg-list-row-title'))).toEqual(COMPACT);
    const more = root.querySelector<HTMLElement>('[data-testid="topic-sunk-section"]')!;
    expect(more, 'the sunk topic did not fold into "more"').not.toBeNull();
    expect(tier(more)).toEqual(CAPTION);
  });

  it('the add-contact sheet\'s title is 16/24', async () => {
    const root = await renderList();
    await userEvent.click(root.querySelector<HTMLElement>('[aria-label="' + i18n.t('chatList.create', { ns: 'messaging' }) + '"]')!);
    await until('the plus menu opens', () => document.querySelector('[data-testid="plus-menu-add-friend"]') !== null);
    await userEvent.click(document.querySelector<HTMLElement>('[data-testid="plus-menu-add-friend"]')!);
    const label = i18n.t('chatList.addContact', { ns: 'messaging' });
    await until('the add-contact sheet opens', () => [...document.querySelectorAll('span')].some((s) => s.textContent === label && s.style.flex));
    const title = [...document.querySelectorAll<HTMLElement>('span')].find((s) => s.textContent === label && s.style.flex)!;
    expect(tier(title)).toEqual(TITLE);
  });
});
