import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { page } from 'vitest/browser';
import { act } from 'react';
import { ContentMenu } from '@/components/ContentMenu';
import type { ContentContextMenu } from '@/session/shared/content-context-menu';
import { createReactHarness } from '../../../../../../../tests/support/testHarness';
import { until } from '../../../../../../../tests/support/awaitCondition';
import '@/styles/tokens.css';

let harness: ReturnType<typeof createReactHarness>;
beforeEach(() => page.viewport(390, 844));
afterEach(() => { harness?.cleanup(); document.getSelection()?.removeAllRanges(); });

async function openSelectedTextMenu() {
  harness = createReactHarness();
  const previous = <p data-testid="previous" style={{ position: 'absolute', top: 120, left: 24 }}>Previous message words</p>;
  const text = <p data-testid="sample" style={{ margin: '240px 24px 0', width: 300, font: '16px/1.6 sans-serif' }}>The harbor stirred at dawn.</p>;
  await harness.render(<>{previous}{text}</>);
  const node = harness.container.querySelector('[data-testid="sample"]')!.firstChild!;
  const range = document.createRange(); range.setStart(node, 4); range.setEnd(node, 10);
  const selection = document.getSelection()!; selection.removeAllRanges(); selection.addRange(range);
  const rect = range.getBoundingClientRect();
  const menu: ContentContextMenu & { selectionRange: Range } = {
    requestId: 'selected-text', x: rect.x + rect.width / 2, y: rect.y + rect.height / 2,
    items: [{ id: 'copy', label: 'Copy selected text' }], selectionRange: range.cloneRange(),
  };
  const onAction = vi.fn(), onClose = vi.fn();
  const focusedBefore = document.activeElement;
  await harness.render(<>{previous}{text}<ContentMenu menu={menu} onClose={onClose} onAction={onAction} /></>);
  await until('copy menu is visible', () => !!document.querySelector('[role="menu"]'));
  await until('copy menu position is resolved', () => !!(document.querySelector('[role="menu"]')!.parentElement!.style.getPropertyValue('--anchor-width')));
  return { selection, node, focusedBefore, onAction, rect };
}

it('keeps the native text selection and focus when the copy menu opens', async () => {
  const { selection, focusedBefore } = await openSelectedTextMenu();
  expect(selection.toString()).toBe('harbor');
  expect(document.activeElement).toBe(focusedBefore);
});

it('leaves the fixed endpoint hittable when the selected range changes', async () => {
  const { selection, node } = await openSelectedTextMenu();
  const endpointIsText = () => {
    const caret = document.createRange(); caret.setStart(node, 10); caret.collapse(true);
    const rect = caret.getBoundingClientRect();
    return document.elementFromPoint(rect.x - 1, rect.y + rect.height / 2)?.closest('p') === node.parentElement;
  };
  expect(endpointIsText()).toBe(true);
  const previous = harness.container.querySelector('[data-testid="previous"]')!;
  await act(async () => selection.setBaseAndExtent(node, 10, previous.firstChild!, 0));
  await until('menu follows the cross-message selection', () => document.querySelector('[role="menu"]')!.getBoundingClientRect().bottom < previous.getBoundingClientRect().top);
  expect(endpointIsText()).toBe(true);
  expect(selection.toString()).toContain('Previous message words');
});

it('keeps the copy action available and preserves the adjusted selection on press', async () => {
  const { selection, node, onAction } = await openSelectedTextMenu();
  const popup = document.querySelector('[role="menu"]')!;
  expect(getComputedStyle(popup.querySelector('[role="menuitem"]')!).fontWeight).toBe(getComputedStyle(popup).fontWeight);
  await act(async () => selection.setBaseAndExtent(node, 0, node, 10));
  await act(async () => page.getByRole('menuitem', { name: 'Copy selected text' }).click());
  expect(onAction).toHaveBeenCalledWith('copy');
  expect(selection.toString()).toBe('The harbor');
});

it('keeps endpoints available for a viewport-spanning range', async () => {
  const { selection, node } = await openSelectedTextMenu();
  const previous = harness.container.querySelector<HTMLElement>('[data-testid="previous"]')!;
  const sample = harness.container.querySelector<HTMLElement>('[data-testid="sample"]')!;
  const beforeTop = document.querySelector('[role="menu"]')!.getBoundingClientRect().top;
  await act(async () => {
    previous.style.top = '0px'; sample.style.marginTop = '780px';
    selection.setBaseAndExtent(node, 10, previous.firstChild!, 0);
  });
  await until('tall selection repositioned', () => Math.abs(document.querySelector('[role="menu"]')!.getBoundingClientRect().top - beforeTop) > 1);
  const popup = document.querySelector('[role="menu"]')!.getBoundingClientRect();
  const caret = document.createRange(); caret.setStart(node, 10); caret.collapse(true);
  const endpoint = caret.getBoundingClientRect();
  expect(document.elementFromPoint(endpoint.x - 1, endpoint.y + endpoint.height / 2)?.closest('p')).toBe(node.parentElement);
  caret.setStart(previous.firstChild!, 0); caret.collapse(true);
  const first = caret.getBoundingClientRect();
  expect(document.elementFromPoint(first.x + 1, first.y + first.height / 2)?.closest('p')).toBe(previous);
  expect(popup.top).toBeGreaterThanOrEqual(0);
  expect(popup.bottom).toBeLessThanOrEqual(innerHeight);
});
