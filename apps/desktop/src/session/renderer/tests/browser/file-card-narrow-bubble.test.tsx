/**
 * A file attachment bubble stays wrapped around its card when the message list is narrow: the card shrinks (name ellipsised)
 * instead of sticking out past the gray bubble's right edge. Real MessageBubble + real layout; judged on bounding rects.
 */
import { createNode, createReactHarness, message, renderWithAppProviders } from '../../../../../../../tests/support/testHarness';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { MemberProfileCardModel } from '@/components/MemberProfileCard';
import { i18n } from '@/i18n';
import '@/i18n/registerMessagingCatalog';
import '@/styles/tokens.css';
import { until } from '../../../../../../../tests/support/awaitCondition';

vi.mock('@gugu/core/cloud/config', async (original) => ({ ...(await original<object>()), getSupabaseUrl: () => 'http://supabase.test.local', getSupabaseAnonKey: () => 'test-anon-key' }));
vi.mock('@/hooks/useAgentHarnessIdentity', () => ({ useAgentHarnessIdentity: () => 'codex' }));

const { MessageBubble } = await import('@/components/chat/MessageBubble');

const lin: MemberProfileCardModel = { id: 'sender-1', displayName: '林知夏', avatar: null, email: null, type: 'human', role: 'member' } as MemberProfileCardModel;
const FILE_NAME = '项目群并入项目页-原型.html';
const CONTENT = `[附件] ${FILE_NAME} (text/html)\n[URL] https://files.test.local/prototype.html\n[Size] 169267\n[Kind] file`;

let harness: ReturnType<typeof createReactHarness>;
beforeAll(async () => {
  await i18n.changeLanguage('zh-CN');
});
afterEach(() => harness?.cleanup());

async function renderFileBubble(listWidth: number, isMine: boolean) {
  harness = createReactHarness();
  harness.container.style.width = `${listWidth}px`;
  await renderWithAppProviders(
    harness,
    createNode(MessageBubble, {
      msg: message({ id: 'msg-1', sender_user_id: 'sender-1', created_at: '2026-10-16T09:41:00.000Z', content_type: 'attachment', content: CONTENT, is_mine: isMine }),
      onReaction: vi.fn(),
      memberReadSeqs: {},
      onQuote: vi.fn(),
      onForward: vi.fn(),
      onDelete: vi.fn(),
      compactMobile: false,
      isGroup: true,
      memberProfile: lin,
      memberProfiles: { 'sender-1': lin },
    }),
  );
  await until('the file card rendered', () => harness.container.querySelector('.gg-hfile') !== null);
  const bubble = harness.container.querySelector<HTMLElement>('[data-testid="message-bubble-action-target"]');
  const card = harness.container.querySelector<HTMLElement>('.gg-hfile');
  if (!bubble || !card) throw new Error('bubble or card missing');
  return { bubble, card };
}

describe('file attachment card in a narrow message list', () => {
  for (const isMine of [false, true]) {
    for (const listWidth of [240, 300, 360, 720]) {
      it(`${isMine ? 'own' : 'received'} message, list ${listWidth}px: the card sits inside the bubble`, async () => {
        const { bubble, card } = await renderFileBubble(listWidth, isMine);
        const bubbleBox = bubble.getBoundingClientRect();
        const cardBox = card.getBoundingClientRect();
        expect(cardBox.right, 'card right edge vs bubble right edge').toBeLessThanOrEqual(bubbleBox.right + 0.5);
        expect(cardBox.left, 'card left edge vs bubble left edge').toBeGreaterThanOrEqual(bubbleBox.left - 0.5);
      });
    }
  }
});
