/** @jsxImportSource solid-js */
/**
 * Chromium contract: a live turn that keeps adding steps only touches the step that changed.
 *
 * The running turn is segmented again on every update. Each pass used to return new unit objects for every step, so the
 * process-steps list (keyed by object identity) unmounted and rebuilt every step row of the turn and re-measured all of
 * them: per update O(steps), per turn O(steps²). A 300-step turn reached 2 s tasks per update on gpu and froze the
 * renderer on a slower machine (2026-11-05). Reading: the DOM node of the first step survives later updates.
 * Positive control: the newest step does appear, so a list that stopped updating cannot pass.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { createChatContext } from '@session-chat/chat-context';
import { createChatView } from '@session-chat/chat-view';
import { createChatState } from '@session-chat/state/chat-state';
import type { TranscriptItem, TranscriptTurn } from '@session-chat/model';
import { until, untilStable } from '../../../../tests/support/awaitCondition';

const disposers: (() => void)[] = [];
afterEach(() => disposers.splice(0).forEach(dispose => dispose()));

function liveTurn(steps: number): TranscriptTurn {
  const items: TranscriptItem[] = [{ kind: 'message', id: 'u', seq: 0, role: 'user', text: 'Run the steps.' }];
  for (let step = 1; step <= steps; step++) {
    items.push({ kind: 'execute-tool-call', id: `run-${step}`, seq: step * 2 - 1, toolCallId: `run-${step}`, toolName: 'Bash',
      title: `echo step ${step}`, command: `echo step ${step}`, status: step === steps ? 'running' : 'done' } as TranscriptItem);
    if (step < steps) items.push({ kind: 'message', id: `say-${step}`, seq: step * 2, role: 'assistant', text: `Step ${step} printed its line.` });
  }
  return { id: 'live', seq: 0, initiator: 'user', startedAt: 1000, items };
}

describe('live turn steps', () => {
  it('keeps earlier step rows mounted while new steps arrive', async () => {
    const context = createChatContext({ locale: () => 'en-US' });
    context.setLayout({ preset: 'double', userGutter: 72, agentConversation: true });
    const state = createChatState(context);
    const host = document.createElement('div');
    host.style.cssText = 'position:fixed;inset:0;width:900px;height:1000px';
    document.body.append(host);
    const view = createChatView({ context, state, parent: host, commands: { conversationClock: () => 22000 } });
    disposers.push(() => { view.dispose(); state.dispose(); context.dispose(); host.remove(); });
    const steps = () => [...host.querySelectorAll<HTMLElement>('[data-process-step]')];

    state.transcript.activeTurn.set(liveTurn(6));
    await until('process steps appear', () => steps().length, (n) => n > 0);
    await untilStable('steps settle', () => steps().length);
    const first = steps()[0];

    for (const next of [7, 8, 9]) {
      state.transcript.activeTurn.set(liveTurn(next));
      await until(`step ${next - 1} reply on screen`, () => host.textContent ?? '', (text) => text.includes(`Step ${next - 1} printed its line.`));
    }
    await untilStable('steps settle', () => steps().length);

    expect(steps()[0], 'the first step row was rebuilt by a later update').toBe(first);
  });
});
