import { describe, expect, it } from 'vitest';
import type { AgentEvent } from '@shared/core/agents/agentEvents';
import {
  emptyStatusLogState,
  readStatusLog,
  stepStatusLog,
  type AgentStatusLogState,
} from './status-event-log';
import { translateAgentEvent } from './status-event-translator';

/**
 * spec status-event-log「翻译」(#6448):每条腿送来的 AgentEvent 经翻译 + reduce 得到基础态、附属态与功能布尔。
 * 这里的每一格都是一条真实会发生的序列(出处写在用例名里),断言的是 owner 定下的语义,❌ 跑一遍抄结果。
 */
type EventInput = Pick<AgentEvent, 'type'> & { payload?: AgentEvent['payload'] };

function session(opts: { autoApproved?: boolean } = {}) {
  const state: AgentStatusLogState = emptyStatusLogState();
  const anomalies: string[] = [];
  const feed = (input: EventInput) => {
    const event: AgentEvent = {
      type: input.type,
      providerId: 'claude',
      projectId: 'p',
      sessionId: 'c',
      timestamp: 0,
      payload: input.payload ?? {},
    };
    const canonical = translateAgentEvent(event, {
      running: state.running,
      waiting: state.waits.size > 0,
      failed: state.error !== null,
      autoApproved: opts.autoApproved ?? false,
    });
    for (const e of canonical) stepStatusLog(state, e, (what) => anomalies.push(what));
    return readStatusLog(state);
  };
  return { feed, anomalies };
}

