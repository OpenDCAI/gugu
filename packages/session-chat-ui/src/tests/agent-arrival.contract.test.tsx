/** @jsxImportSource solid-js */
import { afterEach, describe, expect, it } from 'vitest';
import { page } from 'vitest/browser';
import { batch } from 'solid-js';
import { createChatContext } from '../chat-context';
import { createChatState } from '../state/chat-state';
import { createChatView } from '../chat-view';
import { projectSessionPendingDeliveries } from '../../../../apps/desktop/src/lib/pendingSessionDeliveries';
import type { LifeView } from '../../../../apps/desktop/src/session/shared/core/sessions/session-life';
import type { TranscriptTurn } from '../model';
import { until, untilStable } from '../../../../tests/support/awaitCondition';

const sender = 'user:11111111-1111-4111-8111-111111111111';
const messageId = '20160000-1111-4111-8111-111111111111';
const ordinaryId = 'ordinary-arrival';
const cleanup: Array<() => void> = [];
afterEach(() => { while (cleanup.length) cleanup.pop()?.(); });

describe('incoming Agent activity first paint', () => {
  it.each(['light', 'dark'] as const)('never exposes an incoming host receipt as an ordinary bubble (%s)', async theme => {
    await page.viewport(390, 720);
    const context = createChatContext({ locale: () => 'en-US', layout: { preset: 'double', agentConversation: true, userGutter: 0 },
      actor: id => id === sender ? { id, type: 'agent', name: 'Arrival sender' } : null });
    const state = createChatState(context);
    const host = document.body.appendChild(document.createElement('div'));
    host.style.cssText = 'position:fixed;top:0;left:0;width:390px;height:600px;background:var(--chat-bg);color:var(--chat-fg)';
    host.classList.add(theme === 'dark' ? 'emdark' : 'emlight');
    const view = createChatView({ context, state, parent: host });
    cleanup.push(() => { view.dispose(); state.dispose(); context.dispose(); host.remove(); });
    const text = `<gugu_delivery route="session-direct" from="Arrival sender" from_id="${sender}" from_type="agent" msg="msg:${messageId}"><![CDATA[Controlled incoming Agent activity.]]></gugu_delivery>`;
    const life: LifeView = { sessionId: 'arrival-test', version: 1, kind: 'ready', stage: null, hold: null, failure: null,
      lastExit: null, nativeSession: null, pending: { count: 2, items: [{ seq: 1, messageId, text, preview: 'Controlled incoming Agent activity.',
        kind: 'session-direct', state: 'queued', failure: null, sentAt: 10000 },
      { seq: 2, messageId: ordinaryId, text: 'Ordinary input remains immediate.', preview: 'Ordinary input remains immediate.',
        kind: 'session-direct', state: 'queued', failure: null, sentAt: 10001 }] } };
    const samples: Array<{ phase: string; plain: boolean; group: boolean; ordinary: boolean }> = [];
    const sample = (phase: string) => {
      const bubble = host.querySelector<HTMLElement>(`[data-agent-conversation-message="${messageId}"]`);
      const ordinary = host.querySelector<HTMLElement>(`[data-agent-conversation-message="${ordinaryId}"]`);
      samples.push({ phase, plain: !!bubble && bubble.getBoundingClientRect().height > 0,
        ordinary: !!ordinary && ordinary.getBoundingClientRect().height > 0,
        group: [...host.querySelectorAll<HTMLElement>('[data-activity-read-ids]')].some(row =>
          (JSON.parse(row.dataset.activityReadIds ?? '[]') as string[]).includes(messageId)) });
    };
    // The same host-receipt projector is used by desktop and the mobile conversation.
    state.session.setPendingMessages(projectSessionPendingDeliveries([], life, []));
    for (let i = 0; i < 5; i++) await new Promise<void>(resolve => requestAnimationFrame(() => { sample(`receiving-${i}`); resolve(); }));
    await page.screenshot({ element: host, path: `__screenshots__/arrival-receiving-${theme}.png` });
    const native: TranscriptTurn = { id: 'native-arrival', seq: 1, initiator: 'agent', outcome: { kind: 'done' },
      items: [{ kind: 'message', id: messageId, seq: 0, role: 'user', text }] };
    const ordinaryNative: TranscriptTurn = { id: 'native-ordinary', seq: 2, initiator: 'user', outcome: { kind: 'done' },
      items: [{ kind: 'message', id: ordinaryId, seq: 0, role: 'user', text: 'Ordinary input remains immediate.' }] };
    batch(() => { state.transcript.history.seed([native, ordinaryNative]); state.session.setPendingMessages([]); });
    await until('native echo is folded', () => !!host.querySelector('[data-agent-activity]'));
    await untilStable('native echo geometry', () => host.querySelector('[data-agent-activity]')?.getBoundingClientRect().height);
    sample('native-echo');
    await page.screenshot({ element: host, path: `__screenshots__/arrival-native-echo-${theme}.png` });
    expect(samples, 'the first painted host receipt must already belong to its closed Agent activity').toEqual([
      ...Array.from({ length: 5 }, (_, i) => ({ phase: `receiving-${i}`, plain: false, group: true, ordinary: true })),
      { phase: 'native-echo', plain: false, group: true, ordinary: true },
    ]);
  });
});
