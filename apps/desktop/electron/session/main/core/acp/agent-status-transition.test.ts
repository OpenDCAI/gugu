import type { SessionSummary } from '@gugu/session-core/acp';
import { describe, expect, it } from 'vitest';
import {
  emptyStatusLogState,
  readStatusLog,
  stepStatusLog,
  type AgentStatusEvent,
} from '../agent-status/status-event-log';
import type { AgentStatusReading } from '@gugu/core/shared/agentStatus';
import { translateAgentEvent } from '../agent-status/status-event-translator';
import { deriveAcpAgentStatusActions } from './agent-status-transition';

/**
 * spec status-event-log(#6448)—— ACP 腿:SessionSummary 的一串变化 → 投影出的动作 → 翻译 → 日志 reduce,
 * 与状态写入者同一条路(打断 = `Interrupted`,翻译上下文取自日志)。断言的是**产品读得到的**:
 * 基础态、附属态、功能布尔、以及「做完」那条边响了几次。
 */
function summary(overrides: Partial<SessionSummary> = {}): SessionSummary {
  return {
    sessionId: 'c1',
    projectId: 'p1',
    providerId: 'claude',
    lifecycle: 'ready',
    isGenerating: false,
    lastStopReason: null,
    lastTurnOutcome: 'none',
    pendingPermissionCount: 0,
    pendingPermissionWaits: [],
    backgroundAgentCount: 0,
    backgroundCommandCount: 0,
    queuedPromptCount: 0,
    title: null,
    updatedAt: 0,
    ...overrides,
  };
}

const working = (overrides: Partial<SessionSummary> = {}) =>
  summary({ lifecycle: 'working', isGenerating: true, ...overrides });

const waits = (...entries: Array<[string, 'approval' | 'question' | 'plan']>): Partial<SessionSummary> => ({
  pendingPermissionCount: entries.length,
  pendingPermissionWaits: entries.map(([requestId, waitKind]) => ({ requestId, waitKind })),
});

type Reading = AgentStatusReading;

function replay(steps: readonly SessionSummary[]): { readings: Reading[]; doneEdges: number; anomalies: string[] } {
  const state = emptyStatusLogState();
  const anomalies: string[] = [];
  let doneEdges = 0;
  let previous: SessionSummary | undefined;
  const readings: Reading[] = [];
  for (const next of steps) {
    for (const action of deriveAcpAgentStatusActions(previous, next)) {
      const events: AgentStatusEvent[] = action.kind === 'reset'
        ? [{ kind: 'Interrupted', sessionId: action.sessionId }]
        : translateAgentEvent(action.event, {
            running: state.running,
            waiting: state.waits.size > 0,
            failed: state.error !== null,
            autoApproved: false,
          });
      for (const event of events) stepStatusLog(state, event, (what) => anomalies.push(what));
      if (events.length > 0 && readStatusLog(state).finished) doneEdges += 1;
    }
    previous = next;
    const { finished: _turnEnded, ...reading } = readStatusLog(state);
    readings.push(reading);
  }
  return { readings, doneEdges, anomalies };
}

