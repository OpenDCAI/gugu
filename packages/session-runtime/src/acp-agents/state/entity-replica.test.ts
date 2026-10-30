import { AcpTranscriptParser, acpPermissionRequestSchema, decodeSessionUpdate, sessionPlansSchema, transcriptTurnSchema } from '@gugu/session-core/acp';
import { ReplicaState, type LiveUpdate, createLiveModelHost, createLiveModelReplica, defineContract, liveModel, liveState } from '@gugu/session-wire';
import { createTestWire } from '@gugu/session-wire/testing';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { publishLiveModelState } from './live-models';

const contract = defineContract({
  entities: liveModel({ key: z.undefined(), states: {
    activeTurn: liveState({ data: transcriptTurnSchema.nullable() }),
    plan: liveState({ data: sessionPlansSchema.nullable() }),
    permissions: liveState({ data: acpPermissionRequestSchema.array() }),
  } }),
});

// The actual session schemas and publisher cross two wire hops, as desktop/server replicas do.
describe('session entity replication', () => {
  it('retains a complete command permission subject through schema validation and replication', async () => {
    const request = { requestId: 'permission', title: 'Approval title', description: 'Approval details',
      subject: { type: 'command', command: 'ls', cwd: '/work', toolCallId: 't', terminalId: 'terminal', _meta: { nested: { retained: true } } },
      options: [{ optionId: 'allow', name: 'Allow', kind: 'allow_once' }], _meta: { requestContext: 1 } };
    const host = createLiveModelHost(contract.entities);
    host.create(undefined, { activeTurn: null, plan: null, permissions: [request] });
    const wire = createTestWire(contract, { entities: host }, { validate: 'full' });
    const replica = createLiveModelReplica(contract.entities, wire.client.entities);
    const lease = replica.acquire(undefined);
    try {
      const view = await lease.ready();
      expect(view.states.permissions.current()).toEqual([request]);
      expect(view.states.permissions.current()[0]).not.toHaveProperty('toolCall');
    } finally {
      await lease.release();
      await replica.dispose();
    }
  });

  it('resynchronizes out-of-order replacement frames without resurrecting stale text', async () => {
    const parser = new AcpTranscriptParser({ sessionId: 'reordered' });
    const host = createLiveModelHost(contract.entities);
    const state = host.create(undefined, { activeTurn: null, plan: null, permissions: [] });
    const wire = createTestWire(contract, { entities: host }, { validate: 'full' });
    const frames: LiveUpdate[] = [];
    const unsubscribe = state.states.activeTurn.subscribe(frame => frames.push(frame));
    const handle = wire.client.entities.state(undefined, 'activeTurn');
    const replica = new ReplicaState({ ...handle, attach: async () => () => {} }, { schema: transcriptTurnSchema.nullable() });
    await replica.ready;
    try {
      for (const [index, text] of ['Original long answer', 'Short replacement', ''].entries()) {
        parser.pushEvent(decodeSessionUpdate({ sessionUpdate: 'agent_message', messageId: 'm', content: [{ type: 'text', text }] } as never), index);
        publishLiveModelState(state.states.activeTurn, parser.activeTurn, undefined);
      }
      expect(frames).toHaveLength(3);
      // Deliver newest first. Its gap must fetch the authoritative, already-cleared snapshot.
      replica.applyUpdate(frames[2]);
      await replica.waitForCursor(state.states.activeTurn.cursor);
      expect(replica.current()).toEqual(parser.activeTurn);
      replica.applyUpdate(frames[0]);
      replica.applyUpdate(frames[1]);
      await replica.refresh();
      expect(replica.current()?.items).toMatchObject([{ text: '' }]);
      expect(replica.current()).toEqual(parser.activeTurn);
    } finally {
      unsubscribe();
      await replica.dispose();
    }
  });

  it('replaces shorter messages, clears tool fields and removes individual plans across replicas', async () => {
    const parser = new AcpTranscriptParser({ sessionId: 'replica' });
    const host = createLiveModelHost(contract.entities);
    const state = host.create(undefined, { activeTurn: null, plan: null, permissions: [] });
    const upstream = createTestWire(contract, { entities: host }, { validate: 'full' });
    const relay = createLiveModelReplica(contract.entities, upstream.client.entities);
    const downstream = createTestWire(contract, { entities: relay }, { validate: 'full' });
    const replica = createLiveModelReplica(contract.entities, downstream.client.entities);
    const lease = replica.acquire(undefined);
    const view = await lease.ready();
    let at = 100;
    const send = async (update: Record<string, unknown>) => {
      parser.pushEvent(decodeSessionUpdate(update as never), at++);
      publishLiveModelState(state.states.activeTurn, parser.activeTurn, undefined);
      publishLiveModelState(state.states.plan, parser.plan, undefined);
      // Cursor barriers prove application, rather than a guessed timer or a text-only assertion.
      const middle = relay.peek(undefined)!;
      await middle.states.activeTurn.waitForCursor(state.states.activeTurn.cursor);
      await middle.states.plan.waitForCursor(state.states.plan.cursor);
      await view.states.activeTurn.waitForCursor(await middle.states.activeTurn.snapshot());
      await view.states.plan.waitForCursor(await middle.states.plan.snapshot());
      expect(view.states.activeTurn.current()).toEqual(parser.activeTurn);
      expect(view.states.plan.current()).toEqual(parser.plan);
    };
    try {
      await send({ sessionUpdate: 'agent_message', messageId: 'm', content: [{ type: 'text', text: 'long original' }] });
      await send({ sessionUpdate: 'tool_call_update', toolCallId: 't', name: 'Bash', content: [{ type: 'content', content: { type: 'text', text: 'old output' } }] });
      await send({ sessionUpdate: 'plan_update', plan: { type: 'items', planId: 'a', entries: [] } });
      await send({ sessionUpdate: 'plan_update', plan: { type: 'markdown', planId: 'b', content: '# Proposal' } });
      await send({ sessionUpdate: 'agent_message', messageId: 'm', content: [{ type: 'text', text: 'x' }] });
      await send({ sessionUpdate: 'tool_call_update', toolCallId: 't', name: null, content: null });
      await send({ sessionUpdate: 'plan_removed', planId: 'a' });
      expect(Object.keys(view.states.plan.current() ?? {})).toEqual(['b']);
      expect(view.states.activeTurn.current()?.items).toMatchObject([{ text: 'x' }, { contentBlocks: [] }, { planId: 'b' }]);
      await send({ sessionUpdate: 'agent_message', messageId: 'm', content: [] });
      await send({ sessionUpdate: 'plan_removed', planId: 'b' });
      expect(view.states.activeTurn.current()?.items).toHaveLength(2);
      expect(view.states.activeTurn.current()?.items[1]).not.toHaveProperty('toolName');
      expect(view.states.activeTurn.current()?.items[1]).not.toHaveProperty('outputText');
    } finally {
      await lease.release();
      await replica.dispose();
      await relay.dispose();
    }
  });
});
