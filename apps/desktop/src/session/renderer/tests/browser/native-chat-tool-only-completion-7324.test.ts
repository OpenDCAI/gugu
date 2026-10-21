import { afterEach, expect, it, vi } from 'vitest';
import { createChatContext } from '@session-chat/chat-context';
import { createChatView } from '@session-chat/chat-view';
import { createChatState } from '@session-chat/state/chat-state';
import { turnCompletionUnitDef } from '@session-chat/components/rows/turn-process/turn-completion.def';
import { createChatCaches } from '@session-chat/core/caches';
import { defaultChatTranslator } from '@session-chat/localization';
import type { TranscriptTurn } from '@gugu/session-core/acp/client';
import { nativeChatAppearance } from '@renderer/lib/chat/native-chat-appearance.css';
import { CHAT_COMPOSER_EDGE_FADE_PX } from '@session-chat/layout-geometry';
import { SEGMENTERS } from '@session-chat/components/engine/unit-registry';
import { until, untilStable } from '../../../../../../../tests/support/awaitCondition';

const TURN: TranscriptTurn = {
  id: 'tool-only', seq: 1, initiator: 'user', startedAt: 10_000,
  items: [
    { kind: 'message', id: 'prompt', seq: 0, role: 'user', text: 'Reply in the original chat' },
    { kind: 'mcp-tool-call', id: 'send', seq: 1, toolCallId: 'send-call', title: 'message_send',
      status: 'done', server: 'gugu', tool: 'message_send', outputText: 'replied (id=msg:sent)' },
  ],
};
let dispose: (() => void) | undefined;
afterEach(() => { dispose?.(); dispose = undefined; vi.restoreAllMocks(); });

function mount(composer: 'slot' | 'none' = 'none') {
  const context = createChatContext({ layout: { preset: 'double', userGutter: 72 }, translator: defaultChatTranslator });
  const state = createChatState(context);
  const host = document.createElement('div');
  host.className = nativeChatAppearance;
  host.style.cssText = 'position:fixed;top:0;left:0;width:640px;height:500px';
  document.body.append(host);
  const view = createChatView({ context, state, parent: host, composer });
  dispose = () => { view.dispose(); context.dispose(); state.dispose(); host.remove(); };
  const header = () => host.querySelector<HTMLElement>('[data-slot="turn-process"]');
  return { state, context, host, header, view };
}

it('shows end actions only after done; preserves inspection, the divider, and measured row height', async () => {
  const { state, context, host, header } = mount();
  state.transcript.activeTurn.set(TURN);
  await until('live tool-only header', () => header()?.dataset.live === 'true');
  expect(host.querySelector('[data-slot="turn-completion"]')).toBeNull();
  expect(header()!.dataset.expanded).toBe('true');

  state.transcript.activeTurn.set(null);
  state.transcript.history.seed([{ ...TURN, endedAt: 17_000, outcome: { kind: 'done', reason: 'end_turn' } }]);
  await until('end action strip', () => host.querySelector('[data-slot="turn-completion"]') != null);
  expect(header()!.dataset.live).toBe('false');
  expect(header()!.dataset.expanded).toBe('false');
  expect(host.querySelector('[data-chat-canvas]')!.textContent).not.toContain('MCP');
  expect(getComputedStyle(header()!, '::after').borderBottomWidth).toBe('1px');

  header()!.querySelector<HTMLElement>('[data-collapse-id]')!.click();
  await until('completed process opened', () => header()?.dataset.expanded === 'true');
  await untilStable('expanded geometry settles', () => host.querySelector<HTMLElement>('[data-chat-canvas]')!.offsetHeight);
  expect(host.querySelector('[data-chat-canvas]')!.textContent).toContain('message_send');
  expect(header()!.textContent).toContain('Took 7s');
  const caches = createChatCaches();
  const completion = host.querySelector<HTMLElement>('[data-slot="turn-completion"]')!;
  const button = completion.querySelector('button')!;
  expect(getComputedStyle(button).opacity).toBe('1');
  const writeText = vi.spyOn(navigator.clipboard, 'writeText').mockResolvedValue();
  button.click();
  expect(writeText).toHaveBeenCalledWith('message_send\nreplied (id=msg:sent)');
  const measured = turnCompletionUnitDef.measure(
    { kind: 'turn-completion', id: 'tool-only:completion', turnId: TURN.id, text: 'message_send' },
    { theme: context.theme, width: 640, isCollapsed: () => false, expanded: () => false, caches, expandedId: null },
    turnCompletionUnitDef.vars!,
  );
  expect(completion.offsetHeight).toBe(measured);
  caches.clearAll();
});

it('an unknown replay ending does not acquire end actions', async () => {
  const { state, host, header } = mount();
  state.transcript.history.seed([{ ...TURN, endedAt: 17_000 }]);
  await until('replayed header', () => header() != null);
  expect(header()!.textContent).toContain('Took 7s');
  expect(host.querySelector('[data-slot="turn-completion"]')).toBeNull();
});

