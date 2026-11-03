import { afterEach, expect, it, vi } from 'vitest';
import { cdp, page, userEvent } from 'vitest/browser';
import { act } from 'react';
import { createReactHarness, message, renderWithAppProviders } from '../../../../../../../tests/support/testHarness';
import { until } from '../../../../../../../tests/support/awaitCondition';
import '@/styles/tokens.css';
import '@renderer/index.css';

vi.mock('@gugu/core/cloud/config', async (original) => ({ ...(await original<object>()), getSupabaseUrl: () => 'http://supabase.test.local', getSupabaseAnonKey: () => 'test-anon-key' }));
vi.mock('@/hooks/useAgentHarnessIdentity', () => ({ useAgentHarnessIdentity: () => 'codex' }));
const { MessageBubble } = await import('@/components/chat/MessageBubble');
const { readHoverOwner, subscribeHoverOwner } = await import('@/components/chat/hover-owner');

let harness: ReturnType<typeof createReactHarness>;
const replies: string[] = [];
afterEach(() => { harness?.cleanup(); replies.length = 0; });

async function mount(enabled = true, topClamp = false, short = false, isMine = true) {
  await page.viewport(1280, 800);
  // The pointer starts off the list: a row that renders under a resting pointer opens its pill at once, and the case
  // would start from whatever an earlier file left there.
  await move(5, 500);
  harness = createReactHarness();
  harness.container.className = 'gugu-skin emlight';
  harness.container.style.cssText = `position:fixed;left:20px;top:20px;width:1000px;height:600px;padding-top:${topClamp ? 0 : 100}px`;
  harness.container.dataset.testid = 'chat-message-list';
  await renderWithAppProviders(harness, <>
    {['previous', 'target'].map((id) => <MessageBubble key={id}
      msg={message({ id, is_mine: isMine, content: short ? "Hi" : `${id}: a continuous hover target for the action pill. Move between emoji, reply, and more while the previous message is underneath.` })}
      isGroup compactMobile={!enabled} groupedWithPrev={id === 'target'} groupedWithNext={id === 'previous'}
      onReaction={() => {}} onQuote={(msg) => replies.push(msg.id)} onForward={() => {}} onDelete={() => {}} />)}
  </>);
  const rows = [...harness.container.querySelectorAll<HTMLElement>('[data-testid="message-bubble-action-target"]')];
  expect(rows).toHaveLength(2);
  return rows[1];
}

async function move(x: number, y: number) {
  await sweep([{ x, y }]);
}

/** CDP uses top-page coordinates; map through every test frame's scale and border while keeping one stream of moves. */
async function sweep(points: readonly { x: number; y: number }[]) {
  const session = cdp() as unknown as { send: (method: string, params: object) => Promise<unknown> };
  await act(async () => {
    await Promise.all(points.map(({ x, y }) => {
      for (let current: Window = window; current.frameElement; current = current.parent) {
        const frame = current.frameElement as HTMLElement, box = frame.getBoundingClientRect();
        const scale = box.width / frame.offsetWidth;
        x = box.left + (frame.clientLeft + x) * scale;
        y = box.top + (frame.clientTop + y) * scale;
      }
      return session.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y });
    }));
  });
}

const pills = () => [...document.querySelectorAll<HTMLElement>('[data-testid="message-hover-actions"]')];
/** The one open pill is the target row's own (Base UI marks the open trigger), not another row's. */
const targetPillOpen = (target: HTMLElement) => pills().length === 1 && !!target.closest('[data-message-bubble-row]')?.hasAttribute('data-popup-open');

