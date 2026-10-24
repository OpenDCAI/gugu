import { decodeSessionUpdate } from '@gugu/session-core/acp';

import type { TranscriptTurn } from '@gugu/session-core/acp';
import { expect, it, vi } from 'vitest';
import { makeAcpHarness, makeStartInput } from '../acp-test-support';
import { AcpRuntime } from './runtime';

it('stores complete replayed child history after later user messages, without freezing an intermediate running child', async () => {
  const committed: Array<{ source: string; turn: TranscriptTurn }> = [];
  const h = makeAcpHarness({
    onTurnCommitted: ({ source, turn }) => committed.push({ source, turn }),
  });
  const rt = new AcpRuntime(h.deps);
  const loaded = Promise.withResolvers<Record<string, never>>();
  h.agent.loadSession = vi.fn(() => loaded.promise);
  const resuming = rt.resumeSession({
    ...makeStartInput({ sessionId: 'replayed-child-history' }),
    providerSessionId: 'native-parent',
  });
  await h.agent.called('loadSession');
  const client = h.client();
  const user = (messageId: string, text: string) => client.sessionEvent({
    sessionId: 'native-parent',
    event: decodeSessionUpdate({ sessionUpdate: 'user_message_chunk', messageId, content: { type: 'text', text } }),
  });

  try {
    await user('first', 'Delegate the audit');
    await client.sessionEvent({
      sessionId: 'native-parent',
      event: decodeSessionUpdate({ sessionUpdate: 'subagent_spawned',
        subagentSessionId: 'native-child', name: 'Audit', background: true }),
    });
    await user('second', 'The next historical input');
    await client.sessionEvent({
      sessionId: 'native-parent',
      event: decodeSessionUpdate({ sessionUpdate: 'subagent_stream', subagentSessionId: 'native-child',
        update: { sessionUpdate: 'agent_message_chunk', messageId: 'child-answer',
          content: { type: 'text', text: 'CHILD_ALREADY_COMPLETED' } } }),
    });
    await client.sessionEvent({
      sessionId: 'native-parent',
      event: decodeSessionUpdate({ sessionUpdate: 'subagent_state_update',
        subagentSessionId: 'native-child', state: 'completed' }),
    });
    // A provider can replay child records only after it has sent all parent turns.
    // The durable writer must receive that complete projection, not an early launch.
    expect(committed).toEqual([]);
  } finally {
    loaded.resolve({});
  }

  expect(await resuming).toMatchObject({ success: true });
  expect(committed).toHaveLength(2);
  expect(committed.map(({ source }) => source)).toEqual(['replay', 'replay']);
  const launch = committed[0].turn.items.find(item => item.kind === 'spawn-subagent-tool-call');
  expect(launch).toMatchObject({ agentStatus: 'completed', outputText: 'CHILD_ALREADY_COMPLETED', canCancel: false });
  expect(committed[1].turn.items.filter(item => item.kind === 'message'))
    .toEqual([expect.objectContaining({ role: 'user', text: 'The next historical input' })]);
  expect(h.agent.prompt).not.toHaveBeenCalled();
});
