/** @jsxImportSource solid-js */
import { afterEach, describe, expect, it } from 'vitest';
import { createChatContext } from '@session-chat/chat-context';
import { createChatView } from '@session-chat/chat-view';
import { createChatState } from '@session-chat/state/chat-state';
import type { TranscriptTurn } from '@session-chat/model';
import { until } from '../../../../tests/support/awaitCondition';

const cleanups: (() => void)[] = [];
afterEach(() => cleanups.splice(0).forEach(fn => fn()));
const empty = (id: string): TranscriptTurn => ({ id, seq: 0, initiator: 'agent', startedAt: 1000, endedAt: 4000,
  outcome: { kind: 'done' }, items: [{ kind: 'message', id: `${id}-silence`, seq: 0, role: 'assistant', text: '[NO_REPLY]' }],
});
function mount() {
  const context = createChatContext();
  context.setLayout({ preset: 'double', userGutter: 72, agentConversation: true });
  const state = createChatState(context);
  const host = document.createElement('div');
  host.style.cssText = 'position:fixed;inset:0;width:800px;height:800px';
  document.body.append(host);
  const view = createChatView({ context, state, parent: host });
  cleanups.push(() => { view.dispose(); state.dispose(); context.dispose(); host.remove(); });
  const head = (id: string) => host.querySelector(`[data-item-id="${id}:process"]`);
  return { state, head, host };
}

describe('historical empty turns across transcript tiers', () => {
  it('removes the previous empty process row on incremental history append', async () => {
    const { state, head } = mount();
    const first = empty('old');
    state.transcript.history.seed([first]);
    await until('the last empty acknowledgement is shown', () => !!head('old'));
    state.transcript.history.seed([first, empty('new')]);
    await until('a newer acknowledgement is shown', () => !!head('new'));
    expect(head('old')).toBeNull();
  });

  it('removes the committed empty process when a new active turn starts, and retains the new empty completion', async () => {
    const { state, head } = mount();
    state.transcript.history.seed([empty('old')]);
    await until('the old last turn is visible', () => !!head('old'));
    state.transcript.activeTurn.set({ ...empty('live'), endedAt: undefined, outcome: undefined,
      items: [{ kind: 'message', id: 'next-input', seq: 0, role: 'user', text: 'Next input' }] });
    await until('the live turn shows its process', () => !!head('live'));
    expect(head('old')).toBeNull();
    state.transcript.activeTurn.set(null);
    state.transcript.history.seed([empty('old'), empty('live')]);
    await until('the empty completed last turn is shown', () => !!head('live'));
    expect(head('old')).toBeNull();
  });

  it('keeps the day boundary when hiding the previous empty turn across tiers', async () => {
    const { state, head, host } = mount();
    const yesterday = { ...empty('yesterday'), startedAt: new Date(2026, 9, 28, 12).getTime(),
      items: [{ kind: 'message' as const, id: 'answer', seq: 0, role: 'assistant' as const, text: 'Previous answer' }] };
    const today = new Date(2026, 9, 29, 12).getTime();
    state.transcript.history.seed([yesterday, { ...empty('old'), startedAt: today }]);
    await until('latest empty day is rendered', () => !!head('old'));
    state.transcript.activeTurn.set({ ...empty('live'), startedAt: today, endedAt: undefined, outcome: undefined, items: [] });
    await until('new turn has a process', () => !!head('live'));
    expect(head('old')).toBeNull();
    expect(host.querySelector('[data-item-id="live:day"]')).not.toBeNull();
  });
});
