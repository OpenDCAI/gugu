import { describe, expect, it, vi } from 'vitest';
import type { AcpAgentApi } from '@gugu/session-core/agents/plugins';
import { noopLogger } from '@gugu/session-shared/logger';
import { SessionCell } from './cell';
import { SessionMachine } from '../machine/machine';

async function fixture() {
  const nativeInputs: string[] = [];
  let sequence = 0;
  const prompt = vi.fn<AcpAgentApi['prompt']>(async (request, dispatch) => {
    const text = request.prompt.filter(block => block.type === 'text').map(block => block.text).join('\n');
    nativeInputs.push(text);
    const messageId = `native-${++sequence}`;
    cell.push({ kind: 'agent_state', source: 'agent', state: 'running' });
    cell.push({ kind: 'message', role: 'user', messageId, text, contentMode: 'replace' });
    return { status: 'accepted', requestId: dispatch!.requestId, messageId };
  });
  const steer = vi.fn<NonNullable<AcpAgentApi['steer']>>(async request => {
    const text = request.prompt.filter(block => block.type === 'text').map(block => block.text).join('\n');
    nativeInputs.push(text);
    return 'injected';
  });
  const cell: SessionCell = new SessionCell({ sessionId: 'fairness-probe', projectId: 'probe', providerId: 'codex', acpSessionId: 'native',
    supportsSteering: true, agent: { prompt, steer, cancel: vi.fn(async () => {}) } as unknown as AcpAgentApi,
    mergeEnvelopes: texts => texts.join('\n'), resolveAttachment: async () => ({ data: '', mimeType: 'image/png' }), logger: noopLogger });
  cell.applySessionReady();
  const first = cell.promptDetached({ text: 'owner-turn', origin: 'manual' });
  void first.completion.catch(() => {});
  expect(await first.admission).toMatchObject({ success: true, data: { queued: false } });
  const boundaries = async () => {
    for (let index = 0; index < 8; index++) {
      const tool = { toolCallId: `tool-${index}`, title: 'probe', toolKind: 'execute' as const, parentToolCallId: null, locations: [] };
      cell.push({ kind: 'tool_call', ...tool, status: 'in_progress' });
      cell.push({ kind: 'tool_update', ...tool, status: 'completed' });
      await new Promise<void>(resolve => setImmediate(resolve));
    }
  };
  return { cell, steer, prompt, nativeInputs, boundaries };
}

async function retainedCommunication(p: Awaited<ReturnType<typeof fixture>>, text: string, coalesceKey?: string) {
  await p.cell.queueBehindTurn({ text: 'temporary-manual-fence', origin: 'manual' });
  const fenceId = p.cell.sessionState.queuedPrompts[0].id;
  const older = p.cell.promptDetached({ text, origin: 'communication', coalesceKey }, { steerIfBusy: true });
  void older.completion.catch(() => {});
  expect(await older.admission).toMatchObject({ success: true, data: { queued: true } });
  expect(p.cell.removeQueuedPrompt(fenceId).success).toBe(true);
  return older;
}

