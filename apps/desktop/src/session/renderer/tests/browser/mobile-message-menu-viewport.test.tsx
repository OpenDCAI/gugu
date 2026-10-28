/**
 * 手机上长按消息,菜单贴着气泡弹出(owner 10-26)。气泡比它上下剩下的空间都高时(长消息、滚到一半),
 * 翻面也放不下 —— 从前就翻到了屏幕上方外面(owner 10-27「长按菜单跑到屏幕外」)。
 * 短气泡是阳控:翻面照旧(在下方放得下就在下方,贴底时翻到上方),不压气泡。
 */
import { afterEach, expect, it, vi } from 'vitest';
import { page } from 'vitest/browser';
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
const cases = { 'short-top': [60, 1], 'short-bottom': [H - 140, 1], 'tall-middle': [120, 10], 'tall-scrolled': [-200, 40] } as const;

it.each(Object.keys(cases))('phone long-press menu stays on screen: %s', async (name) => {
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
  await act(async () => { target.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: b.left + 20, clientY: Math.max(10, b.top + 20) })); });
  await until('menu opens', () => !!document.querySelector('[data-testid="message-action-menu"]'));
  const popup = document.querySelector('[data-testid="message-action-menu"]')!.closest<HTMLElement>('.gg-menu')!;
  await until('settled', () => !popup.hasAttribute('data-starting-style') && popup.getAnimations().every((a) => a.playState === 'finished'));
  const r = popup.getBoundingClientRect();
  expect(r.top, 'menu runs off the top of the screen').toBeGreaterThanOrEqual(0);
  expect(r.bottom, 'menu runs off the bottom of the screen').toBeLessThanOrEqual(H);
  if (name === 'short-top') expect(r.top).toBeGreaterThanOrEqual(b.bottom);
  if (name === 'short-bottom') expect(r.bottom).toBeLessThanOrEqual(b.top);
});
