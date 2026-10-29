/**
 * 分屏再开成员栏,群的消息列只剩两三百宽(10-28 实测:窗口 800,消息列 247px):
 * - 任务卡「交给 · Codex 3 ✓」那一行冲出卡边,行尾的 ✓ 压到发送者头像上;卡头「新任务」在 24px 高的行里折成两行。
 * - 回复气泡里的引用条写死 180px,比气泡还宽,被引那一行冲出气泡右边。
 * 渲染的是真 MessageBubble(共享 testHarness 的 providers),按 getBoundingClientRect 比边。
 */
import { createNode, createReactHarness, message, renderWithAppProviders } from '../../../../../../../tests/support/testHarness';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { MemberProfileCardModel } from '@/components/MemberProfileCard';
import { serializeComposerCard } from '@gugu/core/shared/ui/taskCardModels';
import { i18n } from '@/i18n';
import '@/i18n/registerMessagingCatalog';
import '@/styles/tokens.css';
import { until } from '../../../../../../../tests/support/awaitCondition';

vi.mock('@gugu/core/cloud/config', async (original) => ({ ...(await original<object>()), getSupabaseUrl: () => 'http://supabase.test.local', getSupabaseAnonKey: () => 'test-anon-key' }));
vi.mock('@/hooks/useAgentHarnessIdentity', () => ({ useAgentHarnessIdentity: () => 'codex' }));
// 做完了(空闲)的任务:行尾画那枚 ✓,正是父版压到头像上的那一枚。
vi.mock('@/hooks/useAgentDisplayStatus', async (original) => ({
  ...(await original<object>()),
  useAgentDisplayStatuses: (ids: string[]) => Object.fromEntries(ids.map((id) => [id, 'idle'])),
}));

const { MessageBubble } = await import('@/components/chat/MessageBubble');

const lin: MemberProfileCardModel = { id: 'sender-1', displayName: '林知夏', avatar: null, email: null, type: 'human', role: 'member' } as MemberProfileCardModel;
// 接手的 agent 已经坐在群里(不走「等待批准」那一支)。
const codex: MemberProfileCardModel = { id: 'agent-1', displayName: 'Codex 3', avatar: null, email: null, type: 'agent', role: 'member' } as MemberProfileCardModel;
const profiles = { 'sender-1': lin, 'agent-1': codex };
const TASK = serializeComposerCard({
  v: 1, type: 'task', text: 'Reply with just: ok one', agentUserId: 'agent-1', agentName: 'Codex 3', agentType: 'codex',
  sessionId: 'session-1', projectId: 'project-1', deviceId: 'device-1', machineLabel: 'This computer',
});

let harness: ReturnType<typeof createReactHarness>;
beforeAll(async () => {
  await i18n.changeLanguage('en-US');
});
afterEach(() => harness?.cleanup());

async function renderBubble(listWidth: number, overrides: Parameters<typeof message>[0]) {
  harness = createReactHarness();
  harness.container.style.width = `${listWidth}px`;
  await renderWithAppProviders(
    harness,
    createNode(MessageBubble, {
      msg: message({ id: 'msg-1', sender_user_id: 'sender-1', created_at: '2026-10-28T06:10:00.000Z', ...overrides }),
      onReaction: vi.fn(),
      memberReadSeqs: {},
      onQuote: vi.fn(),
      onForward: vi.fn(),
      onDelete: vi.fn(),
      compactMobile: false,
      isGroup: true,
      memberProfile: lin,
      memberProfiles: profiles,
    }),
  );
  await until('the bubble rendered', () => harness.container.querySelector('[data-testid="message-bubble-action-target"]') !== null);
  return harness.container;
}

/** 盒子里看得见的叶子里,越出盒子左右两边最多的那一个(px;≤ 0 = 都在里面)。 */
function worstSpill(box: HTMLElement) {
  const edge = box.getBoundingClientRect();
  let worst = { by: 0, what: '' };
  for (const el of box.querySelectorAll<Element>('*')) {
    const r = el.getBoundingClientRect();
    if (el.children.length > 0 || r.width === 0 || r.height === 0) continue;
    const by = Math.max(r.right - edge.right, edge.left - r.left);
    if (by > worst.by) worst = { by, what: `${el.tagName} ${el.getAttribute('aria-label') ?? el.textContent ?? ''}` };
  }
  return worst;
}

describe('cards and quotes in a narrow group message list', () => {
  for (const listWidth of [240, 300, 360, 720]) {
    it(`list ${listWidth}px: the task card's rows stay inside the card, the head on one line`, async () => {
      const root = await renderBubble(listWidth, { content_type: 'card', content: TASK, is_mine: true });
      const card = root.querySelector<HTMLElement>('[data-testid="composer-card"]')!;
      await until('the status mark drawn', () => card.querySelector('[role="img"]') !== null);
      const spill = worstSpill(card);
      expect(spill.by, `spills past the card: ${spill.what}`).toBeLessThanOrEqual(0.5);
      const title = [...card.querySelectorAll<HTMLElement>('span')].find((el) => el.textContent === 'New task')!;
      expect(title.getBoundingClientRect().height, 'the head stays one line').toBeLessThanOrEqual(24);
    });

    it(`list ${listWidth}px: a reply's quote bar stays inside the bubble`, async () => {
      const root = await renderBubble(listWidth, {
        content: 'ok one',
        reply_to_message_id: 'msg-0',
        reply_to_sender_user_id: 'sender-1',
        reply_to_content: 'Reply with just: ok one',
      });
      const bubble = root.querySelector<HTMLElement>('[data-testid="message-bubble-action-target"]')!;
      await until('the quote drawn', () => root.querySelector('[title="Go to the quoted message"]') !== null);
      const quote = root.querySelector<HTMLElement>('[title="Go to the quoted message"]')!;
      const style = getComputedStyle(bubble);
      const contentRight = bubble.getBoundingClientRect().right - Number.parseFloat(style.paddingRight);
      expect(quote.getBoundingClientRect().right, 'quote bar right edge vs bubble content edge').toBeLessThanOrEqual(contentRight + 0.5);
    });
  }
});