describe('queued communication liveness', () => {
  it('control: manual and attachment entries stay single-turn fences while adjacent communication keeps FIFO batching', () => {
    const machine = new SessionMachine('fences');
    machine.apply({ type: 'SessionReady' }, { type: 'WorkStarted' });
    const entries = [
      { id: 'manual', origin: 'manual' as const, text: 'manual' },
      { id: 'image', origin: 'communication' as const, text: 'image', attachments: [{ type: 'attachment' as const, id: 'fixture-image', mimeType: 'image/png' as const }] },
      { id: 'first', origin: 'communication' as const, text: 'first' },
      { id: 'second', origin: 'communication' as const, text: 'second' },
    ];
    for (const entry of entries) machine.dispatch({ type: 'QueuePrompt', prompt: { ...entry, createdAt: 1, updatedAt: 1 } });
    const batches: string[][] = [];
    for (let round = 0; round < 3; round++) {
      const effects = machine.apply({ type: 'WorkEnded', outcome: { kind: 'stopped', stopReason: 'end_turn' } });
      batches.push(...effects.flatMap(effect => effect.type === 'sendPrompt' ? [effect.sources.map(one => one.id)] : []));
      machine.apply({ type: 'WorkStarted' });
    }
    expect(batches).toEqual([['manual'], ['image'], ['first', 'second']]);
  });

  it('control: an empty queue admits next-tool-call communication during the active turn', async () => {
    const p = await fixture();
    try {
      const next = p.cell.promptDetached({ text: 'inbox-new', origin: 'communication' }, { steerIfBusy: true });
      void next.completion.catch(() => {});
      expect(await next.admission).toMatchObject({ success: true, data: { queued: false } });
      await p.boundaries();
      expect(p.nativeInputs).toEqual(['owner-turn', 'inbox-new']);
      expect(p.cell.sessionState.lifecycle).toBe('working');
    } finally { p.cell.dispose(); }
  });

  it('an existing ordinary communication backlog reaches native input in FIFO order at tool boundaries', async () => {
    const p = await fixture();
    try {
      // Preserve actual next-tool-call intent while a temporary manual fence holds it.
      await p.cell.queueBehindTurn({ text: 'temporary-manual-fence', origin: 'manual' });
      const fenceId = p.cell.sessionState.queuedPrompts[0].id;
      const older = p.cell.promptDetached({ text: 'inbox-older', origin: 'communication' }, { steerIfBusy: true });
      void older.completion.catch(() => {});
      expect(await older.admission).toMatchObject({ success: true, data: { queued: true } });
      expect(p.cell.removeQueuedPrompt(fenceId).success).toBe(true);
      const next = p.cell.promptDetached({ text: 'inbox-new', origin: 'communication' }, { steerIfBusy: true });
      void next.completion.catch(() => {});
      await next.admission;
      await p.boundaries();
      // A queued admission is insufficient: inspect the provider's actual input boundary.
      expect(p.nativeInputs.slice(1).join('\n')).toContain('inbox-older');
      expect(p.nativeInputs.slice(1).join('\n')).toContain('inbox-new');
      expect(p.nativeInputs.slice(1).join('\n').indexOf('inbox-older')).toBeLessThan(p.nativeInputs.slice(1).join('\n').indexOf('inbox-new'));
      expect(p.cell.sessionState.lifecycle).toBe('working');
    } finally { p.cell.dispose(); }
  });

  it.each(['manual', 'explicit queue', 'attachment'] as const)('never jumps a %s head to deliver later ordinary communication', async fence => {
    const p = await fixture();
    try {
      p.cell.queuePrompt({ text: fence, origin: fence === 'manual' ? 'manual' : 'communication',
        ...(fence === 'attachment' ? { queueTiming: 'next-tool-call' as const,
          attachments: [{ type: 'attachment' as const, id: 'image', mimeType: 'image/png' as const }] } : {}) });
      const next = p.cell.promptDetached({ text: 'later ordinary', origin: 'communication' }, { steerIfBusy: true });
      void next.completion.catch(() => {});
      await next.admission;
      await p.boundaries();
      expect(p.nativeInputs).toEqual(['owner-turn']);
      expect(p.cell.sessionState.queuedPrompts.map(prompt => prompt.text)).toEqual([fence, 'later ordinary']);
    } finally { p.cell.dispose(); }
  });

  it('retains the in-flight head until its receipt and coalesces only later waiting entries', async () => {
    const p = await fixture();
    try {
      const receipt = Promise.withResolvers<'injected'>();
      p.steer.mockImplementationOnce(async () => {
        await receipt.promise;
        p.nativeInputs.push('older');
        return 'injected';
      });
      await retainedCommunication(p, 'older', 'same');
      await p.boundaries();
      const firstId = p.cell.sessionState.queuedPrompts[0].id;
      for (const text of ['obsolete', 'latest']) {
        const next = p.cell.promptDetached({ text, origin: 'communication', coalesceKey: 'same' }, { steerIfBusy: true });
        void next.completion.catch(() => {});
        await next.admission;
      }
      expect(p.cell.sessionState.queuedPrompts.map(prompt => prompt.text)).toEqual(['older', 'latest']);
      expect(p.cell.sessionState.queuedPrompts[1].id).not.toBe(firstId);
      expect(p.cell.removeQueuedPrompt(firstId).success).toBe(false);
      expect(p.cell.editQueuedPrompt(firstId, { text: 'rewrite', origin: 'communication' }).success).toBe(false);
      expect(p.steer).toHaveBeenCalledTimes(1);
      expect(p.nativeInputs).toEqual(['owner-turn']);
      receipt.resolve('injected');
      await p.boundaries();
      expect(p.nativeInputs).toEqual(['owner-turn', 'older', 'latest']);
      expect(p.cell.sessionState.queuedPrompts).toEqual([]);
    } finally { p.cell.dispose(); }
  });

  it('retains the queued input when cancellation races a native steering receipt', async () => {
    const p = await fixture();
    try {
      const receipt = Promise.withResolvers<'injected'>();
      p.steer.mockImplementationOnce(() => receipt.promise);
      await retainedCommunication(p, 'retain on cancel');
      await p.boundaries();
      await p.cell.cancel();
      receipt.resolve('injected');
      await p.boundaries();
      expect(p.cell.sessionState.lifecycle).toBe('cancelling');
      expect(p.cell.sessionState.queuedPrompts).toEqual([expect.objectContaining({ text: 'retain on cancel' })]);
      expect(p.cell.sessionState.queuedPrompts[0].queueDispatching).toBeUndefined();
      expect(p.steer).toHaveBeenCalledTimes(1);
    } finally { p.cell.dispose(); }
  });

  it('retains a refused input without repeated attempts on every following tool boundary', async () => {
    const p = await fixture();
    try {
      p.steer.mockRejectedValueOnce(new Error('fixture refusal'));
      await retainedCommunication(p, 'refused');
      await p.boundaries();
      await p.boundaries();
      expect(p.cell.sessionState.queuedPrompts).toEqual([expect.objectContaining({ text: 'refused' })]);
      expect(p.cell.sessionState.queuedPrompts[0].queueDispatching).toBeUndefined();
      expect(p.steer).toHaveBeenCalledTimes(1);
    } finally { p.cell.dispose(); }
  });

  it('close preserves both admitted and in-flight same-key inputs in their original order', async () => {
    const p = await fixture();
    try {
      const first = Promise.withResolvers<'injected'>();
      const second = Promise.withResolvers<'injected'>();
      p.steer.mockImplementationOnce(() => first.promise).mockImplementationOnce(() => second.promise);
      await retainedCommunication(p, 'older', 'same');
      await vi.waitFor(() => expect(p.steer).toHaveBeenCalledTimes(1));
      const next = p.cell.promptDetached({ text: 'newer', origin: 'communication', coalesceKey: 'same' }, { steerIfBusy: true });
      void next.completion.catch(() => {});
      await next.admission;
      first.resolve('injected');
      await vi.waitFor(() => expect(p.steer).toHaveBeenCalledTimes(2));
      await p.cell.closeSession();
      second.resolve('injected');
      await new Promise<void>(resolve => setImmediate(resolve));
      expect(p.cell.sessionState.queuedPrompts.map(prompt => prompt.text)).toEqual(['older', 'newer']);
      expect(p.cell.sessionState.queuedPrompts.every(prompt => !prompt.queueDispatching)).toBe(true);
    } finally { p.cell.dispose(); }
  });

  it('close retains every admitted same-key steer that has no consumption event', async () => {
    const p = await fixture();
    try {
      for (const text of ['older admitted', 'newer admitted']) {
        const next = p.cell.promptDetached({ text, origin: 'communication', coalesceKey: 'same' }, { steerIfBusy: true });
        void next.completion.catch(() => {});
        expect(await next.admission).toMatchObject({ success: true, data: { queued: false } });
      }
      // No tool/turn completion has proved consumption; close must preserve both replay copies.
      expect(p.nativeInputs).toEqual(['owner-turn', 'older admitted', 'newer admitted']);
      await p.cell.closeSession();
      expect(p.cell.sessionState.queuedPrompts.map(prompt => prompt.text)).toEqual(['older admitted', 'newer admitted']);
    } finally { p.cell.dispose(); }
  });

  it('a foreground end before the steering receipt never dispatches that retained input twice', async () => {
    const p = await fixture();
    try {
      const receipt = Promise.withResolvers<'injected'>();
      p.steer.mockImplementationOnce(() => receipt.promise);
      await retainedCommunication(p, 'one input');
      await p.boundaries();
      p.cell.push({ kind: 'agent_state', source: 'agent', state: 'idle', stopReason: 'end_turn' });
      expect(p.prompt).toHaveBeenCalledTimes(1);
      receipt.resolve('injected');
      await p.boundaries();
      expect(p.prompt).toHaveBeenCalledTimes(1);
      expect(p.steer).toHaveBeenCalledTimes(1);
      expect(p.cell.sessionState.queuedPrompts).toEqual([]);
    } finally { p.cell.dispose(); }
  });

  it('releases a stale reservation when restoring an in-memory queue into a new cell', async () => {
    const p = await fixture();
    try {
      const stale = { text: 'restored', origin: 'communication' as const,
        queueTiming: 'next-tool-call' as const, queueDispatching: true as const };
      p.cell.queuePrompt(stale);
      await p.boundaries();
      expect(p.nativeInputs).toEqual(['owner-turn', 'restored']);
      expect(p.cell.sessionState.queuedPrompts).toEqual([]);
    } finally { p.cell.dispose(); }
  });

  it('control: manual and explicit queued delivery remain deferred; same-key replacement retains its FIFO position', async () => {
    const p = await fixture();
    try {
      expect(await p.cell.queueBehindTurn({ text: 'manual-next', origin: 'manual' })).toMatchObject({ success: true, data: { queued: true } });
      for (const [text, coalesceKey] of [['queue-old', 'same'], ['queue-second', 'second'], ['queue-updated', 'same']]) {
        const next = p.cell.promptDetached({ text, origin: 'communication', coalesceKey });
        void next.completion.catch(() => {});
        expect(await next.admission).toMatchObject({ success: true, data: { queued: true } });
      }
      await p.boundaries();
      expect(p.nativeInputs).toEqual(['owner-turn']);
      expect(p.cell.sessionState.queuedPrompts.map(item => item.text)).toEqual(['manual-next', 'queue-updated', 'queue-second']);
    } finally { p.cell.dispose(); }
  });

  it('control: next-tool-call admission waits for the real steering receipt', async () => {
    const p = await fixture();
    try {
      const receipt = Promise.withResolvers<'injected'>();
      p.steer.mockImplementationOnce(() => receipt.promise);
      const next = p.cell.promptDetached({ text: 'inbox-pending', origin: 'communication' }, { steerIfBusy: true });
      void next.completion.catch(() => {});
      let admitted = false;
      void next.admission.then(() => { admitted = true; });
      await p.boundaries();
      expect(p.steer).toHaveBeenCalledTimes(1);
      expect(admitted).toBe(false);
      expect(p.nativeInputs).toEqual(['owner-turn']);
      receipt.resolve('injected');
      expect(await next.admission).toMatchObject({ success: true, data: { queued: false } });
    } finally { p.cell.dispose(); }
  });
});