it.each(['', '[NO_REPLY]'])('an invisible final value %j does not create another copyable assistant reply', async (text) => {
  const { state, host } = mount();
  state.transcript.history.seed([{
    ...TURN, endedAt: 17_000, outcome: { kind: 'done' },
    items: [...TURN.items, { kind: 'message', id: 'empty-final', seq: 2, role: 'assistant', text }],
  }]);
  await until('end actions mounted', () => host.querySelector('[data-slot="turn-completion"]') != null);
  expect(host.querySelectorAll('[data-slot="turn-completion"] button')).toHaveLength(1);
  expect(host.querySelector('[data-item-id="empty-final"]')).toBeNull();
});

it.each(['tail', 'end'] as const)('keeps the final row above a growing composer and its fade (%s)', async (alignment) => {
  const { state, host, view } = mount('slot');
  state.transcript.history.seed([{
    ...TURN, outcome: { kind: 'done' }, endedAt: 17_000,
    items: [TURN.items[0], { kind: 'message', id: 'answer', seq: 1, role: 'assistant', text: 'Visible answer.\n\n'.repeat(60) }],
  }]);
  await until('composer slot and answer mounted', () => view.composerSlot != null && host.querySelector('[data-item-id="answer"]') != null);
  const slot = view.composerSlot!;
  const composer = document.createElement('div');
  composer.style.height = '120px';
  slot.append(composer);
  const scroll = host.querySelector<HTMLElement>('[data-chat-scroll]')!;
  const settle = () => untilStable('scroll and composer settle', () => [scroll.scrollTop, scroll.scrollHeight, slot.getBoundingClientRect().height]);
  await settle();
  if (alignment === 'end') view.scrollToItem('answer', { align: 'end' });
  else view.scrollToBottom();
  await settle();
  const clearance = () => slot.getBoundingClientRect().top - host.querySelector<HTMLElement>('[data-item-id="answer"]')!.getBoundingClientRect().bottom;
  expect(clearance()).toBeGreaterThanOrEqual(CHAT_COMPOSER_EDGE_FADE_PX + 31);
  const before = slot.getBoundingClientRect().height;
  composer.style.height = '240px';
  await until('composer genuinely grew', () => slot.getBoundingClientRect().height > before);
  await settle();
  expect(clearance()).toBeGreaterThanOrEqual(CHAT_COMPOSER_EDGE_FADE_PX + 31);
});

it('keeps the last unit of one item end-aligned as the composer grows', async () => {
  // Production messages currently use one unit. Exercise the engine's supported
  // multi-unit item contract independently of that presentation choice.
  const segment = SEGMENTERS.message.segment;
  vi.spyOn(SEGMENTERS.message, 'segment').mockImplementation((item, ctx) => {
    const original = segment(item, ctx);
    if (item.id !== 'answer') return original;
    return ['First segment.', 'Middle segment.', 'Last segment.'].map((text, index) => ({
      ...original[0], id: `${item.id}#part-${index}`,
      data: { ...item, id: `${item.id}-part-${index}`, text: `${text}\n\n${'Paragraph content.\n\n'.repeat(5)}` },
    }));
  });
  const { state, host, view } = mount('slot');
  state.transcript.history.seed(['before', 'answer', 'after'].map<TranscriptTurn>((id, seq) => ({
    ...TURN, id: `turn-${id}`, seq, outcome: { kind: 'done' }, endedAt: 17_000,
    items: [
      { kind: 'message', id: `prompt-${id}`, seq: 0, role: 'user', text: id },
      { kind: 'message', id, seq: 1, role: 'assistant', text: id === 'answer' ? 'The multi-unit answer.' : 'Other content.\n\n'.repeat(30) },
    ],
  })));
  await until('composer slot mounts', () => view.composerSlot != null);
  const slot = view.composerSlot!;
  const composer = document.createElement('div');
  composer.style.height = '120px';
  slot.append(composer);
  const scroll = host.querySelector<HTMLElement>('[data-chat-scroll]')!;
  const settle = () => untilStable('multi-unit end alignment settles', () => [
    scroll.scrollTop, scroll.scrollHeight, slot.getBoundingClientRect().height,
  ]);
  await settle();
  view.scrollToItem('answer', { align: 'end' });
  await settle();
  const lastRow = () => [...host.querySelectorAll<HTMLElement>('[data-item-id="answer"]')]
    .find((row) => row.textContent?.includes('Last segment.'));
  expect(lastRow(), 'last source unit is rendered').toBeDefined();
  expect(host.querySelectorAll('[data-item-id="answer"]')).toHaveLength(3);
  const clearance = () => slot.getBoundingClientRect().top - lastRow()!.getBoundingClientRect().bottom;
  const expected = CHAT_COMPOSER_EDGE_FADE_PX + 32;
  expect(Math.abs(clearance() - expected)).toBeLessThanOrEqual(1);
  const before = slot.getBoundingClientRect().height;
  composer.style.height = '240px';
  await until('multi-unit composer grew', () => slot.getBoundingClientRect().height > before);
  await settle();
  expect(lastRow(), 'composer growth lost the last source unit').toBeDefined();
  expect(Math.abs(clearance() - expected)).toBeLessThanOrEqual(1);
});
