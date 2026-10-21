import type { CanonicalHookEvent } from '@gugu/session-core/agents/plugins';
import {
  buildNestedJsonHookConfig,
  defaultHookEventParser,
  makeStdinHookCommand,
} from '@gugu/session-core/agents/plugins/helpers';

/**
 * 工作区本地设置 —— CodeBuddy 的 `PROJECT_LOCAL` 那一层(`dist/codebuddy.js` 里
 * `Added "…" to excluded commands in .codebuddy/settings.local.json`),与 Claude 的
 * `.claude/settings.local.json` 同形:用户的主配置 `~/.codebuddy/settings.json` 一个字不碰。
 */
export const CODEBUDDY_SETTINGS_PATH = '.codebuddy/settings.local.json';

function parseCodebuddyHookEvent(eventType: string, body: Record<string, unknown>): CanonicalHookEvent {
  if (eventType === 'notification' && body.hook_event_name === 'PermissionRequest') {
    return {
      kind: 'status',
      type: 'notification',
      notificationType: 'permission_prompt',
      title: 'Permission Required',
      message:
        typeof body.message === 'string'
          ? body.message
          : typeof body.tool_name === 'string'
            ? `CodeBuddy Code is requesting permission to use ${body.tool_name}.`
            : undefined,
    };
  }
  return defaultHookEventParser(eventType, body);
}

/**
 * 事件名与 payload 都是 Claude 同形(官方 https://www.codebuddy.ai/docs/cli/hooks 的 14 种事件)。
 * ACP 模式下实测触发了 SessionStart / UserPromptSubmit / PreToolUse / PermissionRequest /
 * PostToolUse / Notification / Stop,payload 带 `hook_event_name`、`session_id`、`transcript_path`、
 * `tool_name`(gugu-base notes/2026-10-19-codebuddy-harness 实测读数 out/、out3/ 的 hooks.log)。
 */
export function buildCodebuddyHookConfig() {
  return {
    ...buildNestedJsonHookConfig(
      CODEBUDDY_SETTINGS_PATH,
      [
        { hookKey: 'SessionStart', command: makeStdinHookCommand('session') },
        { hookKey: 'UserPromptSubmit', command: makeStdinHookCommand('start') },
        { hookKey: 'PreToolUse', command: makeStdinHookCommand('start') },
        { hookKey: 'PostToolUse', command: makeStdinHookCommand('tool-use') },
        { hookKey: 'PostToolUseFailure', command: makeStdinHookCommand('error') },
        { hookKey: 'PermissionRequest', command: makeStdinHookCommand('notification') },
        { hookKey: 'Notification', command: makeStdinHookCommand('notification') },
        { hookKey: 'Stop', command: makeStdinHookCommand('stop') },
        { hookKey: 'SessionEnd', command: makeStdinHookCommand('stop') },
        { hookKey: 'StopFailure', command: makeStdinHookCommand('error') },
      ],
      'user'
    ),
    parseHookEvent: parseCodebuddyHookEvent,
  };
}