it.each([false, true].flatMap((topClamp) => [false, true].flatMap((isMine) => [false, true].map((visited) => ({ topClamp, isMine, visited })))))('keeps its pill across the previous row, button gaps and padding ($topClamp/$isMine/visited:$visited)', async ({ topClamp, isMine, visited }) => {
  const target = await mount(true, topClamp, false, isMine);
  if (visited) {
    const previous = harness.container.querySelector<HTMLElement>('[data-message-bubble-row]')!;
    await userEvent.hover(previous);
    await until('the previous row has opened before this crossing', () => previous.hasAttribute('data-popup-open'));
    await move(5, 500);
    await until('the previous row has closed', () => pills().length === 0);
  }
  await userEvent.hover(target);
  await until('target pill opens', () => targetPillOpen(target));
  const pill = pills()[0];
  await until('the pill finishes entering', () => getComputedStyle(pill).opacity === '1' && !pill.hasAttribute('data-starting-style') && pill.getAnimations().every((animation) => animation.playState === 'finished'));
  const buttons = [...pill.querySelectorAll('button')];
  expect(buttons.every((button) => !!button.getAttribute('aria-label'))).toBe(true);
  const start = target.getBoundingClientRect();
  const rects = buttons.map((button) => button.getBoundingClientRect());
  const gap = { x: (rects[0].right + rects[1].left) / 2, y: rects[0].top + rects[0].height / 2 };
  const box = pill.getBoundingClientRect();
  // Follow the same diagonal pointer path used against the native parent build.
  const from = { x: start.left + start.width / 2, y: start.top + start.height / 2 };
  // Watched for the whole stream: the pill node never leaves the document and the target row never hands the pill over.
  const owner = readHoverOwner();
  const handovers: unknown[] = [];
  const offOwner = subscribeHoverOwner(() => handovers.push(readHoverOwner()));
  let disconnects = 0;
  const observer = new MutationObserver(() => { if (!pill.isConnected && disconnects === 0) disconnects++; });
  observer.observe(document.body, { childList: true, subtree: true });
  await sweep(Array.from({ length: 60 }, (_, index) => ({ x: from.x + (gap.x - from.x) * (index + 1) / 60, y: from.y + (gap.y - from.y) * (index + 1) / 60 })));
  observer.disconnect();
  offOwner();
  expect(owner, 'the target row owns the pill when the crossing starts').not.toBeNull();
  expect(disconnects, 'the original pill is never removed during the crossing').toBe(0);
  expect(handovers, 'no other row takes the pill during the crossing').toEqual([]);
  expect(pill.isConnected, 'the original message retains its popup throughout the crossing').toBe(true);
  for (const point of [gap, { x: (rects[1].right + rects[2].left) / 2, y: gap.y }, { x: box.left + 2, y: gap.y }]) {
    await move(point.x, point.y);
    expect(pill.contains(document.elementFromPoint(point.x, point.y))).toBe(true);
    expect(pill.isConnected).toBe(true);
  }
  expect(pills(), 'the previous message must not open a competing pill').toHaveLength(1);
  expect(box.top, 'the existing placement is preserved').toBeCloseTo(Math.max(start.top - box.height - 2, harness.container.getBoundingClientRect().top + 8), 3);
  await userEvent.click(buttons[1]);
  expect(replies).toEqual(['target']);
  await move(5, 500);
  await until('leaving the row and popup closes the pill', () => !pill.isConnected);
});

it('keeps mouse hover disabled on the phone', async () => {
  const target = await mount(false);
  await userEvent.hover(target);
  expect(pills()).toHaveLength(0);
});

it.each([true, false])('keeps short-message actions within the viewport (isMine: %s)', async (isMine) => {
  const target = await mount(true, true, true, isMine);
  await userEvent.hover(target);
  await until('short-message actions open', () => targetPillOpen(target));
  const pill = pills()[0];
  await until('the short-message pill finishes entering', () => !pill.hasAttribute('data-starting-style') && pill.getAnimations().every((animation) => animation.playState === 'finished'));
  const rect = pill.getBoundingClientRect(), viewport = harness.container.getBoundingClientRect();
  expect(rect.left).toBeGreaterThanOrEqual(viewport.left);
  expect(rect.right).toBeLessThanOrEqual(viewport.right);
  expect(rect.top).toBeGreaterThanOrEqual(viewport.top);
});
