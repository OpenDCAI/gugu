import type { CanonicalHookEvent, HookWaitKind } from '@gugu/session-core/agents/plugins';
import {
  buildNestedJsonHookConfig,
  defaultHookEventParser,
  makeStdinHookCommand,
  type HookSpec,
} from '@gugu/session-core/agents/plugins/helpers';
import { claudePresenceFile } from './presence';

export const CLAUDE_SETTINGS_PATH = '.claude/settings.local.json';

/** 停下来等人回答的工具。它们的对话框也报 `permission_prompt`,只有工具名分得开批准与问题。 */
const QUESTION_TOOL_WAIT_KINDS: Readonly<Record<string, HookWaitKind>> = {
  AskUserQuestion: 'question',
  ExitPlanMode: 'plan',
};
const QUESTION_TOOL_MATCHER = Object.keys(QUESTION_TOOL_WAIT_KINDS).join('|');

function requireString(body: Record<string, unknown>, field: string, hook: string): string {
  const value = body[field];
  if (typeof value !== 'string' || !value) throw new Error(`claude ${hook} hook carries no ${field}`);
  return value;
}

/**
 * 等人的两条入口(spec hook-status-derivation「等人的入口与出口」):
 *  - `PreToolUse`(matcher 只含问题工具)→ 问题 / 计划,`waitId` = `tool_use_id`;带 `agent_id` 的不是主线程在问,忽略(见下)。
 *  - `PermissionRequest` → 批准。它不带 `tool_use_id`;对问题工具它可能在作答之后才到,所以忽略。
 *
 * #6941 带 `agent_id` 的问题工具 PreToolUse 只来自回合结束的 fork(提示建议、away summary……,2.1.289):fork 沿用父会话的
 * 工具、`session_id` 也是父会话的,到 canUseTool 才拒 —— PreToolUse 先到,之后再没有 PostToolUse,等待永远关不上。
 * Agent 工具的子代理与 teammate 拿不到 AskUserQuestion(子代理工具过滤把它摘掉);plan 模式子代理的 ExitPlanMode
 * 有它自己的批准框,经 `permission_prompt` 通知亮「需要你」。
 */
function parseClaudeWait(body: Record<string, unknown>): CanonicalHookEvent {
  const hook = requireString(body, 'hook_event_name', 'wait');
  const toolName = requireString(body, 'tool_name', hook);
  const questionKind = QUESTION_TOOL_WAIT_KINDS[toolName];
  if (hook === 'PreToolUse') {
    if (!questionKind) throw new Error(`claude PreToolUse hook fired for ${toolName}, outside its matcher`);
    if (typeof body.agent_id === 'string' && body.agent_id) return { kind: 'ignore' };
    return { kind: 'status', type: 'wait', waitKind: questionKind, waitId: requireString(body, 'tool_use_id', hook) };
  }
  if (hook === 'PermissionRequest') {
    if (questionKind) return { kind: 'ignore' };
    const waitId = typeof body.tool_use_id === 'string' && body.tool_use_id ? body.tool_use_id : undefined;
    return { kind: 'status', type: 'wait', waitKind: 'approval', ...(waitId ? { waitId } : {}) };
  }
  throw new Error(`claude wait hook arrived as ${hook}`);
}

/**
 * 工具跑完 = 为它停着的等待了结。问题工具按 `tool_use_id` 精确了结;批准没有 id,工具又在跑就了结全部。
 */
function parseToolCompletion(body: Record<string, unknown>): CanonicalHookEvent {
  const hook = requireString(body, 'hook_event_name', 'wait_resolved');
  if (hook !== 'PostToolUse' && hook !== 'PostToolUseFailure') {
    throw new Error(`claude wait_resolved hook arrived as ${hook}`);
  }
  const toolName = requireString(body, 'tool_name', hook);
  if (!QUESTION_TOOL_WAIT_KINDS[toolName]) return { kind: 'status', type: 'wait_resolved' };
  return { kind: 'status', type: 'wait_resolved', waitId: requireString(body, 'tool_use_id', hook) };
}

/**
 * Stop 带两份快照:`background_tasks`(结束时仍在跑的后台任务)与 `session_crons`(`/loop`、cron 等定时唤醒)。
 * `monitor` 算定时唤醒,`teammate` 是别人的活、不算;其余都是在干活的后台。字段缺席(旧版 Claude)= 这一部分不报。
 */
const NOT_WORKING_BACKGROUND_TYPES = new Set(['monitor', 'teammate']);

function readStopSelfDrivenWork(body: Record<string, unknown>): { backgroundTasks?: number; scheduledTasks?: number } {
  const tasks = body.background_tasks;
  const crons = body.session_crons;
  if (tasks !== undefined && !Array.isArray(tasks)) throw new Error('claude Stop hook background_tasks is not an array');
  if (crons !== undefined && !Array.isArray(crons)) throw new Error('claude Stop hook session_crons is not an array');
  const types = tasks?.map((task) => {
    const type = (task as { type?: unknown } | null)?.type;
    if (typeof type !== 'string') throw new Error('claude Stop hook background task carries no type');
    return type;
  });
  return {
    ...(types ? { backgroundTasks: types.filter((type) => !NOT_WORKING_BACKGROUND_TYPES.has(type)).length } : {}),
    ...(types || crons
      ? { scheduledTasks: (types?.filter((type) => type === 'monitor').length ?? 0) + (crons?.length ?? 0) }
      : {}),
  };
}

