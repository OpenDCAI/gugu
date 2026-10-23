import { describe, expect, it } from 'vitest';
import {
  readStatusLog,
  reduceAgentStatus,
  restoreStatusLog,
  type AgentStatusEvent,
} from './status-event-log';

const S = 'c1';
const started = (): AgentStatusEvent => ({ kind: 'Started', sessionId: S });
const ended = (extra: Partial<Extract<AgentStatusEvent, { kind: 'Stopped' }>> = {}): AgentStatusEvent => ({
  kind: 'Stopped',
  sessionId: S,
  ...extra,
});
const read = (...events: AgentStatusEvent[]) => reduceAgentStatus(S, events);

describe('reduceAgentStatus', () => {
  it('在干活 = working/running;正常停下且什么都不剩 = idle/done + 做完的边', () => {
    expect(read(started())).toMatchObject({ status: 'working', detail: 'running', running: true, finished: false });
    expect(read(started(), ended())).toMatchObject({
      status: 'idle',
      detail: 'done',
      running: false,
      background: null,
      finished: true,
    });
  });

  it('park:agent 停下但后台任务 / 定时唤醒还开着 ⇒ working/parked,不是结束边;后台跑完也不是', () => {
    const parked = read(started(), ended({ backgroundTasks: 1, scheduledTasks: 1 }));
    expect(parked).toMatchObject({ status: 'working', detail: 'parked', running: false, background: 'running', finished: false });
    const scheduledOnly = read(started(), ended({ scheduledTasks: 2 }));
    expect(scheduledOnly).toMatchObject({ status: 'working', detail: 'parked', background: 'scheduled' });
    const drained = read(started(), ended({ backgroundTasks: 1 }), {
      kind: 'TasksObserved',
      sessionId: S,
      backgroundTasks: 0,
    });
    expect(drained).toMatchObject({ status: 'idle', detail: 'done', finished: false });
  });

  it('等人:附属态取优先级最高的等待;逐个了结后回到在跑;`*` 了结全部', () => {
    const waits = [
      started(),
      { kind: 'WaitStarted', sessionId: S, id: 'q', waitKind: 'question' },
      { kind: 'WaitStarted', sessionId: S, id: 'a', waitKind: 'approval' },
    ] satisfies AgentStatusEvent[];
    expect(read(...waits)).toMatchObject({ status: 'needs_user', detail: 'approval', running: true });
    expect(read(...waits, { kind: 'WaitEnded', sessionId: S, id: 'a' })).toMatchObject({
      status: 'needs_user',
      detail: 'question',
    });
    expect(read(...waits, { kind: 'WaitEnded', sessionId: S, id: '*' })).toMatchObject({
      status: 'working',
      detail: 'running',
    });
  });

  it('宿主开的会话级等待熬过停下,下次开工才清掉;agent 干活时开的等待随停下了结', () => {
    const dialog: AgentStatusEvent = { kind: 'WaitStarted', sessionId: S, id: 'trust', waitKind: 'dialog', scope: 'session' };
    expect(read(dialog)).toMatchObject({ status: 'needs_user', detail: 'dialog', running: false });
    expect(read(started(), dialog, ended())).toMatchObject({ status: 'needs_user', detail: 'dialog' });
    expect(read(dialog, started())).toMatchObject({ status: 'working', detail: 'running' });
    const agentWait: AgentStatusEvent = { kind: 'WaitStarted', sessionId: S, id: 'p1', waitKind: 'approval' };
    expect(read(started(), agentWait, ended())).toMatchObject({ status: 'idle', detail: 'done' });
    expect(read(agentWait), 'opened while not working: session-level').toMatchObject({ status: 'needs_user' });
  });

  it('宿主问人的等待(agent 的提问)熬过停下和下次开工,只由它自己的了结边收', () => {
    const question: AgentStatusEvent = { kind: 'WaitStarted', sessionId: S, id: 'host-ask:q', waitKind: 'question', scope: 'host' };
    expect(read(started(), question, ended())).toMatchObject({ status: 'needs_user', detail: 'question' });
    expect(read(started(), question, ended(), started())).toMatchObject({ status: 'needs_user', detail: 'question', running: true });
    expect(read(started(), question, { kind: 'WaitEnded', sessionId: S, id: '*' }), 'the harness\'s 「接着跑了」 is not an answer')
      .toMatchObject({ status: 'needs_user', detail: 'question' });
    expect(read(started(), question, ended(), started(), { kind: 'WaitEnded', sessionId: S, id: 'host-ask:q' }))
      .toMatchObject({ status: 'working', detail: 'running' });
  });

  it('打断不是做完:idle/plain,没有结束边;已有的失败照留', () => {
    expect(read(started(), { kind: 'Interrupted', sessionId: S })).toMatchObject({
      status: 'idle',
      detail: 'plain',
      finished: false,
    });
    expect(
      read(started(), { kind: 'Error', sessionId: S, reason: 'x' }, { kind: 'Interrupted', sessionId: S }),
    ).toMatchObject({ status: 'error', detail: null });
  });

  it('失败让 agent 停下,并保持到它下次开工', () => {
    const failed = [started(), { kind: 'Error', sessionId: S, reason: 'boom' }] satisfies AgentStatusEvent[];
    expect(read(...failed)).toMatchObject({ status: 'error', detail: null, running: false, finished: false });
    expect(read(...failed, started())).toMatchObject({ status: 'working', detail: 'running' });
  });

  it('对不上的事件不改状态,原样报进 anomalies:没在干活时的停下、没开过的等待、别的会话的事件', () => {
    const r = read(
      started(),
      ended(),
      ended(),
      { kind: 'WaitEnded', sessionId: S, id: 'nope' },
      { kind: 'Started', sessionId: 'other' },
    );
    expect(r).toMatchObject({ status: 'idle', detail: 'done', running: false });
    expect(r.anomalies).toHaveLength(3);
  });
});

describe('restoreStatusLog', () => {
  it.each([
    ['working', 'running', { status: 'working', detail: 'running', running: true, background: null }],
    ['working', 'parked', { status: 'working', detail: 'parked', running: false, background: 'running' }],
    ['working', null, { status: 'working', detail: 'running', running: true }],
    ['needs_user', 'question', { status: 'needs_user', detail: 'question', running: true }],
    ['needs_user', null, { status: 'needs_user', detail: 'approval' }],
    ['error', null, { status: 'error', detail: null }],
    ['idle', 'done', { status: 'idle', detail: 'done' }],
    ['idle', 'plain', { status: 'idle', detail: 'plain' }],
    ['idle', null, { status: 'idle', detail: 'plain' }],
    [null, null, { status: 'idle', detail: 'plain' }],
  ] as const)('%s / %s', (status, detail, want) => {
    expect(readStatusLog(restoreStatusLog(status, detail))).toMatchObject({ ...want, finished: false });
  });
});
