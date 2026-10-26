import { createRequestActivity, transcriptTurnSchema } from '@gugu/session-core/acp';
import type { AcpAgentApi } from '@gugu/session-core/agents/plugins';
import { noopLogger } from '@gugu/session-shared/logger';
import { createLiveModelHost, createLiveModelReplica, defineContract, liveModel, liveState } from '@gugu/session-wire';
import { createTestWire } from '@gugu/session-wire/testing';
import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { publishLiveModelState } from '../state/live-models';
import { SessionCell } from './cell';

const contract = defineContract({ transcript: liveModel({ key: z.undefined(), states: {
  active: liveState({ data: transcriptTurnSchema.nullable() }),
} }) });

describe('steering admission records the submitted message', () => {
  it.each(['native', 'request-activity'] as const)('records one message through the common path for %s', async transport => {
    const admission = Promise.withResolvers<'injected'>();
    const finished = Promise.withResolvers<{ stopReason: 'end_turn' }>();
    const host = createLiveModelHost(contract.transcript);
    const state = host.create(undefined, { active: null });
    const wire = createTestWire(contract, { transcript: host }, { validate: 'full' });
    const replica = createLiveModelReplica(contract.transcript, wire.client.transcript);
    const lease = replica.acquire(undefined);
    const view = await lease.ready();
    const changed = vi.fn(() => publishLiveModelState(state.states.active, cell.history().active, undefined));
    const cancel = vi.fn(async () => {});
    // The real steering extension returns only an outcome; it need not emit a native user echo.
    const agent = {
      cancel,
      steer: vi.fn(() => admission.promise),
      extMethod: vi.fn(async () => ({ outcome: await admission.promise })),
      prompt: vi.fn(async () => {
        if (transport === 'request-activity') return finished.promise;
        cell.push({ kind: 'agent_state', source: 'agent', state: 'running' });
        cell.push({ kind: 'message', role: 'user', messageId: 'native-first', text: 'first' });
        return { status: 'accepted', requestId: 'first-request', messageId: 'native-first' };
      }),
    };
    const api = transport === 'native' ? agent as unknown as AcpAgentApi
      : createRequestActivity(agent as never, ({ event }) => cell.push(event)).agent;
    const cell: SessionCell = new SessionCell({ sessionId: 'conversation', projectId: 'project', providerId: 'fixture', acpSessionId: 'native',
      agent: api, supportsSteering: true, logger: noopLogger,
      resolveAttachment: async () => ({ data: '', mimeType: 'text/plain' }), callbacks: { onTranscriptChanged: changed } });
    cell.applySessionReady();
    const first = cell.promptDetached({ text: 'first' });
    await first.admission;
    await new Promise<void>(resolve => setImmediate(resolve));
    const userTexts = () => cell.history().active?.items.flatMap(item => item.kind === 'message' && item.role === 'user' ? [item.text] : []);
    try {
      expect(userTexts()).toEqual(['first']);
      cell.queuePrompt({ text: 'also print pwd', origin: 'manual' });
      const queued = cell.sessionState.queuedPrompts[0]!;
      const inserted = cell.steerQueuedPrompt(queued.id);
      await new Promise<void>(resolve => setImmediate(resolve));
      expect(userTexts()).toEqual(['first']);
      changed.mockClear();
      admission.resolve('injected');
      expect(await inserted).toEqual({ success: true, data: undefined });
      expect(userTexts()).toEqual(['first', 'also print pwd']);
      expect(changed).toHaveBeenCalledTimes(1);
      await view.states.active.waitForCursor(state.states.active.cursor);
      expect(view.states.active.current()).toEqual(cell.history().active);
      expect(view.states.active.current()?.items.filter(item => item.kind === 'message' && item.role === 'user'))
        .toEqual([expect.objectContaining({ text: 'first' }), expect.objectContaining({ text: 'also print pwd', id: expect.stringContaining(queued.id) })]);
      expect(cell.sessionState.queuedPrompts).toEqual([]);
      expect(cancel).not.toHaveBeenCalled();
    } finally {
      if (transport === 'native') cell.push({ kind: 'agent_state', source: 'agent', state: 'idle', stopReason: 'end_turn' });
      else finished.resolve({ stopReason: 'end_turn' });
      await first.completion;
      cell.dispose();
      await lease.release();
      await replica.dispose();
    }
  });
});
