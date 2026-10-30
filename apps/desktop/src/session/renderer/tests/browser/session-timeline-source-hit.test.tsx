import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { page } from 'vitest/browser';
import { act } from 'react';
import { getLocaleSnapshot, setLocalePreference, type LocalePreference } from '@/i18n';
import { translateSessionMessage } from '../../localization/locale-store';
import { SessionTimelineRail } from '../../features/sessions/view/session-timeline-rail';
import { ConversationSourcePopover } from '../../lib/chat/conversation-source-popover';
import { createReactHarness, renderWithAppProviders } from '../../../../../../../tests/support/testHarness';
import '@/styles/tokens.css';
import '@renderer/index.css';

let harness: ReturnType<typeof createReactHarness>;
let previousLocale: LocalePreference;
beforeEach(async () => {
  previousLocale = getLocaleSnapshot().preference;
  // Playwright retains its pointer between cases. Start outside the fixture so mounting a
  // new trigger cannot inherit a hover or an open preview from the previous case.
  const away = document.createElement('div');
  away.dataset.testid = 'source-test-pointer-away';
  away.style.cssText = 'position:fixed;right:4px;bottom:4px;width:10px;height:10px;z-index:2147483647';
  document.body.append(away);
  try { await page.getByTestId('source-test-pointer-away').hover(); } finally { away.remove(); }
});
afterEach(async () => {
  harness?.cleanup();
  await act(async () => setLocalePreference(previousLocale));
});
it.each(['en-US', 'zh-CN'] as const)('keeps every source-arrow hit point outside the timeline navigation lane (%s)', async locale => {
  await act(async () => setLocalePreference(locale));
  const reveal = vi.fn(), jump = vi.fn(); harness = createReactHarness();
  const prompt = 'Earlier background command';
  await renderWithAppProviders(harness, <div style={{ position: 'relative', width: 220, height: 300 }}>
    <SessionTimelineRail turns={[{ id: 'turn', anchorItemId: 'input', itemIds: ['input'], prompt, reply: 'Finished' }]} currentTurnId="turn" onJump={jump} />
    <div data-content style={{ position: 'absolute', left: 40, top: 141 }}>
      <ConversationSourcePopover label="Show original message" text="Peer：the exact source" onOpenOriginal={reveal} />
    </div>
  </div>, { contacts: {} });
  const navigation = page.getByRole('button', { name: translateSessionMessage('task.jumpToTurn', { prompt }), exact: true });
  await expect.element(navigation).toBeVisible();
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
  const rail = harness.container.querySelector<HTMLElement>('[data-region="session-timeline"]')!;
  const ticks = rail.querySelectorAll<HTMLButtonElement>('button');
  expect(ticks).toHaveLength(1);
  await expect.element(navigation).toBeVisible();
  await act(async () => navigation.click());
  expect(jump).toHaveBeenCalledExactlyOnceWith('input');
});
