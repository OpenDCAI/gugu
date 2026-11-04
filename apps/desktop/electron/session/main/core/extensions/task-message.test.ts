import { expect, it, vi } from 'vitest';
import { callRefusal } from '@shared/extensions/bridge-protocol';
import { sessionWorkspace, workspaceSession } from '@shared/extensions/app-runtime-protocol';
import type { BridgeCaller } from './extension-bridge';
import { sendTaskMessage } from './task-message';

function caller(): BridgeCaller {
  return { kind: 'page', extensionId: 'task-app', pageId: 17, gesture: true,
    binding: { workspace: sessionWorkspace('bound-task'), extensionId: 'task-app', tabId: 'task-tab',
      operator: { kind: 'person' }, embedderId: 9 } } as unknown as BridgeCaller;
}

it('uses only the host-bound task and host-localized pause/continue messages', async () => {
  const source = caller(), deliver = vi.fn(async () => {});
  for (const [intent, locale, text] of [
    ['pause', 'zh-CN', '请暂停。'], ['continue', 'zh-TW', '请继续。'],
    ['pause', 'en-US', 'Please pause.'], ['continue', 'en-US', 'Please continue.'],
  ]) {
    await sendTaskMessage(source, { intent }, locale!, deliver);
    expect(deliver).toHaveBeenLastCalledWith(expect.objectContaining({ workspace: sessionWorkspace('bound-task') }), text);
  }
  expect(source.binding!.workspace).toBe(sessionWorkspace('bound-task'));
});

it('refuses self-reported targets, arbitrary text, gesture words and unknown intents without sending', async () => {
  const deliver = vi.fn(async () => {});
  for (const args of [
    { intent: 'pause', sessionId: 'other-task' }, { intent: 'continue', taskId: 'other-task' },
    { intent: 'pause', target: 'another-agent' }, { intent: 'pause', text: 'arbitrary instructions' },
    { intent: 'pause', gesture: true }, { intent: 'stop' }, {},
  ]) await expect(sendTaskMessage(caller(), args, 'zh-CN', deliver)).rejects.toMatchObject({ code: 'invalid' });
  expect(deliver).not.toHaveBeenCalled();
});

it('requires the host gesture and a person-operated task page, never an App program or agent check page', async () => {
  const from = caller(), deliver = vi.fn(async () => {});
  for (const wrong of [
    { ...from, gesture: false }, { ...from, gesture: undefined }, { ...from, kind: 'program' },
    { ...from, kind: 'background' }, { ...from, binding: null },
    { ...from, binding: { ...from.binding, workspace: null } },
    { ...from, binding: { ...from.binding, operator: { kind: 'agent', id: 'user:agent' } } },
  ]) await expect(sendTaskMessage(wrong as BridgeCaller, { intent: 'pause' }, 'zh-CN', deliver)).rejects.toMatchObject({ code: 'denied' });
  expect(deliver).not.toHaveBeenCalled();
});

it('needs only existing tools consent but cannot bypass it or forge its activation in arguments', () => {
  const from = { kind: 'page' as const, widget: false, gesture: true, has: (capability: string) => capability === 'agents:tools' };
  expect(callRefusal('taskMessage', { intent: 'pause' }, from)).toBeNull();
  expect(callRefusal('taskMessage', { intent: 'pause' }, { ...from, has: () => false })).toMatchObject({ code: 'denied' });
  expect(callRefusal('taskMessage', { intent: 'pause', gesture: true }, { ...from, gesture: false })).toMatchObject({ code: 'denied' });
  expect(callRefusal('taskMessage', { intent: 'pause' }, { kind: 'program', has: () => true })).not.toBeNull();
});

it('captures this click’s task before awaiting delivery and propagates an unknown result', async () => {
  const from = caller(), pending = Promise.withResolvers<void>();
  let reached: string | null = null;
  const work = sendTaskMessage(from, { intent: 'pause' }, 'zh-CN', async page => {
    await pending.promise; reached = workspaceSession(page);
  });
  from.binding!.workspace = sessionWorkspace('new-task'); pending.resolve(); await work;
  expect(reached).toBe('bound-task');
  await expect(sendTaskMessage(caller(), { intent: 'continue' }, 'en-US', async () => {
    throw new Error('delivery outcome unknown');
  })).rejects.toThrow('outcome unknown');
});
