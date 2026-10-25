/**
 * #7333 IM 气泡的元信息与引用条按母版字阶落到真实计算值:正文仍是 16/24;发送者名、时间、悄悄话标签、AI 代发、
 * 系统消息、发送失败 = 标注 12/18;气泡里的引用条(回复引用,与已发出的 `> [名字]: 原话`)的标题和摘录 = 紧凑界面 14/20。
 * 输入框上方的引用预览是另一个元素,判据在 input-area-quote-7333.test.tsx。
 * 渲染的是真 MessageBubble(共享 testHarness 的 providers),判 getComputedStyle,❌ 读内联声明。
 * 引用条的省略与宽度上限照旧(长摘录要真的被截)。
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

const CAPTION = { size: 12, leading: 18 } as const;
const COMPACT = { size: 14, leading: 20 } as const;
const PROSE = { size: 16, leading: 24 } as const;
const px = (value: string) => Number.parseFloat(value) || 0;
const tier = (element: Element | null | undefined) => {
  if (!element) return null;
  const style = getComputedStyle(element);
  return { size: px(style.fontSize), leading: Math.round(px(style.lineHeight)) };
};

const lin: MemberProfileCardModel = { id: 'sender-1', displayName: '林知夏', avatar: null, email: null, type: 'human', role: 'member' } as MemberProfileCardModel;
const LONG_EXCERPT = '这一段被回复的原话很长很长,长到引用条一定放不下,只能在末尾收成省略号。'.repeat(2);

let harness: ReturnType<typeof createReactHarness>;
beforeAll(async () => {
  await i18n.changeLanguage('zh-CN');
});
afterEach(() => harness?.cleanup());

async function renderBubble(overrides: Parameters<typeof message>[0], props: Record<string, unknown> = {}, chat?: Record<string, unknown>) {
  harness = createReactHarness();
  harness.container.style.width = '720px';
  await renderWithAppProviders(
    harness,
    createNode(MessageBubble, {
      msg: message({ id: 'msg-1', sender_user_id: 'sender-1', created_at: '2026-10-16T09:41:00.000Z', ...overrides }),
      onReaction: vi.fn(),
      memberReadSeqs: {},
      onQuote: vi.fn(),
      onForward: vi.fn(),
      onDelete: vi.fn(),
      compactMobile: false,
      isGroup: true,
      memberProfile: lin,
      memberProfiles: { 'sender-1': lin },
      ...props,
    }),
    chat ? { chat } : undefined,
  );
  await until('the bubble rendered', () => harness.container.querySelector('[data-message-time="true"]') !== null);
  return harness.container;
}
const byText = (root: HTMLElement, text: string) =>
  [...root.querySelectorAll<HTMLElement>('span, div, button')].filter((el) => el.textContent === text).at(-1) ?? null;

describe('the IM bubble\'s meta and quote bars in the master\'s tiers (#7333)', () => {
  it('a group reply: body 16/24; sender name 14/20 inside the bubble, time 12/18; the reply quote\'s title and excerpt 14/20, the long excerpt still cut', async () => {
    const root = await renderBubble({
      content: '好的,就按这个办。',
      reply_to_message_id: 'msg-0',
      reply_to_sender_user_id: 'sender-1',
      reply_to_content: LONG_EXCERPT,
    });
    expect(tier(root.querySelector('[data-message-sender-name="true"]'))).toEqual(COMPACT);
    expect(tier(root.querySelector('[data-message-time="true"]'))).toEqual(CAPTION);
    const excerpt = byText(root, LONG_EXCERPT)!;
    const title = excerpt.previousElementSibling as HTMLElement;
    expect(title.textContent).toBe('林知夏');
    expect(tier(title), 'the quote title').toEqual(COMPACT);
    expect(tier(excerpt), 'the quote excerpt').toEqual(COMPACT);
    expect(excerpt.scrollWidth, 'the long excerpt was not cut: the ellipsis is untested').toBeGreaterThan(excerpt.clientWidth);
    expect(getComputedStyle(excerpt).textOverflow).toBe('ellipsis');
    expect(Math.round(excerpt.parentElement!.getBoundingClientRect().width), 'the quote bar outgrew its cap').toBeLessThanOrEqual(180);
    // The reply itself stays the message tier.
    expect(tier(byText(root, '好的,就按这个办。')?.closest('[style*="--font-prose"]'))).toEqual(PROSE);
  });

  // This is the quote as it reads once SENT (the `> [name]: text` the composer writes into the body, drawn by the bubble);
  // the composer's own preview strip above the toolbar is a different element — input-area-quote-7333.test.tsx.
  it('a sent composer quote (`> [name]: text` in the body): its title and excerpt 14/20, the reply below at 16/24', async () => {
    const root = await renderBubble({ content: '> [林知夏]: 周六去哪儿?\n去爬山吧' });
    const excerpt = byText(root, '周六去哪儿?')!;
    expect(tier(excerpt)).toEqual(COMPACT);
    expect(tier(byText(root, '林知夏'))).toEqual(COMPACT);
    expect(tier(byText(root, '去爬山吧')?.closest('[style*="--font-prose"]'))).toEqual(PROSE);
  });

  it('the whisper label and the AI-sent badge are 12/18', async () => {
    const root = await renderBubble({ content: '只给你看', is_whisper: true, sent_by_agent: true });
    expect(tier(byText(root, i18n.t('message.whisperOnlyYou', { ns: 'messaging' })))).toEqual(CAPTION);
    expect(tier(root.querySelector('[data-ai-sent="true"]'))).toEqual(CAPTION);
  });

  it('a failed send: the status reads 12/18 and still opens retry / discard', async () => {
    const retrySend = vi.fn();
    const root = await renderBubble({ content: '没发出去', is_mine: true }, { sendState: 'failed' }, { retrySend, discardSend: vi.fn() });
    const status = root.querySelector<HTMLElement>('[data-testid="message-send-failed"]')!;
    expect(tier(status)).toEqual(CAPTION);
    status.click();
    await until('the failed-send menu opens', () => document.querySelector('[data-testid="message-send-retry"]') !== null);
    document.querySelector<HTMLElement>('[data-testid="message-send-retry"]')!.click();
    expect(retrySend).toHaveBeenCalledWith('msg-1');
  });

  it('a system message is 12/18', async () => {
    harness = createReactHarness();
    await renderWithAppProviders(
      harness,
      createNode(MessageBubble, {
        msg: message({ id: 'sys-1', content_type: 'system', content: '林知夏 加入了群聊' }),
        onReaction: vi.fn(), memberReadSeqs: {}, onQuote: vi.fn(), onForward: vi.fn(), onDelete: vi.fn(), isGroup: true,
      }),
    );
    await until('the system line rendered', () => byText(harness.container, '林知夏 加入了群聊') !== null);
    expect(tier(byText(harness.container, '林知夏 加入了群聊'))).toEqual(CAPTION);
  });
});