describe('ACP status projection: park (#6448)', () => {
  it('a turn that ends while background agents still run is parked, not done', () => {
    const { readings, doneEdges, anomalies } = replay([
      working(),
      working({ backgroundAgentCount: 1 }),
      summary({ isGenerating: true, backgroundAgentCount: 1, lastTurnOutcome: 'stopped', lastStopReason: 'end_turn' }),
    ]);
    expect(readings.at(-1)).toEqual({ status: 'working', detail: 'parked', running: false, background: 'running' });
    expect(doneEdges, 'park is not a finished turn').toBe(0);
    expect(anomalies).toEqual([]);
  });

  it('leaves park when the background agents finish', () => {
    const { readings, doneEdges } = replay([
      working(),
      summary({ isGenerating: true, backgroundAgentCount: 2, lastTurnOutcome: 'stopped', lastStopReason: 'end_turn' }),
      summary({ isGenerating: true, backgroundAgentCount: 1, lastTurnOutcome: 'stopped', lastStopReason: 'end_turn' }),
      summary({ backgroundAgentCount: 0, lastTurnOutcome: 'stopped', lastStopReason: 'end_turn' }),
    ]);
    expect(readings[2]).toMatchObject({ status: 'working', detail: 'parked' });
    expect(readings.at(-1)).toMatchObject({ status: 'idle', running: false, background: null });
    expect(doneEdges).toBe(0);
  });

  it('a prompt accepted while parked opens a running turn', () => {
    const parked = summary({ isGenerating: true, backgroundAgentCount: 1, lastTurnOutcome: 'stopped', lastStopReason: 'end_turn' });
    const { readings, doneEdges } = replay([
      working(),
      parked,
      working({ backgroundAgentCount: 1 }),
      summary({ isGenerating: true, backgroundAgentCount: 1, lastTurnOutcome: 'stopped', lastStopReason: 'end_turn' }),
    ]);
    expect(readings[2]).toEqual({ status: 'working', detail: 'running', running: true, background: 'running' });
    expect(readings[3]).toMatchObject({ status: 'working', detail: 'parked', running: false });
    expect(doneEdges).toBe(0);
  });

  it('background agents that appear outside any turn park an idle session', () => {
    const { readings } = replay([summary(), summary({ isGenerating: true, backgroundAgentCount: 1 })]);
    expect(readings.at(-1)).toEqual({ status: 'working', detail: 'parked', running: false, background: 'running' });
  });

  // Claude 的 `run_in_background` Bash 不挂住回合:轮当场收口,命令还在跑(mac1 B 臂 S2 实测:这时库里是 idle/done)。
  it('a turn that ends while a background command still runs is parked, not done', () => {
    const { readings, doneEdges, anomalies } = replay([
      working(),
      working({ backgroundCommandCount: 1 }),
      summary({ backgroundCommandCount: 1, lastTurnOutcome: 'stopped', lastStopReason: 'end_turn' }),
    ]);
    expect(readings.at(-1)).toEqual({ status: 'working', detail: 'parked', running: false, background: 'running' });
    expect(doneEdges, 'park is not a finished turn').toBe(0);
    expect(anomalies).toEqual([]);
  });

  it('leaves park when the command finishes, and the harness wake-up cycle is the done edge', () => {
    const drained = [
      working(),
      summary({ backgroundCommandCount: 1, lastTurnOutcome: 'stopped', lastStopReason: 'end_turn' }),
      summary({ lastTurnOutcome: 'stopped', lastStopReason: 'end_turn' }),
    ];
    const untilDrained = replay(drained);
    expect(untilDrained.readings[1]).toMatchObject({ status: 'working', detail: 'parked' });
    // 基础态回 idle;附属态仍说「上一轮是正常做完的」—— 但这不是做完的那条边(不写未读、不响)。
    expect(untilDrained.readings[2]).toMatchObject({ status: 'idle', detail: 'done', background: null });
    expect(untilDrained.doneEdges, 'the command ending is not a finished turn').toBe(0);

    const { readings, doneEdges } = replay([
      ...drained,
      // Claude 自己开工(后台任务完成的通知):与 prompt 的活同一个状态,停下时照样写结局。
      working({ lastTurnOutcome: 'none' }),
      summary({ lastTurnOutcome: 'stopped', lastStopReason: 'end_turn' }),
    ]);
    expect(readings[3]).toMatchObject({ status: 'working', detail: 'running' });
    expect(readings[4]).toMatchObject({ status: 'idle', detail: 'done' });
    expect(doneEdges, 'the wake-up cycle Claude injects is the one done edge').toBe(1);
  });

  // 取消只停这一轮:Claude 被打断后后台命令照跑,进程退出才带走它。
  it('a cancelled turn that leaves a background command running is parked, not idle', () => {
    const { readings, doneEdges, anomalies } = replay([
      working({ backgroundCommandCount: 1 }),
      working({ lifecycle: 'cancelling', backgroundCommandCount: 1 }),
      summary({ backgroundCommandCount: 1, lastTurnOutcome: 'stopped', lastStopReason: 'cancelled' }),
      summary({ lastTurnOutcome: 'stopped', lastStopReason: 'cancelled' }),
    ]);
    expect(readings[2]).toEqual({ status: 'working', detail: 'parked', running: false, background: 'running' });
    expect(readings[3]).toMatchObject({ status: 'idle', detail: 'plain', background: null });
    expect(doneEdges, 'a cancelled turn is never a finished one').toBe(0);
    expect(anomalies).toEqual([]);
  });

  it('a background agent and a background command are one background: park lasts until both are gone', () => {
    const { readings } = replay([
      working(),
      summary({ isGenerating: true, backgroundAgentCount: 1, backgroundCommandCount: 1, lastTurnOutcome: 'stopped', lastStopReason: 'end_turn' }),
      summary({ backgroundCommandCount: 1, lastTurnOutcome: 'stopped', lastStopReason: 'end_turn' }),
      summary({ lastTurnOutcome: 'stopped', lastStopReason: 'end_turn' }),
    ]);
    expect(readings[1]).toMatchObject({ status: 'working', detail: 'parked' });
    expect(readings[2], 'the agent finished, the command still runs').toMatchObject({ status: 'working', detail: 'parked' });
    expect(readings[3]).toMatchObject({ status: 'idle', background: null });
  });
});

