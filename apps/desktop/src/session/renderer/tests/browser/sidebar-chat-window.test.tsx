/**
 * @@@sidebar-chat-window — the sidebar's conversation lines mount only around the visible part of their scroller. A message
 * moves its conversation to the top; with every line mounted React re-inserted every line above it, so the cost of a
 * message to the k-th conversation grew with k. This pins it: the mounted lines are a window, and a message to a
 * conversation far down the list inserts only the line that arrives on screen.
 */
import { chat, createNode, createReactHarness, renderWithAppProviders } from '../../../../../../../tests/support/testHarness';
import { afterEach, beforeAll, expect, it, vi } from 'vitest';
import { page } from 'vitest/browser';
import { i18n } from '@/i18n';
import '@/i18n/registerMessagingCatalog';
import '@/i18n/registerMainCatalog';
import '@/styles/tokens.css';
import { until } from '../../../../../../../tests/support/awaitCondition';

vi.mock('@gugu/core/cloud/config', async (original) => ({ ...(await original<object>()), getSupabaseUrl: () => 'http://supabase.test.local', getSupabaseAnonKey: () => 'test-anon-key' }));
vi.mock('@/store/devicesContext', async (original) => ({ ...(await original<object>()), useDevicesStore: () => ({ devices: [] }) }));
vi.mock('@/hooks/useAgentDisplayStatus', async (original) => ({ ...(await original<object>()), useAgentDisplayStatuses: () => ({}) }));
vi.mock('@/components/AddFriendSearch', () => ({ AddFriendSearch: () => null }));

const { ChatListPanel } = await import('@/components/ChatListPanel');

const base = Date.now() - 60_000;
const groups = Array.from({ length: 150 }, (_, index) => chat({
  id: `g-${index}`, kind: 'group', name: `Group ${index}`, avatar: null,
  last_message_at: new Date(base - index * 60_000).toISOString(), last_message_preview: `line ${index}`,
}));

let harness: ReturnType<typeof createReactHarness>;
beforeAll(async () => { await i18n.changeLanguage('en-US'); });
afterEach(() => harness?.cleanup());

async function render(chats: typeof groups) {
  await renderWithAppProviders(harness, createNode(ChatListPanel, { activeTab: 'chats', mobile: false, placement: 'sidebar' }), { chat: { chats, activeChatId: null } });
}
const mounted = () => [...harness.container.querySelectorAll<HTMLElement>('[data-chat-row]')].map((row) => row.dataset.chatRow)

it('mounts a window of the sidebar lines and moves only the arriving line to the top', async () => {
  await page.viewport(1000, 800);
  harness = createReactHarness();
  // the sidebar's one scroller (@@@sidebar-single-scroller)
  harness.container.style.cssText = 'width: 320px; height: 600px; overflow-y: auto;';
  await render(groups);
  await until('the first lines rendered', () => mounted()[0] === 'g-0');
  expect(mounted().length, 'only the lines around the visible part are mounted').toBeLessThan(40);

  const inserted: string[] = [];
  const observer = new MutationObserver((records) => {
    for (const record of records) for (const node of record.addedNodes) {
      if (node instanceof HTMLElement) for (const row of [node, ...node.querySelectorAll<HTMLElement>('[data-chat-row]')]) if (row.dataset.chatRow) inserted.push(row.dataset.chatRow);
    }
  });
  observer.observe(harness.container, { childList: true, subtree: true });
  // a message to the 120th conversation: it becomes the most recent one
  await render(groups.map((group) => group.id === 'g-120' ? { ...group, last_message_at: new Date().toISOString(), last_message_preview: 'new' } : group));
  await until('the conversation moved to the top', () => mounted()[0] === 'g-120');
  observer.disconnect();
  expect(inserted.length, `inserted lines: ${inserted.join(', ')}`).toBeLessThanOrEqual(2);
  expect(inserted).toContain('g-120');
});
