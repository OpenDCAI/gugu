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

async function renderList() {
  harness = createReactHarness();
  harness.container.style.cssText = 'width: 320px; height: 640px; display: flex;';
  await renderWithAppProviders(
    harness,
    createNode(ChatListPanel, { activeTab: 'chats', onOpenAgentCreateDraft: vi.fn() }),
    { chat: { chats, activeChatId: 'grp-1', identitiesById: { 'peer-lin': displayIdentity('peer-lin', { display_name: '林知夏' }) } } },
  );
  await until('the chat rows rendered', () => harness.container.querySelector('[data-chat-row="dm-1"]') !== null);
  return harness.container;
}

describe('the IM chat list in the master\'s roles (#7333)', () => {
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
