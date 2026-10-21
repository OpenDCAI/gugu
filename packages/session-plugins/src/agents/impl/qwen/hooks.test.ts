import { makeStdinHookCommand, nestedHooksObject } from '@gugu/session-core/agents/plugins/helpers';
import { describe, expect, it } from 'vitest';
import { provider as qwen } from '.';
import { qwenHookSpecs } from './hooks';

const parse = qwen.behavior.hooks!.parseHookEvent!;
// 字段取自 qwen 0.24.4 发行包的 hook 输入(createBaseInput 的公共字段)与 mac1 实测的 hook stdin。
const base = { session_id: 's', transcript_path: 't', cwd: 'c', timestamp: '2026-09-24T05:10:25.843Z', permission_mode: 'default' };

// #6448:PermissionRequest 按 tool_name 分批准 / 问题 / 计划;问题在 yolo 下也要确认,翻译层 ❌ 当批准吞掉。
describe('qwen PermissionRequest → wait by tool', () => {
  it.each([
    ['ask_user_question', 'question'],
    ['exit_plan_mode', 'plan'],
    ['run_shell_command', 'approval'],
    ['write_file', 'approval'],
  ])('%s → %s', (tool, kind) => {
    expect(parse('wait', { ...base, hook_event_name: 'PermissionRequest', tool_name: tool, tool_input: {} }))
      .toEqual({ kind: 'status', type: 'wait', waitKind: kind });
  });

  it('a PermissionRequest without tool_name fails loud', () => {
    expect(() => parse('wait', { ...base, hook_event_name: 'PermissionRequest' })).toThrow(/tool_name/);
  });

  it('is installed as a wait event', () => {
    expect(qwenHookSpecs()).toContainEqual({ hookKey: 'PermissionRequest', command: makeStdinHookCommand('wait') });
  });
});

// #6448:qwen 的 Stop 报后台子代理(各种状态都在)与 crons;只数 running。
describe('qwen Stop → background subagents and crons', () => {
  const task = (status: string) => ({ id: `general-purpose-${status}`, status, agent_type: 'general-purpose', started_at: 'x', description: 'd' });
  const stop = (extra: Record<string, unknown>) => parse('stop', { ...base, hook_event_name: 'Stop', stop_hook_active: false, ...extra });

  it('a running background subagent keeps the session working; completed / cancelled ones do not', () => {
    expect(stop({ background_tasks: [task('running'), task('completed'), task('cancelled')], crons: [] }))
      .toMatchObject({ kind: 'status', type: 'stop', backgroundTasks: 1, scheduledTasks: 0 });
  });

  it('the measured "subagent finished" Stop reports nothing left', () => {
    expect(stop({ background_tasks: [task('completed')], crons: [] })).toMatchObject({ backgroundTasks: 0, scheduledTasks: 0 });
  });

  it('crons are scheduled wake-ups', () => {
    expect(stop({ background_tasks: [], crons: [{ id: 'c', schedule: '*/1 * * * *', prompt: 'p', recurring: true }] }))
      .toMatchObject({ backgroundTasks: 0, scheduledTasks: 1 });
  });

  it('an older qwen without the fields reports neither', () => {
    const event = stop({});
    expect(event).not.toHaveProperty('backgroundTasks');
    expect(event).not.toHaveProperty('scheduledTasks');
  });

  it('malformed lists fail loud', () => {
    expect(() => stop({ background_tasks: {}, crons: [] })).toThrow(/background_tasks is not an array/);
    expect(() => stop({ background_tasks: [{ id: 'x' }], crons: [] })).toThrow(/no status/);
    expect(() => stop({ background_tasks: [], crons: 'x' })).toThrow(/crons is not an array/);
  });
});

describe('qwen SessionEnd → an exit, never a finished turn', () => {
  it('SessionEnd is a stop marked cancelled', () => {
    expect(parse('stop', { ...base, hook_event_name: 'SessionEnd', reason: 'prompt_input_exit' }))
      .toMatchObject({ kind: 'status', type: 'stop', outcome: 'cancelled' });
  });

  it('a stop without hook_event_name, or from another key, fails loud', () => {
    expect(() => parse('stop', { ...base })).toThrow(/hook_event_name/);
    expect(() => parse('stop', { ...base, hook_event_name: 'SubagentStop' })).toThrow(/arrived as SubagentStop/);
  });
});

// #6448:失败的回合 qwen 发 StopFailure 而不是 Stop。
describe('qwen StopFailure → error', () => {
  it('is installed, as an error event, in the session settings', () => {
    expect(qwenHookSpecs()).toContainEqual({ hookKey: 'StopFailure', command: makeStdinHookCommand('error') });
    expect(nestedHooksObject(qwenHookSpecs()).StopFailure).toHaveLength(1);
  });

  it('carries the structured error class and details as the reason', () => {
    expect(parse('error', { ...base, hook_event_name: 'StopFailure', error: 'loop_detected', error_details: 'tool_call_loop' }))
      .toMatchObject({ kind: 'status', type: 'error', message: 'loop_detected: tool_call_loop' });
    expect(parse('error', { ...base, hook_event_name: 'StopFailure', error: 'rate_limit' }))
      .toMatchObject({ kind: 'status', type: 'error', message: 'rate_limit' });
  });

  it('a StopFailure without its error class fails loud', () => {
    expect(() => parse('error', { ...base, hook_event_name: 'StopFailure' })).toThrow(/carries no error/);
  });

  it('the descriptor declares the error and wait edges', () => {
    const hooks = qwen.capabilities.hooks;
    expect(hooks.kind !== 'none' && hooks.supportedEvents).toEqual(expect.arrayContaining(['error', 'wait']));
  });
});
