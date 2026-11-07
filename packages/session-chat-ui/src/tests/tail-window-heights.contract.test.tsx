/** @jsxImportSource solid-js */
import { afterEach, expect, it } from 'vitest';
import { page } from 'vitest/browser';
import { batch } from 'solid-js';
import { textFilePatch } from '@gugu/session-core/lib';
import { createChatContext } from '../chat-context';
import { createChatState } from '../state/chat-state';
import { createChatView } from '../chat-view';
import type { TranscriptTurn } from '../model';
import { until, untilStable } from '../../../../tests/support/awaitCondition';

const cleanup: (() => void)[] = [];
afterEach(() => { while (cleanup.length) cleanup.pop()?.(); });

it.each([390, 1024].flatMap(width => [false, true].flatMap(pin => [false, true].map(image => ({ width, pin, image })))))(
  'keeps a native user row visible after a 61-to-60 tail replacement (width=$width pin=$pin image=$image)', async ({ width, pin, image }) => {
  await page.viewport(width, 820);
  const context = createChatContext({ locale: () => 'en-US', layout: { preset: 'double', userGutter: 0, agentConversation: true },
    actor: id => id === 'user:fixture-agent' ? { id, name: 'Fixture peer', type: 'agent' } : null });
  const state = createChatState(context);
  const host = document.body.appendChild(document.createElement('div'));
  host.style.cssText = `position:fixed;left:0;top:0;width:${width}px;height:650px`;
  const view = createChatView({ context, state, parent: host, pinUserMessages: pin, stickToBottom: true, padBottom: 140 });
  cleanup.push(() => { view.dispose(); state.dispose(); context.dispose(); host.remove(); });
  const old: TranscriptTurn = { id: 'old', seq: 59, initiator: 'user', outcome: { kind: 'done' }, items: [
    { kind: 'message', id: 'old-user', seq: 0, role: 'user', text: 'Previous user input' },
    { kind: 'message', id: 'old-reply', seq: 1, role: 'assistant', text: 'Previous reply.\n\n'.repeat(25) },
    { kind: 'patch-tool-call', id: 'old-file', seq: 2, toolCallId: 'old-file', title: 'Edit old.md', status: 'done', contentBlocks: [textFilePatch('/fixture/old.md', null, 'ready')] },
  ] };
  const olderActivity = [1, 2].map((n): TranscriptTurn => ({ id: `old-a2a-${n}`, seq: n - 1, initiator: 'agent', outcome: { kind: 'done' }, items: [
    { kind: 'message', id: `old-a2a-message-${n}`, seq: 0, role: 'user', text: `<gugu_delivery route="session-direct" from="Fixture peer" from_id="user:fixture-agent" from_type="agent" msg="msg:old-${n}"><![CDATA[Old activity ${n}]]></gugu_delivery>` },
  ] }));
  const middle = Array.from({ length: 57 }, (_, n): TranscriptTurn => ({ id: `middle-${n}`, seq: n + 2, initiator: 'user', outcome: { kind: 'done' }, items: [
    { kind: 'message', id: `middle-reply-${n}`, seq: 0, role: 'assistant', text: `Earlier assistant reply ${n}` },
  ] }));
  const initialHistory = [...olderActivity, ...middle, old];
  state.transcript.history.seed(initialHistory);
  const activity = { id: 'receiving-activity', text: '<gugu_delivery route="session-direct" from="Fixture peer" from_id="user:fixture-agent" from_type="agent" msg="msg:fixture-prior"><![CDATA[Prior pending activity]]></gugu_delivery>',
    held: true, received: true, delivery: { state: 'receiving' as const }, afterTurnId: old.id };
  state.session.setPendingMessages([activity]);
  await until('receiving A2A header visible before sending', () => !!host.querySelector('[data-agent-activity]'));
  await untilStable('receiving A2A geometry settles', () => host.querySelector('[data-chat-canvas]')?.getBoundingClientRect().height);
  const own = { id: 'new-own-message', text: 'My new input after the pending Agent activity', held: true, delivery: { state: 'receiving' as const }, afterTurnId: old.id };
  const attachments = image ? [1, 2].map(n => ({ id: `fixture-image-${n}`, name: `fixture-${n}.jpg`, kind: 'image' as const, mimeType: 'image/jpeg' as const })) : undefined;
  const sample = async (phase: string) => {
    const bubble = () => host.querySelector<HTMLElement>('[data-agent-conversation-message="new-own-message"], [data-agent-conversation-message="native-own"]');
    await until(`own input mounted after ${phase}`, () => !!bubble());
    await untilStable(`own input settles after ${phase}`, () => [bubble()?.getBoundingClientRect().top, bubble()?.getBoundingClientRect().height]);
    const rect = bubble()!.getBoundingClientRect();
    expect(rect.height, phase).toBeGreaterThan(0);
    if (image) expect(bubble()!.querySelectorAll('[data-attachment-chip]').length, phase).toBe(2);
    expect(rect.bottom, phase).toBeGreaterThan(0);
    expect(rect.top, phase).toBeLessThan(650);
  };
  view.setScrollMode({ kind: 'tail' });
  state.session.setPendingPrompt({ ...own, attachments });
  await sample('own-send-before-prior-receipt');
  const committedActivity: TranscriptTurn = { id: 'committed-activity', seq: 60, initiator: 'agent', outcome: { kind: 'done' }, items: [
    { kind: 'message', id: 'native-activity', seq: 0, role: 'user', text: activity.text },
  ] };
  const longerHistory = [...initialHistory, committedActivity];
  batch(() => { state.transcript.history.seed(longerHistory); state.session.setPendingMessages([]); });
  await sample('prior-activity-commits');
  const native: TranscriptTurn = { id: 'own-live-turn', seq: 61, initiator: 'user', items: [
    { kind: 'message', id: 'native-own', seq: 0, role: 'user', text: own.text, attachments, _meta: { guguClientMessageId: own.id } },
  ] };
  batch(() => { state.transcript.activeTurn.set(native); state.session.setPendingPrompt(null); });
  await sample('own-native-echo');
  // The host's 60-turn tail page evicts exactly one hidden A2A child.
  // Its zero-height index must not be inherited by the unchanged active user row.
  const tailWindow = longerHistory.slice(-60);
  batch(() => { state.transcript.history.seed(tailWindow); state.transcript.activeTurn.set(native); });
  expect(state.transcript.state.activeTurnSnapshot?.items.some(item => item.id === 'native-own'), 'the native source still contains the user row').toBe(true);
  await untilStable('tail window geometry settles after older prefix is omitted', () => host.querySelector('[data-chat-canvas]')?.getBoundingClientRect().height);
  const nativeBubble = host.querySelector<HTMLElement>('[data-agent-conversation-message="native-own"]');
  const nativeHeight = nativeBubble?.getBoundingClientRect().height ?? 0;
  expect(nativeBubble, 'a native user row must remain mounted when a tail reload omits older prefix').not.toBeNull();
  expect(nativeHeight).toBeGreaterThan(0);
  await sample('tail-window-replaces-older-prefix');
  if (image && !pin) await page.screenshot({ element: host, path: `__screenshots__/tail-window-${width}.png` });
});
