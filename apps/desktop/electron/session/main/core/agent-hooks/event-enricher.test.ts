import type { CanonicalHookEvent } from '@gugu/session-core/agents/plugins';
import { pluginRegistry } from '@gugu/session-plugins/agents';
import { describe, expect, it, vi } from 'vitest';
import type { AgentStatusDetail } from '@shared/core/agents/agentEvents';
import { emptyStatusLogState, readStatusLog, stepStatusLog } from '../agent-status/status-event-log';
import { translateAgentEvent } from '../agent-status/status-event-translator';

vi.mock('@main/db/client', () => ({ db: {} }));

const { canonicalToAgentEvent } = await import('./event-enricher');

const ctx = {
  sessionId: 'c1',
  projectId: 'p1',
  providerId: 'claude',
  ptyId: 'claude-conv-c1',
  sourceId: 'src-1',
  receivedAt: 1_000,
};

// #6448:解析器量到的附属字段原样进 AgentEvent.payload;量不到的原样缺席。
describe('canonicalToAgentEvent carries the two-layer fields', () => {
  it('passes wait kind / id, scheduled count and the cancelled outcome through', () => {
    const wait = canonicalToAgentEvent({ kind: 'status', type: 'wait', waitKind: 'question', waitId: 'toolu_1' }, ctx);
    expect(wait).toMatchObject({ type: 'wait', payload: { waitKind: 'question', waitId: 'toolu_1' } });
    const stop = canonicalToAgentEvent(
      { kind: 'status', type: 'stop', backgroundTasks: 0, scheduledTasks: 2, outcome: 'cancelled' },
      ctx,
    );
    expect(stop.payload).toMatchObject({ backgroundTasks: 0, scheduledTasks: 2, outcome: 'cancelled' });
  });

  // #7141 review 9a096d48bd: each event is enriched on its own, async — a time taken after it would put a late Stop of
  // one round after the next round's start. Its time is when its hook arrived.
  it('its time is when its hook reached the hook server, not when it was turned into an event', () => {
    expect(canonicalToAgentEvent({ kind: 'status', type: 'stop', lastAssistantMessage: 'A1' }, { ...ctx, receivedAt: 4_900 }).timestamp).toBe(4_900);
  });

  it('leaves unreported fields absent (not 0, not a default)', () => {
    const payload = canonicalToAgentEvent({ kind: 'status', type: 'stop' }, ctx).payload;
    for (const key of ['backgroundTasks', 'scheduledTasks', 'outcome', 'waitKind', 'waitId']) {
      expect(payload, key).not.toHaveProperty(key);
    }
  });
});

/**
 * 真机序列回放:Claude 2.1.278 真 PTY(咕咕 base evidence `2026-09-25-agent-status-two-layer`,本车道 tap)按到达顺序的
 * hook(只留咕咕装的键,payload 字段照录)→ Claude 解析器 → AgentEvent → 翻译 → 事件日志 reduce。每步写期望的
 * 基础态 / 附属态,期望来自「对的行为」(DECISION.md),❌ 跑一遍抄下来。
 */
type Step = { type: string; body: Record<string, unknown>; expect: [string, AgentStatusDetail | null] };
const claudeParse = pluginRegistry.get('claude')!.behavior.hooks!.parseHookEvent! as (
  type: string,
  body: Record<string, unknown>,
) => CanonicalHookEvent;

function replay(steps: Step[], autoApproved: boolean) {
  const state = emptyStatusLogState();
  const anomalies: string[] = [];
  return {
    anomalies,
    trace: steps.map((step) => {
      const canonical = claudeParse(step.type, step.body);
      if (canonical.kind === 'status') {
        const event = canonicalToAgentEvent(canonical, ctx);
        const events = translateAgentEvent(event, {
          running: state.running,
          waiting: state.waits.size > 0,
          failed: state.error !== null,
          autoApproved,
        });
        for (const e of events) stepStatusLog(state, e, (what) => anomalies.push(what));
      }
      const reading = readStatusLog(state);
      return { step, got: [reading.status, reading.detail] as [string, AgentStatusDetail | null] };
    }),
  };
}

const base = { session_id: 's', transcript_path: 't', cwd: 'c', prompt_id: 'p' };
const prompt = (text: string): Step['body'] => ({ ...base, permission_mode: 'default', hook_event_name: 'UserPromptSubmit', prompt: text });
const stop = (extra: Record<string, unknown> = {}): Step['body'] => ({
  ...base,
  hook_event_name: 'Stop',
  stop_hook_active: false,
  background_tasks: [],
  session_crons: [],
  ...extra,
});
const tool = (hook: string, tool_name: string, extra: Record<string, unknown> = {}): Step['body'] => ({
  ...base,
  permission_mode: 'default',
  hook_event_name: hook,
  tool_name,
  tool_input: {},
  ...extra,
});
const permissionPrompt = { ...base, hook_event_name: 'Notification', message: 'Claude needs your permission', notification_type: 'permission_prompt' };