describe('ACP status projection: what a permission request waits on (#6448)', () => {
  it.each([
    ['approval', 'approval'],
    ['question', 'question'],
    ['plan', 'plan'],
  ] as const)('a pending %s request reads as needs_user/%s', (waitKind, detail) => {
    const { readings } = replay([working(), working(waits(['r1', waitKind]))]);
    expect(readings.at(-1)).toEqual({ status: 'needs_user', detail, running: true, background: null });
  });

  it('a request that arrives with its turn belongs to that turn', () => {
    const { readings } = replay([summary(), working(waits(['r1', 'question']))]);
    expect(readings.at(-1)).toEqual({ status: 'needs_user', detail: 'question', running: true, background: null });
  });

  it('parallel requests close one by one', () => {
    const { readings, anomalies } = replay([
      working(),
      working(waits(['r1', 'approval'], ['r2', 'question'])),
      working(waits(['r2', 'question'])),
      working(),
    ]);
    expect(readings[1]).toMatchObject({ status: 'needs_user', detail: 'approval' });
    expect(readings[2]).toMatchObject({ status: 'needs_user', detail: 'question' });
    expect(readings[3]).toMatchObject({ status: 'working', detail: 'running' });
    expect(anomalies).toEqual([]);
  });

  it('a request a background agent raises while parked is needs_user, and back to park when answered', () => {
    const parked = { isGenerating: true, backgroundAgentCount: 1, lastTurnOutcome: 'stopped', lastStopReason: 'end_turn' } as const;
    const { readings, anomalies } = replay([
      working(),
      summary(parked),
      summary({ ...parked, ...waits(['r1', 'approval']) }),
      summary(parked),
    ]);
    expect(readings[2]).toMatchObject({ status: 'needs_user', detail: 'approval', running: false });
    expect(readings[3]).toMatchObject({ status: 'working', detail: 'parked' });
    expect(anomalies).toEqual([]);
  });

  it('a turn that ends while a request is still pending keeps needs_user until it is answered', () => {
    const ended = { lastTurnOutcome: 'stopped', lastStopReason: 'end_turn' } as const;
    const { readings } = replay([
      working(),
      working(waits(['r1', 'approval'])),
      summary({ ...ended, ...waits(['r1', 'approval']) }),
      summary(ended),
    ]);
    expect(readings[2]).toMatchObject({ status: 'needs_user', detail: 'approval', running: false });
    expect(readings[3]).toMatchObject({ status: 'idle' });
  });

  it('a pending request survives a new turn starting', () => {
    const parked = { isGenerating: true, backgroundAgentCount: 1, lastTurnOutcome: 'stopped', lastStopReason: 'end_turn' } as const;
    const { readings } = replay([
      working(),
      summary({ ...parked, ...waits(['r1', 'approval']) }),
      working({ backgroundAgentCount: 1, ...waits(['r1', 'approval']) }),
    ]);
    expect(readings.at(-1)).toMatchObject({ status: 'needs_user', detail: 'approval', running: true });
  });
});

