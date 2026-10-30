import { afterEach, expect, it, vi } from 'vitest';
import { page } from 'vitest/browser';
import { act } from 'react';
import { SessionTimelineRail } from '../../features/sessions/view/session-timeline-rail';
import { ConversationSourcePopover } from '../../lib/chat/conversation-source-popover';
import { createReactHarness, renderWithAppProviders } from '../../../../../../../tests/support/testHarness';
import '@/styles/tokens.css';
import '@renderer/index.css';

let harness: ReturnType<typeof createReactHarness>;
afterEach(() => harness?.cleanup());
it('keeps every source-arrow hit point outside the timeline navigation lane', async () => {
  const reveal = vi.fn(), jump = vi.fn(); harness = createReactHarness();
  await renderWithAppProviders(harness, <div style={{ position: 'relative', width: 220, height: 300 }}>
    <SessionTimelineRail turns={[{ id: 'turn', anchorItemId: 'input', itemIds: ['input'], prompt: 'Earlier background command', reply: 'Finished' }]} currentTurnId="turn" onJump={jump} />
    <div data-content style={{ position: 'absolute', left: 40, top: 141 }}>
      <ConversationSourcePopover label="Show original message" text="Peer：the exact source" onOpenOriginal={reveal} />
    </div>
  </div>, { contacts: {} });
  const arrow = harness.container.querySelector<HTMLButtonElement>('[data-slot="conversation-quote"]')!;
  const box = arrow.getBoundingClientRect();
  expect(box.width).toBe(18);
  for (let x = box.left + .5; x < box.right; x++) {
    expect(document.elementFromPoint(x, box.top + box.height / 2)?.closest('[data-slot="conversation-quote"]'), 'the rail never steals the source arrow').toBe(arrow);
  }
  await act(async () => page.getByRole('button', { name: 'Show original message', exact: true }).hover());
  await expect.element(page.getByText('Peer：the exact source', { exact: true })).toBeVisible();
  await act(async () => page.getByRole('button', { name: 'Show original message', exact: true }).click());
  expect(reveal).toHaveBeenCalledOnce(); expect(jump).not.toHaveBeenCalled();
  await act(async () => page.getByRole('button', { name: /Jump to turn:/ }).click());
  expect(jump).toHaveBeenCalledExactlyOnceWith('input');
});
