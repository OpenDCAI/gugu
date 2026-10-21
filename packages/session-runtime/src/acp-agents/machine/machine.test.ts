import type { QueuedPrompt } from '@gugu/session-core/acp';
import { describe, expect, it } from 'vitest';
import { SessionMachine, type Effect } from './machine';

/**
 * #6448 park 照收投递(owner 定):只剩后台子代理在跑、agent 没在干活 —— 新来的一句就直接发,
 * agent 停下时照常抽干队列;agent 在干活时,steer / 排队 / 拒收照旧。
 * 「在干活」只是状态(WorkStarted / WorkEnded),谁开的工都一样(#7087)。
 */
function prompt(id: string, origin: QueuedPrompt['origin'] = 'typed'): QueuedPrompt {
  return { id, origin, text: id, createdAt: 1, updatedAt: 1 };
}

function readyMachine(): SessionMachine {
  const machine = new SessionMachine('conv-1');
  machine.apply({ type: 'SessionReady' });
  return machine;
}

/** 只剩后台子代理:agent 停下了(end_turn),一个后台子代理还在跑。 */
function parkedMachine(): SessionMachine {
  const machine = readyMachine();
  machine.apply({ type: 'WorkStarted' });
  machine.apply({ type: 'AgentsChanged', runningCount: 1 });
  machine.apply({ type: 'WorkEnded', outcome: { kind: 'stopped', stopReason: 'end_turn' } });
  return machine;
}

const sent = (effects: readonly Effect[]): string[][] =>
  effects.flatMap((effect) => (effect.type === 'sendPrompt' ? [effect.sources.map((p) => p.id)] : []));

describe('SessionMachine park accepts deliveries (#6448)', () => {
  it('sends a prompt that arrives while only background agents run', () => {
    const machine = parkedMachine();
    expect(machine.phase.kind).toBe('ready');
    expect(machine.backgroundAgentCount).toBe(1);

    const result = machine.dispatch({ type: 'Prompt', prompt: prompt('while-parked') });

    expect(result.success && result.data.map((effect) => effect.type)).toEqual(['promptStarted']);
    expect(machine.queuedPrompts).toEqual([]);
    expect(machine.backgroundAgentCount, 'the background agent keeps running').toBe(1);
  });

  it('sends (does not steer) a next-tool-call delivery while parked: the agent is not working', () => {
    const machine = parkedMachine();
    const result = machine.dispatch({ type: 'Prompt', prompt: prompt('steer-me'), steerIfBusy: true });

    expect(result.success && result.data.map((effect) => effect.type)).toEqual(['promptStarted']);
  });

  it('steers and queues while the agent works (with background agents too)', () => {
    const steering = readyMachine();
    steering.apply({ type: 'WorkStarted' });
    steering.apply({ type: 'AgentsChanged', runningCount: 1 });
    const steered = steering.dispatch({ type: 'Prompt', prompt: prompt('mid-work'), steerIfBusy: true });
    expect(steered.success && steered.data.map((effect) => effect.type)).toEqual(['promptSteered']);

    const queued = steering.dispatch({ type: 'Prompt', prompt: prompt('queued') });
    expect(queued.success).toBe(true);
    expect(steering.queuedPrompts.map((p) => p.id)).toEqual(['queued']);
  });

  it('is busy the same way whoever started the work: no prompt, the agent reported running (#7087)', () => {
    const machine = readyMachine();
    expect(machine.apply({ type: 'WorkStarted' }).map((effect) => effect.type)).toEqual(['state', 'agentEvent']);

    const steered = machine.dispatch({ type: 'Prompt', prompt: prompt('send-now'), steerIfBusy: true });
    expect(steered.success && steered.data.map((effect) => effect.type)).toEqual(['promptSteered']);
    machine.dispatch({ type: 'Prompt', prompt: prompt('typed-meanwhile') });
    expect(machine.queuedPrompts.map((p) => p.id)).toEqual(['typed-meanwhile']);
  });

  it('a prompt sent to an idle agent does not make it busy by itself; the agent says when it works', () => {
    const machine = readyMachine();
    machine.dispatch({ type: 'Prompt', prompt: prompt('local-command') });

    expect(machine.phase.kind).toBe('ready');
    expect(machine.isWorking).toBe(false);
  });

  it('drains the queue when the agent stops, even while background agents still run', () => {
    const machine = readyMachine();
    machine.apply({ type: 'WorkStarted' });
    machine.apply({ type: 'AgentsChanged', runningCount: 1 });
    machine.dispatch({ type: 'Prompt', prompt: prompt('next') });
    expect(machine.queuedPrompts.map((p) => p.id)).toEqual(['next']);

    const effects = machine.apply({ type: 'WorkEnded', outcome: { kind: 'stopped', stopReason: 'end_turn' } });

    expect(sent(effects)).toEqual([['next']]);
    expect(machine.queuedPrompts).toEqual([]);
    expect(machine.phase.kind).toBe('ready');
  });

  it('a repeated WorkStarted is not another start edge', () => {
    const machine = readyMachine();
    machine.apply({ type: 'WorkStarted' });
    expect(machine.apply({ type: 'WorkStarted' })).toEqual([]);
  });
});

