import type { PluginFs } from '@gugu/session-core/agents/plugins';
import { makeNotificationHookCommand, makeStdinHookCommand } from '@gugu/session-core/agents/plugins/helpers';
import { describe, expect, it } from 'vitest';
import { provider as copilot } from '.';
import { buildCopilotHookConfig, COPILOT_HOOKS_PATH } from './hooks';

const parse = buildCopilotHookConfig().parseHookEvent;
const MAIN = '62c7adfc-7b26-4fef-83d3-c0af54ef888d';
const SUB = '5f730f77-4948-4088-83cd-07bc34491985';
const transcriptOf = (id: string) => `/home/user/.copilot/session-state/${id}/events.jsonl`;

// #6385: an agentStop whose sessionId differs from the session id in its transcriptPath is a subagent's.
describe('copilot agentStop → subagent origin, proven by the payload', () => {
  it('a subagent stop (transcript belongs to the main session) is labelled subagent', () => {
    expect(parse('stop', { sessionId: SUB, transcriptPath: transcriptOf(MAIN), stopReason: 'end_turn' }))
      .toMatchObject({ kind: 'status', type: 'stop', origin: 'subagent' });
  });

  it('the main session stop is not labelled', () => {
    expect(parse('stop', { sessionId: MAIN, transcriptPath: transcriptOf(MAIN), stopReason: 'end_turn' }))
      .not.toHaveProperty('origin');
  });

  it('a stop without the two fields is left as it is (nothing proves otherwise)', () => {
    expect(parse('stop', { stopReason: 'end_turn' })).not.toHaveProperty('origin');
  });

  it('a transcriptPath without a session id fails loud instead of being read as the main session', () => {
    expect(() => parse('stop', { sessionId: SUB, transcriptPath: '/tmp/events.jsonl' })).toThrow(/no session id/);
  });

  it('prompts are never labelled (they carry no transcriptPath)', () => {
    expect(parse('start', { sessionId: SUB })).not.toHaveProperty('origin');
  });
});

// #6448:工具跑完 = 批准已了结;不可恢复的错误 = 失败边;批准框只在真出现时(notification permission_prompt)算等人。
describe('copilot wait exit, errors and the shown-prompt signal', () => {
  it('postToolUse / postToolUseFailure resolve every open wait (the payload carries no tool call id)', () => {
    const body = { sessionId: MAIN, timestamp: 1, cwd: '/w', toolName: 'bash', toolArgs: {}, toolResult: { resultType: 'success' } };
    expect(parse('wait_resolved', body)).toEqual({ kind: 'status', type: 'wait_resolved' });
  });

  it('an unrecoverable errorOccurred is an error edge carrying its message (documented object form and SDK string form)', () => {
    expect(parse('error', { sessionId: MAIN, error: { message: 'model unavailable', name: 'Error' }, errorContext: 'model_call', recoverable: false }))
      .toMatchObject({ kind: 'status', type: 'error', message: 'model_call: model unavailable' });
    expect(parse('error', { sessionId: MAIN, error: 'boom', errorContext: 'system', recoverable: false }))
      .toMatchObject({ kind: 'status', type: 'error', message: 'system: boom' });
  });

  it('a recoverable errorOccurred carries no status (copilot keeps running)', () => {
    expect(parse('error', { sessionId: MAIN, error: { message: 'retrying', name: 'Error' }, errorContext: 'model_call', recoverable: true }))
      .toEqual({ kind: 'ignore' });
  });

  it('an errorOccurred without its recoverable flag or message fails loud', () => {
    expect(() => parse('error', { sessionId: MAIN, error: 'x' })).toThrow(/recoverable/);
    expect(() => parse('error', { sessionId: MAIN, error: {}, recoverable: false })).toThrow(/error message/);
  });

  it('notification permission_prompt waits for approval; other notification types carry no status', () => {
    const note = (type: string) => ({ sessionId: MAIN, hook_event_name: 'Notification', message: 'm', notification_type: type });
    expect(parse('notification', note('permission_prompt'))).toMatchObject({ type: 'notification', notificationType: 'permission_prompt' });
    expect(parse('notification', note('shell_completed'))).toMatchObject({ type: 'notification', notificationType: undefined });
  });

  it('notification elicitation_dialog is a question wait (never swallowed by auto-approve)', () => {
    const note = { sessionId: MAIN, hook_event_name: 'Notification', message: 'm', notification_type: 'elicitation_dialog' };
    expect(parse('notification', note)).toEqual({ kind: 'status', type: 'wait', waitKind: 'question' });
  });
});

function memoryFs(files: Map<string, string>): PluginFs {
  return {
    read: async (path) => files.get(path) ?? null,
    write: async (path, content) => { files.set(path, content); },
    delete: async (path) => { files.delete(path); },
    exists: async (path) => files.has(path),
    list: async () => [],
  };
}

describe('copilot hook installation (#6448)', () => {
  const hooksOf = (files: Map<string, string>) =>
    (JSON.parse(files.get(COPILOT_HOOKS_PATH)!) as { hooks: Record<string, unknown[]> }).hooks;

  it('installs notification (permission_prompt only), postToolUse(Failure) and errorOccurred', async () => {
    const files = new Map<string, string>();
    await buildCopilotHookConfig().writeHooks(memoryFs(files), []);
    const hooks = hooksOf(files);
    expect(hooks.notification).toEqual([
      { type: 'command', command: makeStdinHookCommand('notification'), matcher: 'permission_prompt|elicitation_dialog' },
    ]);
    expect(hooks.postToolUse).toEqual([{ type: 'command', command: makeStdinHookCommand('wait_resolved') }]);
    expect(hooks.postToolUseFailure).toEqual([{ type: 'command', command: makeStdinHookCommand('wait_resolved') }]);
    expect(hooks.errorOccurred).toEqual([{ type: 'command', command: makeStdinHookCommand('error') }]);
  });

  it('retires its own permissionRequest entry (it fires before auto-allow) and keeps the user\'s', async () => {
    const userEntry = { type: 'command', command: 'audit-permission' };
    const files = new Map<string, string>([
      [COPILOT_HOOKS_PATH, JSON.stringify({
        version: 1,
        hooks: { permissionRequest: [userEntry, { type: 'command', command: makeNotificationHookCommand('permission_prompt') }] },
      })],
    ]);
    await buildCopilotHookConfig().writeHooks(memoryFs(files), []);
    expect(hooksOf(files).permissionRequest).toEqual([userEntry]);

    const onlyOurs = new Map<string, string>([
      [COPILOT_HOOKS_PATH, JSON.stringify({ version: 1, hooks: { permissionRequest: [{ type: 'command', command: makeNotificationHookCommand('permission_prompt') }] } })],
    ]);
    await buildCopilotHookConfig().writeHooks(memoryFs(onlyOurs), []);
    expect(hooksOf(onlyOurs)).not.toHaveProperty('permissionRequest');
  });

  it('the descriptor declares every edge the hooks report', () => {
    const hooks = copilot.capabilities.hooks;
    expect(hooks.kind !== 'none' && [...hooks.supportedEvents].sort()).toEqual(
      ['error', 'notification', 'session', 'start', 'stop', 'wait_resolved'],
    );
  });
});