describe('ACP status projection: how the agent stopped (#6448)', () => {
  it('work the agent starts itself after a failed prompt ends as done, not stuck working', () => {
    const { readings, doneEdges } = replay([
      working(),
      summary({ lastTurnOutcome: 'errored' }),
      working(),
      summary({ lastTurnOutcome: 'stopped', lastStopReason: 'end_turn' }),
    ]);
    expect(readings[1]).toMatchObject({ status: 'error' });
    expect(readings[2]).toMatchObject({ status: 'working', detail: 'running' });
    expect(readings[3]).toEqual({ status: 'idle', detail: 'done', running: false, background: null });
    expect(doneEdges).toBe(1);
  });

  it('work the agent starts itself after a cancelled prompt ends as done (its own stop is written)', () => {
    const { readings, doneEdges } = replay([
      working(),
      summary({ lastTurnOutcome: 'stopped', lastStopReason: 'cancelled' }),
      working({ lastStopReason: 'cancelled' }),
      summary({ lastTurnOutcome: 'stopped', lastStopReason: 'end_turn' }),
    ]);
    expect(readings[1]).toMatchObject({ status: 'idle', detail: 'plain' });
    expect(readings[3]).toMatchObject({ status: 'idle', detail: 'done' });
    expect(doneEdges).toBe(1);
  });

  it('cancelled work the agent started itself is a reset (control)', () => {
    const { readings, doneEdges } = replay([
      summary({ lastTurnOutcome: 'stopped', lastStopReason: 'end_turn' }),
      working({ lastStopReason: 'end_turn' }),
      working({ lifecycle: 'cancelling', lastStopReason: 'end_turn' }),
      summary({ lastTurnOutcome: 'stopped', lastStopReason: 'cancelled' }),
    ]);
    expect(readings.at(-1)).toMatchObject({ status: 'idle', detail: 'plain' });
    expect(doneEdges).toBe(0);
  });

  it('a cancelled prompt stays a reset (control)', () => {
    const { readings, doneEdges } = replay([
      working(),
      working({ lifecycle: 'cancelling' }),
      summary({ lastTurnOutcome: 'stopped', lastStopReason: 'cancelled' }),
    ]);
    expect(readings.at(-1)).toMatchObject({ status: 'idle', detail: 'plain' });
    expect(doneEdges).toBe(0);
  });

  // mac1 A 臂实测:MiMo 的 ACP 对取消一律回 end_turn,取消后响了完成音。宿主自己发过取消(经过 cancelling)就是被打断。
  it('a host-cancelled prompt the harness reports as end_turn is still a reset, not done', () => {
    const { readings, doneEdges } = replay([
      working(),
      working({ lifecycle: 'cancelling' }),
      summary({ lastTurnOutcome: 'stopped', lastStopReason: 'end_turn' }),
    ]);
    expect(readings.at(-1)).toMatchObject({ status: 'idle', detail: 'plain' });
    expect(doneEdges).toBe(0);
  });

  it('a failed prompt is an error and a normal one is done (controls)', () => {
    expect(replay([working(), summary({ lastTurnOutcome: 'errored' })]).readings.at(-1)).toMatchObject({ status: 'error' });
    const done = replay([working(), summary({ lastTurnOutcome: 'stopped', lastStopReason: 'max_tokens' })]);
    expect(done.readings.at(-1)).toMatchObject({ status: 'idle', detail: 'done' });
    expect(done.doneEdges).toBe(1);
  });

  it('queued prompts that vanish before any turn ran are not a finished turn', () => {
    const ended = { lastTurnOutcome: 'stopped', lastStopReason: 'end_turn' } as const;
    const { readings, doneEdges } = replay([
      working(),
      summary(ended),
      summary({ ...ended, queuedPromptCount: 1 }),
      summary(ended),
    ]);
    expect(readings[2]).toMatchObject({ status: 'working' });
    expect(readings.at(-1)).toMatchObject({ status: 'idle', detail: 'plain' });
    expect(doneEdges, 'only the real turn end chimes').toBe(1);
  });

  it('fails loudly when a prompt turn ends without a recorded outcome', () => {
    expect(() => deriveAcpAgentStatusActions(working(), summary())).toThrow(/without a recorded outcome/);
  });
});
