import { makeStdinHookCommand } from '@gugu/session-core/agents/plugins/helpers';
import { describe, expect, it } from 'vitest';
import { provider as claude } from '.';
import { buildClaudeHookConfig, claudeHookSpecs } from './hooks';

const parse = buildClaudeHookConfig().parseHookEvent;

// spec hook-status-derivation:Claude 的 Notification 按结构化 notification_type 翻译,❌ 按正文猜。
describe('claude Notification hook → canonical event', () => {
  it.each(['permission_prompt', 'worker_permission_prompt'])('%s waits for an approval click', (type) => {
    expect(parse('notification', { notification_type: type, message: 'Claude needs your permission to use Bash' }))
      .toMatchObject({ kind: 'status', type: 'notification', notificationType: 'permission_prompt' });
  });

  it('idle_prompt stays idle_prompt (idle, not "waiting for you")', () => {
    expect(parse('notification', { notification_type: 'idle_prompt', message: 'Claude is waiting for your input' }))
      .toMatchObject({ kind: 'status', type: 'notification', notificationType: 'idle_prompt' });
  });

  // 反例:这些是回合内事件。按正文猜时它们全被折成 idle_prompt,会把一个在跑的回合打成 idle。
  it.each(['elicitation_dialog', 'agent_needs_input', 'auth_success', 'push_notification', 'computer_use_enter'])(
    '%s carries no status',
    (type) => {
      expect(parse('notification', { notification_type: type, message: 'Claude is waiting for your input' }))
        .toEqual({ kind: 'ignore' });
    },
  );

  it('a Notification without notification_type fails loud instead of being guessed from its text', () => {
    expect(() => parse('notification', { message: 'Claude needs your permission to use Bash' }))
      .toThrow(/notification_type/);
  });

  it('turn edges are untouched', () => {
    expect(parse('stop', {})).toMatchObject({ kind: 'status', type: 'stop' });
    expect(parse('start', {})).toMatchObject({ kind: 'status', type: 'start' });
  });

  it('a failed turn (StopFailure → error) is an error edge, not a silent idle', () => {
    expect(parse('error', { error: 'authentication_failed' })).toMatchObject({ kind: 'status', type: 'error' });
  });

  it('#6264 StopFailure with authentication_failed says the sign-in was refused; other API errors do not', () => {
    expect(parse('error', { error: 'authentication_failed' })).toMatchObject({ signInRequired: true });
    expect(parse('error', { error: 'rate_limit' })).not.toHaveProperty('signInRequired');
    expect(parse('stop', { error: 'authentication_failed' })).not.toHaveProperty('signInRequired');
  });
});

// #6377:Stop 的 background_tasks(Claude 2.1.281 实测形状)数成「仍在干活的后台任务」,monitor / teammate 不算。
describe('claude Stop hook → background tasks still doing work', () => {
  const task = (type: string) => ({ id: `t-${type}`, type, status: 'running', description: type });

  it('counts running background shells and subagents', () => {
    expect(parse('stop', { background_tasks: [task('shell'), task('subagent')] }))
      .toMatchObject({ kind: 'status', type: 'stop', backgroundTasks: 2 });
  });

  it('a monitor waits for events and a teammate is another agent’s work — neither counts as doing work', () => {
    expect(parse('stop', { background_tasks: [task('monitor'), task('teammate')] }))
      .toMatchObject({ kind: 'status', type: 'stop', backgroundTasks: 0 });
  });

  it('an empty list is a real turn end', () => {
    expect(parse('stop', { background_tasks: [] })).toMatchObject({ kind: 'status', type: 'stop', backgroundTasks: 0 });
  });

  it('an older Claude without the field reports nothing (not 0)', () => {
    expect(parse('stop', { last_assistant_message: 'done' })).not.toHaveProperty('backgroundTasks');
  });

  it('a malformed list fails loud instead of being read as idle', () => {
    expect(() => parse('stop', { background_tasks: 'shell' })).toThrow(/not an array/);
    expect(() => parse('stop', { background_tasks: [{ id: 'x' }] })).toThrow(/no type/);
  });
});

