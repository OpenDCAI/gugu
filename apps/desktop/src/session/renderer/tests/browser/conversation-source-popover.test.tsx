import { afterEach, expect, it, vi } from 'vitest';
import { act } from 'react';
import { page, userEvent } from 'vitest/browser';
import { ConversationSourcePopover } from '../../lib/chat/conversation-source-popover';
import { createReactHarness, renderWithAppProviders } from '../../../../../../../tests/support/testHarness';
import { until } from '../../../../../../../tests/support/awaitCondition';
import '@/styles/tokens.css';

let harness: ReturnType<typeof createReactHarness>;
afterEach(() => harness?.cleanup());

async function mount(text = 'Peer：the exact original message') {
  const away = document.createElement('div');
  away.dataset.testid = 'source-preview-pointer-away';
  away.style.cssText = 'position:fixed;right:4px;bottom:4px;width:10px;height:10px;z-index:2147483647';
  document.body.append(away);
  try { await page.getByTestId('source-preview-pointer-away').hover(); } finally { away.remove(); }
  const navigate = vi.fn();
  harness = createReactHarness();
  await renderWithAppProviders(harness, <div style={{ padding: 60 }}>
    <div>Reply body</div><ConversationSourcePopover label="Show original message" text={text} onOpenOriginal={navigate} />
  </div>, { contacts: {} });
  return { navigate, arrow: harness.container.querySelector<HTMLButtonElement>('[data-slot="conversation-quote"]')! };
}

it('keeps the source hidden over the body and shows it only over the return mark', async () => {
  const { navigate } = await mount();
  await page.getByText('Reply body', { exact: true }).hover();
  expect(document.querySelector('[data-slot="conversation-quote-preview"]')).toBeNull();
  await page.getByRole('button', { name: 'Show original message', exact: true }).hover();
  await expect.element(page.getByText('Peer：the exact original message', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Show original message', exact: true }).click();
  expect(navigate).toHaveBeenCalledOnce();
});

it.each([
  ['strong', '**Opening** '.repeat(70) + 'TAIL_MARKER'],
  ['table', '| Key | Value |\n| --- | --- |\n' + '| A | B |\n'.repeat(30) + 'TAIL_MARKER'],
  ['pre code', '```ts\n' + 'const value = 1;\n'.repeat(30) + 'TAIL_MARKER\n```'],
])('renders a bounded Markdown %s source with an ellipsis, retaining the source action', async (selector, text) => {
  const { navigate } = await mount(text);
  await page.getByRole('button', { name: 'Show original message', exact: true }).hover();
  await until('source preview mounts', () => !!document.querySelector('[data-slot="conversation-quote-preview"]'));
  const content = document.querySelector<HTMLElement>('[data-conversation-source-markdown]')!;
  expect(content).not.toBeNull();
  expect(content.querySelector(selector)).not.toBeNull();
  expect(content.textContent).not.toContain('TAIL_MARKER');
  expect(content.getBoundingClientRect().height).toBeLessThanOrEqual(54);
  expect(content.scrollHeight).toBeGreaterThan(content.clientHeight);
  expect(content.hasAttribute('data-source-truncated')).toBe(true);
  expect(getComputedStyle(content, '::after').content).toBe('"…"');
  await act(async () => document.querySelector<HTMLElement>('[data-slot="conversation-quote-preview"]')!.click());
  expect(navigate).toHaveBeenCalledOnce();
});

it('uses the first touch to preview and the preview action to return to the source', async () => {
  const { navigate, arrow } = await mount();
  await act(async () => {
    arrow.dispatchEvent(new PointerEvent('pointerdown', { pointerType: 'touch', bubbles: true }));
    arrow.click();
  });
  await until('touch source preview is mounted', () => !!document.querySelector('[data-slot="conversation-quote-preview"]'));
  expect(navigate).not.toHaveBeenCalled();
  await act(async () => document.querySelector<HTMLButtonElement>('[data-slot="conversation-quote-preview"]')!.click());
  expect(navigate).toHaveBeenCalledOnce();
});

it('dismisses the source preview with Escape', async () => {
  await mount();
  await page.getByRole('button', { name: 'Show original message', exact: true }).hover();
  await expect.element(page.getByText('Peer：the exact original message', { exact: true })).toBeVisible();
  await act(async () => userEvent.keyboard('{Escape}'));
  await until('Escape unmounts the source preview', () => !document.querySelector('[data-slot="conversation-quote-preview"]'));
});
