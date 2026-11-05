import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createReactHarness } from '../../../../../../../tests/support/testHarness';
import { SessionTimeline } from '../../features/sessions/view/session-timeline';
import { READING_LINE } from '../../features/sessions/view/session-timeline-geometry';
const scope = vi.hoisted(() => ({ turns: Array.from({ length: 64 }, (_, i) => ({ id: `turn-${i}`, anchorItemId: `item-${i}`, itemIds: [`item-${i}`], prompt: `Input ${i}`, reply: '' })) }));
vi.mock('@renderer/features/sessions/acp/acp-chat-resource-manager', () => ({ findAcpChatStore: () => ({ chatState: { transcript: {}, session: {} } }) }));
vi.mock('@renderer/features/sessions/stores/session-registry', () => ({ sessionRegistry: { get: () => undefined } }));
vi.mock('@renderer/lib/chat/shared-chat-context', () => ({ getSharedChatContext: () => ({ selfIdentity: () => null }) }));
vi.mock('../../features/sessions/view/use-transcript-timeline', () => ({ useTranscriptTimeline: (_t: unknown, _s: unknown, select: (turns: typeof scope.turns) => unknown) => select(scope.turns) }));
vi.mock('../../features/sessions/view/session-timeline-rail', () => ({ SessionTimelineRail: ({ railRef, currentTurnId }: { railRef: React.Ref<HTMLElement>; currentTurnId: string | null }) => <nav ref={railRef} data-reading-turn={currentTurnId ?? ''} /> }));
let harness: ReturnType<typeof createReactHarness>;
let cleaned: boolean;
beforeEach(() => { harness = createReactHarness(); cleaned = false; });
afterEach(() => { if (!cleaned) harness.cleanup(); vi.restoreAllMocks(); });
const nextFrame = () => new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
async function mount() {
  await harness.render(<div><div data-chat-scroll style={{ height: 160, width: 320, overflow: 'auto' }}>{scope.turns.map(t => <div key={t.id} data-item-id={t.anchorItemId} style={{ height: 80 }}><span>{t.prompt}</span></div>)}</div><SessionTimeline sessionId="qa" /></div>);
  const scroller = harness.container.querySelector<HTMLElement>('[data-chat-scroll]')!;
  await vi.waitFor(() => expect(harness.container.querySelector('nav')?.getAttribute('data-reading-turn')).toBe('turn-0'));
  return scroller;
}
it('does not read row geometry while streamed text mutates the transcript', async () => {
  let reads = 0;
  const original = HTMLElement.prototype.getBoundingClientRect;
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
    if (this.hasAttribute('data-item-id')) reads++;
    return original.call(this);
  });
  const scroller = await mount(); reads = 0;
  for (let i = 0; i < 16; i++) {
    await act(async () => {
      scroller.querySelector('span')!.textContent = `stream ${i}`;
      await nextFrame(); await nextFrame();
    });
  }
  expect(reads).toBe(0);
  expect(harness.container.querySelector('nav')?.getAttribute('data-reading-turn')).toBe('turn-0');
});
it('tracks the reading line through scrolling, row replacement and cleanup', async () => {
  const scroller = await mount();
  await act(async () => { scroller.scrollTop = 80 - READING_LINE + 2; });
  await vi.waitFor(() => expect(harness.container.querySelector('nav')?.getAttribute('data-reading-turn')).toBe('turn-1'));
  const firstRow = scroller.firstElementChild!;
  await act(async () => { firstRow.remove(); scroller.scrollTop = 0; });
  await vi.waitFor(() => expect(harness.container.querySelector('nav')?.getAttribute('data-reading-turn')).toBe('turn-1'));
  const disconnect = vi.spyOn(IntersectionObserver.prototype, 'disconnect');
  scroller.prepend(firstRow);
  harness.cleanup(); cleaned = true;
  expect(disconnect).toHaveBeenCalled();
});

it('rebinds a replaced scroll root and follows recycled row identities', async () => {
  const scroller = await mount();
  const replacement = scroller.cloneNode(true) as HTMLElement;
  await act(async () => { scroller.replaceWith(replacement); });
  await vi.waitFor(() => expect(harness.container.querySelector('nav')?.getAttribute('data-reading-turn')).toBe('turn-0'));
  await act(async () => { replacement.firstElementChild!.setAttribute('data-item-id', 'item-4'); });
  await vi.waitFor(() => expect(harness.container.querySelector('nav')?.getAttribute('data-reading-turn')).toBe('turn-4'));
  replacement.replaceWith(scroller);
});

it('tracks exact-edge entry and exit before and after the reading line', async () => {
  const scroller = await mount();
  for (const [top, expected] of [[137, 'turn-2'], [200, 'turn-2'], [240 - READING_LINE, 'turn-3'], [0, 'turn-0'], [80 - READING_LINE, 'turn-1']] as const) {
    await act(async () => { scroller.scrollTop = top; });
    await vi.waitFor(() => expect(harness.container.querySelector('nav')?.getAttribute('data-reading-turn')).toBe(expected));
  }
});