// #6448:等人的入口与出口。payload 形状取自 2.1.278 真 PTY 的 hook tap(咕咕 base evidence 2026-09-25-agent-status-two-layer)。
describe('claude waits: PermissionRequest / question-tool PreToolUse → wait, PostToolUse(Failure) → wait_resolved', () => {
  const common = { session_id: 's', transcript_path: 't', cwd: 'c', prompt_id: 'p', permission_mode: 'default' };
  const ask = { ...common, tool_name: 'AskUserQuestion', tool_input: { questions: [] }, tool_use_id: 'toolu_ask' };

  it('PermissionRequest for an ordinary tool is an approval wait (it carries no tool_use_id)', () => {
    const event = parse('wait', {
      ...common,
      hook_event_name: 'PermissionRequest',
      tool_name: 'Write',
      tool_input: { file_path: 'probe.txt' },
      permission_suggestions: [{ type: 'setMode', mode: 'acceptEdits', destination: 'session' }],
    });
    expect(event).toEqual({ kind: 'status', type: 'wait', waitKind: 'approval' });
  });

  it('a PermissionRequest that does carry tool_use_id keeps it as the wait id', () => {
    expect(parse('wait', { ...common, hook_event_name: 'PermissionRequest', tool_name: 'Bash', tool_use_id: 'toolu_b' }))
      .toEqual({ kind: 'status', type: 'wait', waitKind: 'approval', waitId: 'toolu_b' });
  });

  it.each([
    ['AskUserQuestion', 'question'],
    ['ExitPlanMode', 'plan'],
  ])('PreToolUse for %s opens a %s wait keyed by tool_use_id', (tool, kind) => {
    expect(parse('wait', { ...ask, hook_event_name: 'PreToolUse', tool_name: tool }))
      .toEqual({ kind: 'status', type: 'wait', waitKind: kind, waitId: 'toolu_ask' });
  });

  it('PermissionRequest for a question tool is ignored: PreToolUse already opened it, and this one races the answer', () => {
    // 对照:同一个 PermissionRequest 换成普通工具就是一次批准 —— 被忽略的只有问题 / 计划两个工具。
    expect(parse('wait', { ...ask, hook_event_name: 'PermissionRequest', tool_name: 'Edit' }))
      .toEqual({ kind: 'status', type: 'wait', waitKind: 'approval', waitId: 'toolu_ask' });
    expect(parse('wait', { ...ask, hook_event_name: 'PermissionRequest', permission_mode: 'bypassPermissions' }))
      .toEqual({ kind: 'ignore' });
    expect(parse('wait', { ...ask, hook_event_name: 'PermissionRequest', tool_name: 'ExitPlanMode' }))
      .toEqual({ kind: 'ignore' });
  });

  it('a PreToolUse outside the matcher, or a wait without its fields, fails loud', () => {
    expect(() => parse('wait', { ...common, hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_use_id: 'x' }))
      .toThrow(/outside its matcher/);
    expect(() => parse('wait', { ...ask, hook_event_name: 'PreToolUse', tool_use_id: undefined })).toThrow(/tool_use_id/);
    expect(() => parse('wait', { ...common, hook_event_name: 'PermissionRequest' })).toThrow(/tool_name/);
    expect(() => parse('wait', { ...common, tool_name: 'Write' })).toThrow(/hook_event_name/);
    expect(() => parse('wait', { ...common, hook_event_name: 'Stop', tool_name: 'Write' })).toThrow(/arrived as Stop/);
  });

  it('the question tool completing resolves exactly its own wait', () => {
    expect(parse('wait_resolved', { ...ask, hook_event_name: 'PostToolUse', tool_response: {}, duration_ms: 1 }))
      .toEqual({ kind: 'status', type: 'wait_resolved', waitId: 'toolu_ask' });
  });

  it.each(['PostToolUse', 'PostToolUseFailure'])('%s of any other tool resolves every open wait (no id)', (hook) => {
    const event = parse('wait_resolved', {
      ...common,
      hook_event_name: hook,
      tool_name: 'Read',
      tool_use_id: 'toolu_r',
      error: 'File does not exist.',
      is_interrupt: false,
    });
    expect(event).toEqual({ kind: 'status', type: 'wait_resolved' });
  });

  it('a completion without hook_event_name / tool_name fails loud', () => {
    expect(() => parse('wait_resolved', { ...common, tool_name: 'Read' })).toThrow(/hook_event_name/);
    expect(() => parse('wait_resolved', { ...common, hook_event_name: 'PostToolUse' })).toThrow(/tool_name/);
  });

  // #6941 Claude 2.1.289 回合结束的 prompt_suggestion fork 发来的真实 payload(gugu-base evidence
  // 2026-10-06-yellow-dot-fork-pretooluse r3;agent_id 原样,其余脱敏):父会话的 session_id、fork 的 agent_id、没有 agent_type。
  const forkAsk = {
    session_id: 'parent-session',
    transcript_path: '/claude/projects/p/parent-session.jsonl',
    cwd: '/work',
    prompt_id: 'prompt',
    permission_mode: 'bypassPermissions',
    agent_id: 'a8e211d5164a4bf42',
    effort: { level: 'medium' },
    hook_event_name: 'PreToolUse',
    tool_name: 'AskUserQuestion',
    tool_input: { questions: [{ question: 'yd-probe: which next step?', header: 'yd-probe', multiSelect: false,
      options: [{ label: 'A', description: 'Option A' }, { label: 'B', description: 'Option B' }] }] },
    tool_use_id: 'toolu_fork',
  };

  it.each(['AskUserQuestion', 'ExitPlanMode'])('a %s PreToolUse that carries agent_id (a turn-end fork) opens no wait', (tool) => {
    expect(parse('wait', { ...forkAsk, tool_name: tool })).toEqual({ kind: 'ignore' });
  });

  it('the same call from the main thread (no agent_id) still opens the question wait', () => {
    const { agent_id: _forkId, ...mainThread } = forkAsk;
    expect(parse('wait', mainThread)).toEqual({ kind: 'status', type: 'wait', waitKind: 'question', waitId: 'toolu_fork' });
  });
});