/**
 * #6762 会话还不能收话时到的那一句先扣进队列,由就绪边界抽干:启动中对谁都如此;`session/load` 重放中
 * 只对产品的排队入口如此(它从前原样入队就是这样)—— 普通发送与投递在重放中照旧拒收。
 */
describe('SessionMachine holds a prompt until the session can take it (#6762)', () => {
  it('queues a prompt that arrives while starting and SessionReady drains it', () => {
    const machine = new SessionMachine('conv-1');
    expect(machine.dispatch({ type: 'Prompt', prompt: prompt('while-starting') }).success).toBe(true);
    expect(machine.queuedPrompts.map((p) => p.id)).toEqual(['while-starting']);

    expect(sent(machine.apply({ type: 'SessionReady' }))).toEqual([['while-starting']]);
  });

  it('queues the product queue entry during session/load replay and ReplayEnded drains it', () => {
    const machine = new SessionMachine('conv-1');
    machine.apply({ type: 'ReplayStarted' });
    expect(machine.phase.kind).toBe('replaying');

    // The product queue entry (SessionCell.queueBehindTurn) sees the replay and queues plainly.
    const result = machine.dispatch({ type: 'QueuePrompt', prompt: prompt('during-replay') });

    expect(result.success, 'replay is not a reason to reject the prompt').toBe(true);
    expect(machine.phase.kind).toBe('replaying');
    expect(machine.queuedPrompts.map((p) => p.id)).toEqual(['during-replay']);
    expect(sent(machine.apply({ type: 'ReplayEnded', status: 'complete' }))).toEqual([['during-replay']]);
    expect(machine.queuedPrompts).toEqual([]);
  });

  it('still refuses a plain send or delivery during replay (only the queue entry is held)', () => {
    const machine = new SessionMachine('conv-1');
    machine.apply({ type: 'ReplayStarted' });

    const result = machine.dispatch({ type: 'Prompt', prompt: prompt('plain-send') });

    expect(result.success).toBe(false);
    expect(!result.success && result.error.type).toBe('invalid_state');
    expect(machine.queuedPrompts).toEqual([]);
  });
});

describe('SessionMachine records how the agent stopped (#6448)', () => {
  it('writes stopped + cancelled when the user cancels work the agent started itself', () => {
    const machine = readyMachine();
    machine.apply({ type: 'WorkStarted' });
    machine.apply({ type: 'WorkEnded', outcome: { kind: 'errored' } });
    machine.apply({ type: 'WorkStarted' });
    expect(machine.sessionState(null).lastTurnOutcome).toBe('none');

    machine.dispatch({ type: 'Cancel' });
    expect(machine.phase.kind).toBe('cancelling');
    machine.apply({ type: 'WorkEnded', outcome: { kind: 'stopped', stopReason: 'cancelled' } });

    const state = machine.sessionState(null);
    expect(state.lifecycle).toBe('ready');
    expect(state.lastTurnOutcome).toBe('stopped');
    expect(state.lastStopReason).toBe('cancelled');
  });

  it('does not record an outcome when only background agents are cancelled', () => {
    const machine = parkedMachine();
    machine.dispatch({ type: 'Cancel' });

    const state = machine.sessionState(null);
    expect(state.lastTurnOutcome).toBe('stopped');
    expect(state.lastStopReason, 'the agent stopped normally; the cancel stopped leftover work').toBe('end_turn');
  });
});


