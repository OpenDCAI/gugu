/**
 * 手机长按消息(owner 11-05 方案 A):气泡浮起,回应条在它上方、动作列表在它下方,三样都在屏内、彼此不压。
 * 气泡比剩下的空间还高(长消息、滚到一半)时,只露手指附近那一截 —— 从前这种情况菜单被推到屏幕底部、
 * 看上去像半屏抽屉(owner 11-05 实拍),更早还翻到过屏幕外(owner 10-27)。
 * 短气泡是阳控:放得下就原地浮起,不挪也不裁。
 */
import { afterEach, expect, it, vi } from 'vitest';
import { page, userEvent } from 'vitest/browser';
import { act } from 'react';
import { createReactHarness, message, renderWithAppProviders } from '../../../../../../../tests/support/testHarness';
import { until } from '../../../../../../../tests/support/awaitCondition';
import '@/styles/tokens.css';
import '@renderer/index.css';

vi.mock('@gugu/core/cloud/config', async (original) => ({ ...(await original<object>()), getSupabaseUrl: () => 'http://supabase.test.local', getSupabaseAnonKey: () => 'test-anon-key' }));
vi.mock('@/hooks/useAgentHarnessIdentity', () => ({ useAgentHarnessIdentity: () => 'codex' }));
const { MessageBubble } = await import('@/components/chat/MessageBubble');

let harness: ReturnType<typeof createReactHarness>;
afterEach(() => harness?.cleanup());

const W = 390, H = 844;
// [气泡容器 top, 正文重复倍数]
const cases = { 'short-top': [60, 1], 'short-middle': [400, 1], 'short-bottom': [H - 140, 1], 'tall-middle': [120, 10], 'tall-scrolled': [-200, 40] } as const;

it.each(Object.keys(cases))('phone long-press lifts the bubble with reactions above and actions below, all on screen: %s', async (name) => {
  const [top, reps] = cases[name as keyof typeof cases];
  await page.viewport(W, H);
  harness = createReactHarness();
  harness.container.className = 'gugu-skin emlight';
  harness.container.style.cssText = `position:fixed;left:0;top:${top}px;width:${W}px`;
  harness.container.dataset.testid = 'chat-message-list';
  await renderWithAppProviders(harness, <MessageBubble msg={message({ id: 't', is_mine: false, content: 'Long message line. '.repeat(reps * 4) })}
    isGroup compactMobile onReaction={() => {}} onQuote={() => {}} onForward={() => {}} onDelete={() => {}} />);
  const target = harness.container.querySelector<HTMLElement>('[data-testid="message-bubble-action-target"]')!;
  const b = target.getBoundingClientRect();
  const touchY = Math.min(Math.max(b.top + b.height / 2, 100), H - 100);
  await act(async () => { target.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: b.left + 20, clientY: touchY })); });
  await until('menu opens', () => !!document.querySelector('[data-testid="message-action-menu"]') && !!document.querySelector('.gg-phone-menu-reactions [role="menuitem"]'));
  const layer = document.querySelector<HTMLElement>('.gg-phone-menu')!;
  await until('settled', () => [...layer.querySelectorAll<HTMLElement>('*')].flatMap((el) => el.getAnimations()).every((a) => a.playState === 'finished'));
  const box = (selector: string) => document.querySelector(selector)!.getBoundingClientRect();
  const [reactions, preview, list] = [box('.gg-phone-menu-reactions'), box('.gg-phone-menu-preview'), box('[data-testid="message-action-menu"]')];
  for (const [label, r] of [['reactions', reactions], ['bubble', preview], ['actions', list]] as const) {
    expect(r.top, `${label} runs off the top`).toBeGreaterThanOrEqual(0);
    expect(r.bottom, `${label} runs off the bottom`).toBeLessThanOrEqual(H);
  }
  // 浮起放大 1.035,上下各多出约 1.5%:相邻两块之间至少还留着缝。
  expect(reactions.bottom, 'reactions sit above the bubble').toBeLessThanOrEqual(preview.top);
  expect(list.top, 'actions sit below the bubble').toBeGreaterThanOrEqual(preview.bottom);
  expect(target.style.visibility, 'the bubble in the list gives way to the lifted copy').toBe('hidden');
  if (name.startsWith('short')) expect(preview.height, 'a short message is shown whole').toBeGreaterThanOrEqual(b.height);
  if (name === 'short-middle') expect(Math.abs(preview.top + preview.height * 0.0175 / 1.035 - b.top), 'room to spare: lifted in place').toBeLessThan(2);
  if (name.startsWith('tall')) expect(preview.height, 'a long message shows only the part near the finger').toBeLessThan(b.height);
  // A tap on the dimmed background (not on any of the three) closes it: the full-screen layer lets it through to the backdrop.
  // The layout keeps an 8px margin, so the corner is always empty (and inside Base UI's full-screen positioner).
  const hit = document.elementFromPoint(W - 2, H - 2)!;
  expect(hit.classList.contains('gg-phone-menu-scrim'), `an empty spot hits the backdrop, not ${hit.className}`).toBe(true);
  await userEvent.click(hit, { position: { x: W - 2, y: H - 2 } });
  await until('closed', () => !document.querySelector('.gg-phone-menu'));
  expect(target.style.visibility, 'the bubble is back').toBe('');
});
