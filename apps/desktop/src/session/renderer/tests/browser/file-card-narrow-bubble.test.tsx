/**
 * An attachment bubble stays wrapped around its content when the message list is narrow: the file card shrinks (name ellipsised)
 * and an inline image is capped, instead of sticking out past the gray bubble's right edge.
 * Real MessageBubble + real layout; judged on bounding rects against the bubble's padding box (its content area).
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

// A 1000x500 picture, so the bubble's width is decided by the layout caps and not by the (tiny) test asset.
const WIDE_IMAGE = `data:image/svg+xml;utf8,${encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="1000" height="500"><rect width="1000" height="500" fill="#888"/></svg>')}`;
const imageView = vi.hoisted(() => ({ current: { status: 'loading' } as Record<string, unknown> }));
vi.mock('@/lib/attachmentBytes', async (original) => ({
  ...(await original<object>()),
  useAttachmentObjectUrl: () => ({ ...imageView.current, retry: () => undefined }),
}));

const { MessageBubble } = await import('@/components/chat/MessageBubble');

const lin: MemberProfileCardModel = { id: 'sender-1', displayName: '林知夏', avatar: null, email: null, type: 'human', role: 'member' } as MemberProfileCardModel;
const FILE_CONTENT = '[附件] 项目群并入项目页-原型.html (text/html)\n[URL] https://files.test.local/prototype.html\n[Size] 169267\n[Kind] file';
const IMAGE_CONTENT = '[附件] screenshot.png (image/png)\n[URL] https://files.test.local/screenshot.png\n[Size] 169267\n[Kind] image';
const IMAGE_LINK = { url: 'https://files.test.local/screenshot.png', width: 1000, height: 500 };

let harness: ReturnType<typeof createReactHarness>;
beforeAll(async () => {
  await i18n.changeLanguage('zh-CN');
});
afterEach(() => harness?.cleanup());

async function renderAttachment(content: string, selector: string, listWidth: number, isMine: boolean) {
  harness = createReactHarness();
  harness.container.style.width = `${listWidth}px`;
  await renderWithAppProviders(
    harness,
    createNode(MessageBubble, {
      msg: message({ id: 'msg-1', sender_user_id: 'sender-1', created_at: '2026-10-16T09:41:00.000Z', content_type: 'attachment', content, is_mine: isMine }),
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
  await until('the attachment rendered', () => harness.container.querySelector(selector) !== null);
  const bubble = harness.container.querySelector<HTMLElement>('[data-testid="message-bubble-action-target"]');
  const attachment = harness.container.querySelector<HTMLElement>(selector);
  if (!bubble || !attachment) throw new Error('bubble or attachment missing');
  const box = bubble.getBoundingClientRect();
  const style = getComputedStyle(bubble);
  return {
    attachment: attachment.getBoundingClientRect(),
    contentLeft: box.left + Number.parseFloat(style.paddingLeft),
    contentRight: box.right - Number.parseFloat(style.paddingRight),
  };
}

describe('attachments in a narrow message list', () => {
  for (const isMine of [false, true]) {
    for (const listWidth of [240, 300, 360, 720]) {
      const who = `${isMine ? 'own' : 'received'} message, list ${listWidth}px`;
      it(`${who}: the file card sits inside the bubble's content area`, async () => {
        const { attachment, contentLeft, contentRight } = await renderAttachment(FILE_CONTENT, '.gg-hfile', listWidth, isMine);
        expect(attachment.right, 'card right edge vs bubble content edge').toBeLessThanOrEqual(contentRight + 0.5);
        expect(attachment.left, 'card left edge vs bubble content edge').toBeGreaterThanOrEqual(contentLeft - 0.5);
      });
      it(`${who}: a loaded inline image sits inside the bubble's content area`, async () => {
        imageView.current = { status: 'ready', objectUrl: WIDE_IMAGE, link: IMAGE_LINK };
        const { attachment, contentRight } = await renderAttachment(IMAGE_CONTENT, 'img.chat-inline-image', listWidth, isMine);
        expect(attachment.right, 'image right edge vs bubble content edge').toBeLessThanOrEqual(contentRight + 0.5);
      });
      it(`${who}: the placeholder of a loading inline image sits inside the bubble's content area`, async () => {
        imageView.current = { status: 'loading', link: { ...IMAGE_LINK, width: 2000, height: 1000 } };
        const { attachment, contentRight } = await renderAttachment(IMAGE_CONTENT, '.chat-inline-image--pending', listWidth, isMine);
        expect(attachment.right, 'placeholder right edge vs bubble content edge').toBeLessThanOrEqual(contentRight + 0.5);
      });
    }
  }
});