describe('main-composer queue edit reservation (#7324)', () => {
  it('does not drain an edited head when the active turn completes', () => {
    const machine = readyMachine(); machine.apply({ type: 'WorkStarted' });
    machine.dispatch({ type: 'QueuePrompt', prompt: prompt('a', 'typed') });
    machine.dispatch({ type: 'QueuePrompt', prompt: prompt('b', 'typed') });
    machine.dispatch({ type: 'EditQueuedPrompt', id: 'a', input: { text: 'a' }, updatedAt: 2,
      queueEdit: { draftText: 'unfinished', originalDraftText: 'my draft' } });
    expect(sent(machine.apply({ type: 'WorkEnded', outcome: { kind: 'stopped', stopReason: 'end_turn' } }))).toEqual([]);
    expect(machine.queuedPrompts.map((p) => p.id)).toEqual(['a', 'b']);
    machine.dispatch({ type: 'EditQueuedPrompt', id: 'a', input: { text: 'edited' }, updatedAt: 3, queueEdit: null });
    expect(sent(machine.apply({ type: 'SettingsReady' }))).toEqual([['a', 'b']]);
  });

  it('stops a merged batch before the edited item and keeps its identity and committed text', () => {
    const machine = readyMachine(); machine.apply({ type: 'WorkStarted' });
    for (const id of ['a', 'b', 'c']) machine.dispatch({ type: 'QueuePrompt', prompt: prompt(id, 'typed') });
    machine.dispatch({ type: 'EditQueuedPrompt', id: 'b', input: { text: 'b' }, updatedAt: 2,
      queueEdit: { draftText: 'not committed', originalDraftText: '' } });
    expect(sent(machine.apply({ type: 'WorkEnded', outcome: { kind: 'stopped', stopReason: 'end_turn' } }))).toEqual([['a']]);
    expect(machine.queuedPrompts[0]).toMatchObject({ id: 'b', text: 'b', createdAt: 1 });
    expect(sent(machine.apply({ type: 'SettingsReady' }))).toEqual([]);
    machine.dispatch({ type: 'EditQueuedPrompt', id: 'b', input: { text: 'b' }, updatedAt: 3, queueEdit: null });
    expect(machine.queuedPrompts[0].queueEdit).toBeUndefined();
    expect(sent(machine.apply({ type: 'SettingsReady' }))).toEqual([['b', 'c']]);
  });

  it('reserves the current server text rather than overwriting it with a stale preview', () => {
    const machine = readyMachine();
    machine.dispatch({ type: 'QueuePrompt', prompt: { ...prompt('q'), text: 'latest committed', coalesceKey: 'key' } });
    machine.dispatch({ type: 'EditQueuedPrompt', id: 'q', input: { text: 'stale' }, updatedAt: 2,
      queueEdit: { draftText: 'stale', originalDraftText: 'draft' } });
    expect(machine.queuedPrompts[0]).toMatchObject({ text: 'latest committed', queueEdit: { draftText: 'latest committed' } });
    machine.dispatch({ type: 'QueuePrompt', prompt: { ...prompt('new'), text: 'newer coalesced', coalesceKey: 'key' } });
    expect(machine.queuedPrompts.map((p) => p.id)).toEqual(['q', 'new']);
    expect(machine.dispatch({ type: 'EditQueuedPrompt', id: 'new', input: { text: 'newer' }, updatedAt: 3,
      queueEdit: { draftText: 'newer', originalDraftText: '' } }).success).toBe(false);
  });

  it('rejects a reservation when the original message already left the queue', () => {
    const machine = readyMachine();
    expect(machine.dispatch({ type: 'EditQueuedPrompt', id: 'gone', input: { text: 'stale' }, updatedAt: 2,
      queueEdit: { draftText: 'stale', originalDraftText: 'my draft' } }).success).toBe(false);
    expect(machine.queuedPrompts).toEqual([]);
  });
});