/** `StopFailure` 代替 Stop 到达:失败类别与细节进 `message`,成为 error 的原因。 */
function parseStopFailure(body: Record<string, unknown>): CanonicalHookEvent {
  const error = requireString(body, 'error', 'StopFailure');
  const details = typeof body.error_details === 'string' && body.error_details ? body.error_details : undefined;
  const lam = body.last_assistant_message;
  return {
    kind: 'status',
    type: 'error',
    message: details ? `${error}: ${details}` : error,
    lastAssistantMessage: typeof lam === 'string' ? lam : undefined,
  };
}

/**
 * Claude Code's Notification hook carries a structured `notification_type` (verified in the
 * shipped 2.1.267 / 2.1.280 binaries). Only two of its values mean anything to the four-state
 * activity axis (spec hook-status-derivation):
 *   permission_prompt / worker_permission_prompt → permission_prompt (waits for an approval click)
 *   idle_prompt                                    → idle_prompt       (it is idle; the turn end is Stop)
 * Every other type (elicitation_*, agent_needs_input, computer_use_*, push_notification, …) is an
 * in-turn event and carries no status — ❌ guessing from the message text, which used to fold all of
 * them into idle_prompt and flip a running turn to idle.
 */
function parseClaudeHookEvent(
  eventType: string,
  body: Record<string, unknown>
): CanonicalHookEvent {
  if (eventType === 'notification') {
    const type = body.notification_type;
    if (typeof type !== 'string') {
      throw new Error('claude Notification hook carries no notification_type');
    }
    const notificationType =
      type === 'permission_prompt' || type === 'worker_permission_prompt'
        ? ('permission_prompt' as const)
        : type === 'idle_prompt'
          ? ('idle_prompt' as const)
          : null;
    if (!notificationType) return { kind: 'ignore' };
    return {
      kind: 'status',
      type: 'notification',
      notificationType,
      message: typeof body.message === 'string' ? body.message : undefined,
      title: typeof body.title === 'string' ? body.title : undefined,
    };
  }
  if (eventType === 'wait') return parseClaudeWait(body);
  if (eventType === 'wait_resolved') return parseToolCompletion(body);
  if (eventType === 'error') {
    const failure = parseStopFailure(body);
    // #6264 StopFailure 的 `error` 是结构化的错误类型(code.claude.com/docs/en/hooks#stopfailure-input);
    // `authentication_failed` = 这份 Claude 登录真用时被拒了 ⇒ 宿主标「登录已失效」。❌ 看 last_assistant_message 的原文猜。
    return failure.kind === 'status' && body.error === 'authentication_failed' ? { ...failure, signInRequired: true } : failure;
  }
  if (eventType === 'stop') {
    const event = defaultHookEventParser(eventType, body);
    return event.kind === 'status' ? { ...event, ...readStopSelfDrivenWork(body) } : event;
  }

  return defaultHookEventParser(eventType, body);
}

/** 咕咕给 Claude 装的全部 hook 条目。 */
export function claudeHookSpecs(): HookSpec[] {
  return [
    { hookKey: 'UserPromptSubmit', command: makeStdinHookCommand('start') },
    { hookKey: 'Notification', command: makeStdinHookCommand('notification') },
    { hookKey: 'Stop', command: makeStdinHookCommand('stop') },
    // 回合因 API 错误结束时 Claude 不发 Stop、发 StopFailure。少了它,失败的回合停在 working,
    // 一分钟后被闲置提醒改成 idle —— 看起来一切正常(spec hook-status-derivation)。
    // StopFailure 从 2.1.78 起才有(npm 逐版读 cli.js:2.1.77 无、2.1.78 有);2.1.77 见到这个未知键
    // 会**丢掉整份 hooks**(实测 SessionStart 标记不写),所以按版本声明,不抬地板。
    { hookKey: 'StopFailure', command: makeStdinHookCommand('error'), sinceVersion: '2.1.78' },
    // 等人的入口与出口。四个键与 `matcher` / `async` 在地板版本 2.1.69 就有。
    { hookKey: 'PermissionRequest', command: makeStdinHookCommand('wait') },
    { hookKey: 'PreToolUse', command: makeStdinHookCommand('wait'), matcher: QUESTION_TOOL_MATCHER },
    // 每个工具之后都跑,所以 `async`:只陈述事实,不挡工具。
    { hookKey: 'PostToolUse', command: makeStdinHookCommand('wait_resolved'), async: true },
    { hookKey: 'PostToolUseFailure', command: makeStdinHookCommand('wait_resolved'), async: true },
  ];
}

export function buildClaudeHookConfig() {
  return {
    ...buildNestedJsonHookConfig(CLAUDE_SETTINGS_PATH, claudeHookSpecs(), 'user'),
    parseHookEvent: parseClaudeHookEvent,
    presence: claudePresenceFile,
  };
}