describe('Claude 2.1.278 hook sequences through parser → translator → reduce (#6448)', () => {
  it('approval: PermissionRequest shows needs_user(approval) at once; the tool completing returns to running', () => {
    const { trace, anomalies } = replay([
      { type: 'start', body: prompt('Use the Write tool …'), expect: ['working', 'running'] },
      { type: 'wait', body: tool('PermissionRequest', 'Write', { permission_suggestions: [] }), expect: ['needs_user', 'approval'] },
      { type: 'wait_resolved', body: tool('PostToolUse', 'Write', { tool_use_id: 'toolu_01PyX', duration_ms: 69 }), expect: ['working', 'running'] },
      { type: 'stop', body: stop(), expect: ['idle', 'done'] },
    ], false);
    for (const { step, got } of trace) expect(got, step.body.hook_event_name as string).toEqual(step.expect);
    expect(anomalies).toEqual([]);
  });

  it('question (default mode): PreToolUse opens it, PermissionRequest and the 6 s permission_prompt add nothing, PostToolUse closes it', () => {
    const ask = { tool_use_id: 'toolu_01Np' };
    const { trace, anomalies } = replay([
      { type: 'start', body: prompt('Use the AskUserQuestion tool …'), expect: ['working', 'running'] },
      { type: 'wait', body: tool('PreToolUse', 'AskUserQuestion', ask), expect: ['needs_user', 'question'] },
      { type: 'wait', body: tool('PermissionRequest', 'AskUserQuestion'), expect: ['needs_user', 'question'] },
      { type: 'notification', body: permissionPrompt, expect: ['needs_user', 'question'] },
      { type: 'wait_resolved', body: tool('PostToolUse', 'AskUserQuestion', { ...ask, duration_ms: 1 }), expect: ['working', 'running'] },
      { type: 'stop', body: stop(), expect: ['idle', 'done'] },
    ], false);
    for (const { step, got } of trace) expect(got, step.body.hook_event_name as string).toEqual(step.expect);
    expect(anomalies).toEqual([]);
  });

  it('question under bypassPermissions (auto-approved session): still needs_user; the late PermissionRequest does not reopen it', () => {
    const ask = { tool_use_id: 'toolu_012h', permission_mode: 'bypassPermissions' };
    const { trace, anomalies } = replay([
      { type: 'start', body: prompt('Use the AskUserQuestion tool …'), expect: ['working', 'running'] },
      { type: 'wait', body: tool('PreToolUse', 'AskUserQuestion', ask), expect: ['needs_user', 'question'] },
      // 实测:这一条落在用户答完之后(bypass 下它与对话框并行)。
      { type: 'wait', body: tool('PermissionRequest', 'AskUserQuestion', ask), expect: ['needs_user', 'question'] },
      { type: 'wait_resolved', body: tool('PostToolUse', 'AskUserQuestion', { ...ask, duration_ms: 1 }), expect: ['working', 'running'] },
      { type: 'stop', body: stop(), expect: ['idle', 'done'] },
    ], true);
    for (const { step, got } of trace) expect(got, step.body.hook_event_name as string).toEqual(step.expect);
    expect(anomalies).toEqual([]);
  });

  it('plan approval: ExitPlanMode is a plan wait', () => {
    const plan = { tool_use_id: 'toolu_01Hk', permission_mode: 'plan' };
    const { trace } = replay([
      { type: 'start', body: prompt('Make a one-step plan …'), expect: ['working', 'running'] },
      { type: 'wait_resolved', body: tool('PostToolUse', 'Write', { tool_use_id: 'toolu_019g', permission_mode: 'plan' }), expect: ['working', 'running'] },
      { type: 'wait', body: tool('PreToolUse', 'ExitPlanMode', plan), expect: ['needs_user', 'plan'] },
      { type: 'wait', body: tool('PermissionRequest', 'ExitPlanMode', plan), expect: ['needs_user', 'plan'] },
      { type: 'notification', body: { ...permissionPrompt, message: 'Claude Code needs your approval for the plan' }, expect: ['needs_user', 'plan'] },
    ], false);
    for (const { step, got } of trace) expect(got, step.body.hook_event_name as string).toEqual(step.expect);
  });

  it('a background shell parks the session; the task-notification turn brings it back to done', () => {
    const shell = { id: 'byhn28hbi', type: 'shell', status: 'running', description: 'Background sleep', command: 'Start-Sleep 20' };
    const { trace } = replay([
      { type: 'start', body: prompt('Use the PowerShell tool with run_in_background …'), expect: ['working', 'running'] },
      { type: 'wait_resolved', body: tool('PostToolUse', 'PowerShell', { tool_use_id: 'toolu_01MZ' }), expect: ['working', 'running'] },
      { type: 'stop', body: stop({ background_tasks: [shell] }), expect: ['working', 'parked'] },
      { type: 'start', body: prompt('<task-notification>\n<task-id>byhn28hbi</task-id>'), expect: ['working', 'running'] },
      { type: 'stop', body: stop(), expect: ['idle', 'done'] },
    ], false);
    for (const { step, got } of trace) expect(got, step.body.hook_event_name as string).toEqual(step.expect);
  });

  it('a monitor or a /loop cron keeps the session parked as scheduled work', () => {
    const monitor = { id: 'm1', type: 'monitor', status: 'running', description: 'watch CI' };
    const cron = { id: 'c1', schedule: '*/5 * * * *', recurring: true, prompt: '/loop check' };
    for (const extra of [{ background_tasks: [monitor] }, { session_crons: [cron] }]) {
      const { trace } = replay([
        { type: 'start', body: prompt('watch'), expect: ['working', 'running'] },
        { type: 'stop', body: stop(extra), expect: ['working', 'parked'] },
      ], false);
      for (const { step, got } of trace) expect(got, JSON.stringify(extra)).toEqual(step.expect);
    }
  });

  it('StopFailure ends the turn in error, with its reason', () => {
    const { trace } = replay([
      { type: 'start', body: prompt('hi'), expect: ['working', 'running'] },
      { type: 'error', body: { ...base, hook_event_name: 'StopFailure', error: 'rate_limit', error_details: '429' }, expect: ['error', null] },
    ], false);
    for (const { step, got } of trace) expect(got).toEqual(step.expect);
  });
});