// #6448:Stop 的自驱工作 —— 后台任务做功;monitor 与 session_crons 是定时醒来(scheduled);teammate 两边都不算。
describe('claude Stop hook → scheduled self wake-ups', () => {
  const task = (type: string) => ({ id: `t-${type}`, type, status: 'running', description: type });
  const cron = { id: 'c1', schedule: '*/5 * * * *', recurring: true, prompt: '/loop check' };

  it('a monitor is a scheduled wake-up, not excluded', () => {
    expect(parse('stop', { background_tasks: [task('monitor'), task('shell')], session_crons: [] }))
      .toMatchObject({ backgroundTasks: 1, scheduledTasks: 1 });
  });

  it('session_crons count as scheduled', () => {
    expect(parse('stop', { background_tasks: [], session_crons: [cron, { ...cron, id: 'c2' }] }))
      .toMatchObject({ backgroundTasks: 0, scheduledTasks: 2 });
  });

  it('a teammate counts as neither', () => {
    expect(parse('stop', { background_tasks: [task('teammate')], session_crons: [] }))
      .toMatchObject({ backgroundTasks: 0, scheduledTasks: 0 });
  });

  it('an older Claude without either field reports neither count', () => {
    const event = parse('stop', { last_assistant_message: 'done' });
    expect(event).not.toHaveProperty('scheduledTasks');
    expect(event).not.toHaveProperty('backgroundTasks');
  });

  it('a malformed cron list fails loud', () => {
    expect(() => parse('stop', { background_tasks: [], session_crons: 'x' })).toThrow(/session_crons is not an array/);
  });
});

describe('claude StopFailure → error carrying its reason', () => {
  it('the structured error class and its details become the reason', () => {
    expect(parse('error', { hook_event_name: 'StopFailure', error: 'rate_limit', error_details: '429 Too Many Requests' }))
      .toMatchObject({ kind: 'status', type: 'error', message: 'rate_limit: 429 Too Many Requests' });
    expect(parse('error', { hook_event_name: 'StopFailure', error: 'server_error' }))
      .toMatchObject({ kind: 'status', type: 'error', message: 'server_error' });
  });

  it('a StopFailure without its error class fails loud', () => {
    expect(() => parse('error', { hook_event_name: 'StopFailure' })).toThrow(/carries no error/);
  });
});

describe('claude hook installation (#6448)', () => {
  const byKey = (key: string) => claudeHookSpecs().filter((spec) => spec.hookKey === key);

  it('installs the wait edges, with the question-tool matcher and async completions', () => {
    expect(byKey('PermissionRequest')).toEqual([{ hookKey: 'PermissionRequest', command: makeStdinHookCommand('wait') }]);
    expect(byKey('PreToolUse')).toEqual([
      { hookKey: 'PreToolUse', command: makeStdinHookCommand('wait'), matcher: 'AskUserQuestion|ExitPlanMode' },
    ]);
    for (const key of ['PostToolUse', 'PostToolUseFailure']) {
      expect(byKey(key)).toEqual([{ hookKey: key, command: makeStdinHookCommand('wait_resolved'), async: true }]);
    }
  });

  it('the new keys exist at the 2.1.69 floor, so only StopFailure carries a version gate', () => {
    expect(claudeHookSpecs().filter((spec) => spec.sinceVersion).map((spec) => spec.hookKey)).toEqual(['StopFailure']);
  });

  it('the descriptor declares every edge the hooks report', () => {
    const hooks = claude.capabilities.hooks;
    expect(hooks.kind !== 'none' && [...hooks.supportedEvents].sort()).toEqual(
      ['error', 'notification', 'start', 'stop', 'wait', 'wait_resolved'],
    );
  });
});