describe('base status + display detail from real sequences', () => {
  it('a turn runs, then ends normally: working/running → idle/done with the turn-end edge', () => {
    const s = session();
    expect(s.feed({ type: 'start' })).toMatchObject({ status: 'working', detail: 'running', running: true });
    expect(s.feed({ type: 'stop' })).toMatchObject({ status: 'idle', detail: 'done', running: false, finished: true });
  });

  it('claude TUI: Stop with a running background shell is park (working, not a turn end), the notification turn ends it (measured 2.1.278)', () => {
    const s = session();
    s.feed({ type: 'start' });
    expect(s.feed({ type: 'stop', payload: { backgroundTasks: 1, scheduledTasks: 0 } })).toMatchObject({
      status: 'working',
      detail: 'parked',
      running: false,
      background: 'running',
      finished: false,
    });
    // Claude 在停之后约 60 秒照发闲置提醒,它不看后台 ⇒ 不是新事实。
    expect(s.feed({ type: 'notification', payload: { notificationType: 'idle_prompt' } })).toMatchObject({
      status: 'working',
      detail: 'parked',
    });
    expect(s.feed({ type: 'start' })).toMatchObject({ status: 'working', detail: 'running', running: true });
    expect(s.feed({ type: 'stop', payload: { backgroundTasks: 0, scheduledTasks: 0 } })).toMatchObject({
      status: 'idle',
      detail: 'done',
      finished: true,
    });
  });

  it('owner decision: a scheduled wake-up (/loop, cron) is working/parked but never a done edge', () => {
    const s = session();
    s.feed({ type: 'start' });
    expect(s.feed({ type: 'stop', payload: { backgroundTasks: 0, scheduledTasks: 1 } })).toMatchObject({
      status: 'working',
      detail: 'parked',
      background: 'scheduled',
      finished: false,
    });
  });

  it('an approval the spawn did not auto-approve waits for the human; it clears when the tool ran', () => {
    const s = session();
    s.feed({ type: 'start' });
    expect(s.feed({ type: 'notification', payload: { notificationType: 'permission_prompt' } })).toMatchObject({
      status: 'needs_user',
      detail: 'approval',
      running: true,
    });
    expect(s.feed({ type: 'wait_resolved' })).toMatchObject({ status: 'working', detail: 'running' });
  });

  it('an auto-approved permission prompt carries no status (the turn keeps running)', () => {
    const s = session({ autoApproved: true });
    s.feed({ type: 'start' });
    expect(s.feed({ type: 'notification', payload: { notificationType: 'permission_prompt' } })).toMatchObject({
      status: 'working',
      detail: 'running',
    });
  });

  it('a question is never swallowed by auto-approve (AskUserQuestion waits in bypass mode too, measured 2.1.278)', () => {
    const s = session({ autoApproved: true });
    s.feed({ type: 'start' });
    expect(s.feed({ type: 'wait', payload: { waitKind: 'question', waitId: 'toolu_1' } })).toMatchObject({
      status: 'needs_user',
      detail: 'question',
    });
    // 约 6 秒后到的 permission_prompt 是同一个对话框。
    expect(s.feed({ type: 'notification', payload: { notificationType: 'permission_prompt' } })).toMatchObject({
      status: 'needs_user',
      detail: 'question',
    });
    expect(s.feed({ type: 'wait_resolved', payload: { waitId: 'toolu_1' } })).toMatchObject({
      status: 'working',
      detail: 'running',
    });
  });

  it('negative control: the same question arrives as an approval-kind wait under auto-approve ⇒ dropped', () => {
    const s = session({ autoApproved: true });
    s.feed({ type: 'start' });
    expect(s.feed({ type: 'wait', payload: { waitKind: 'approval' } })).toMatchObject({ status: 'working' });
  });

  it('idle_prompt closes a turn whose stop never came (Esc in the Claude TUI, qwen cancel) as cancelled — not done', () => {
    const s = session();
    s.feed({ type: 'start' });
    expect(s.feed({ type: 'notification', payload: { notificationType: 'idle_prompt' } })).toMatchObject({
      status: 'idle',
      detail: 'plain',
      finished: false,
    });
  });

  it('idle_prompt does not wipe a failure or a pending approval (#6167)', () => {
    const failed = session();
    failed.feed({ type: 'start' });
    failed.feed({ type: 'error', payload: { message: 'api 500' } });
    expect(failed.feed({ type: 'notification', payload: { notificationType: 'idle_prompt' } })).toMatchObject({
      status: 'error',
    });
    const waiting = session();
    waiting.feed({ type: 'start' });
    waiting.feed({ type: 'notification', payload: { notificationType: 'permission_prompt' } });
    expect(waiting.feed({ type: 'notification', payload: { notificationType: 'idle_prompt' } })).toMatchObject({
      status: 'needs_user',
    });
  });

  it('a user interrupt reported as a cancelled stop (codex interrupted, opencode abort) is idle/plain, not a done edge', () => {
    const s = session();
    s.feed({ type: 'start' });
    expect(s.feed({ type: 'stop', payload: { outcome: 'cancelled' } })).toMatchObject({
      status: 'idle',
      detail: 'plain',
      finished: false,
    });
  });

  it('a start while a turn is open (qwen before every model call) resumes the turn and clears the wait', () => {
    const s = session();
    s.feed({ type: 'start' });
    s.feed({ type: 'notification', payload: { notificationType: 'permission_prompt' } });
    expect(s.feed({ type: 'start' })).toMatchObject({ status: 'working', detail: 'running' });
    expect(s.anomalies).toEqual([]);
  });

  it('ACP background agents observed after the reply: park, and the autonomous cycle that follows ends it', () => {
    const s = session();
    s.feed({ type: 'start' });
    s.feed({ type: 'stop' });
    expect(s.feed({ type: 'background', payload: { backgroundTasks: 1 } })).toMatchObject({
      status: 'working',
      detail: 'parked',
      finished: false,
    });
    expect(s.feed({ type: 'background', payload: { backgroundTasks: 0 } })).toMatchObject({
      status: 'idle',
      finished: false,
    });
  });

  it('a subagent edge carries no status (#6385)', () => {
    const s = session();
    s.feed({ type: 'start' });
    expect(s.feed({ type: 'stop', payload: { origin: 'subagent' } })).toMatchObject({ status: 'working' });
  });

  it('a stop with no open turn is not a turn end (e.g. first hook after a restart)', () => {
    const s = session();
    expect(s.feed({ type: 'stop' })).toMatchObject({ status: 'idle', detail: 'plain', finished: false });
  });
});
