import { afterEach, expect, it, vi } from 'vitest';
import { act } from 'react';
import { page, userEvent } from 'vitest/browser';
import { ConversationSourcePopover } from '../../lib/chat/conversation-source-popover';
import { createReactHarness, renderWithAppProviders } from '../../../../../../../tests/support/testHarness';
import { until } from '../../../../../../../tests/support/awaitCondition';
import '@/styles/tokens.css';

let harness: ReturnType<typeof createReactHarness>;
afterEach(() => harness?.cleanup());

async function mount() {
  const navigate = vi.fn();
  harness = createReactHarness();
  await renderWithAppProviders(harness, <div style={{ padding: 60 }}>
    <div>Reply body</div><ConversationSourcePopover label="Show original message" text="Peer：the exact original message" onOpenOriginal={navigate} />
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
