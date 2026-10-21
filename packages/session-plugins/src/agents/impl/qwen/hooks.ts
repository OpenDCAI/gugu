import type { CanonicalHookEvent, HookWaitKind } from '@gugu/session-core/agents/plugins';
import { defaultHookEventParser, makeStdinHookCommand } from '@gugu/session-core/agents/plugins/helpers';

/** 停下来等人回答的工具。它们与批准走同一条确认路,靠 `PermissionRequest` 的 `tool_name` 分开;yolo 下照样要人答。 */
const QUESTION_TOOL_WAIT_KINDS: Readonly<Record<string, HookWaitKind>> = {
  ask_user_question: 'question',
  exit_plan_mode: 'plan',
};

function requireString(body: Record<string, unknown>, field: string, hook: string): string {
  const value = body[field];
  if (typeof value !== 'string' || !value) throw new Error(`qwen ${hook} hook carries no ${field}`);
  return value;
}

/**
 * `PermissionRequest` 只在真要确认时发,没有工具调用 id。了结靠下一次调模型前的 `UserPromptSubmit`
 * (同一轮里再来一次开始 = 等待已了结)。旧安装把它作为 `notification` 发来,同样翻。
 */
function parseQwenPermissionRequest(body: Record<string, unknown>): CanonicalHookEvent {
  const toolName = requireString(body, 'tool_name', 'PermissionRequest');
  return { kind: 'status', type: 'wait', waitKind: QUESTION_TOOL_WAIT_KINDS[toolName] ?? 'approval' };
}

/**
 * Stop 的 `background_tasks` 只列后台子代理且各种状态都在,只数 `running`(后台 shell 不在表里);
 * `crons` 是定时唤醒。字段缺席(旧版 qwen)= 不报,不当 0。
 */
function readStopSelfDrivenWork(body: Record<string, unknown>): { backgroundTasks?: number; scheduledTasks?: number } {
  const tasks = body.background_tasks;
  const crons = body.crons;
  if (tasks !== undefined && !Array.isArray(tasks)) throw new Error('qwen Stop hook background_tasks is not an array');
  if (crons !== undefined && !Array.isArray(crons)) throw new Error('qwen Stop hook crons is not an array');
  const running = tasks?.filter((task) => {
    const status = (task as { status?: unknown } | null)?.status;
    if (typeof status !== 'string') throw new Error('qwen Stop hook background task carries no status');
    return status === 'running';
  });
  return {
    ...(running ? { backgroundTasks: running.length } : {}),
    ...(crons ? { scheduledTasks: crons.length } : {}),
  };
}

/** `stop` 来自 `Stop` 与 `SessionEnd`。会话结束不是「这一轮做完了」,所以 SessionEnd 是被打断的结束。 */
function parseQwenStop(body: Record<string, unknown>): CanonicalHookEvent {
  const hook = requireString(body, 'hook_event_name', 'stop');
  const event = defaultHookEventParser('stop', body);
  if (event.kind !== 'status') return event;
  if (hook === 'Stop') return { ...event, ...readStopSelfDrivenWork(body) };
  if (hook === 'SessionEnd') return { ...event, outcome: 'cancelled' };
  throw new Error(`qwen stop hook arrived as ${hook}`);
}

/** `StopFailure` 代替 Stop 到达(API 错误、循环检测):失败类别与细节进 `message`。 */
function parseQwenStopFailure(body: Record<string, unknown>): CanonicalHookEvent {
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

function parseQwenHookEvent(eventType: string, body: Record<string, unknown>): CanonicalHookEvent {
  if (eventType === 'wait' || (eventType === 'notification' && body.hook_event_name === 'PermissionRequest')) {
    return parseQwenPermissionRequest(body);
  }
  if (eventType === 'stop') return parseQwenStop(body);
  if (eventType === 'error') return parseQwenStopFailure(body);
  return defaultHookEventParser(eventType, body);
}

/** 咕咕给 qwen 装的全部 hook 条目 —— 只由会话级 settings 副本(`session-bundle.ts`)交付。 */
export function qwenHookSpecs() {
  return [
    { hookKey: 'SessionStart', command: makeStdinHookCommand('session') },
    // 回合的**起始边**。没有它,派生永远看不到 working:`SessionStart` 是会话级的一次性事件,
    // 只有 `UserPromptSubmit` 是「这一轮开始了」。缺这条时该 agent 的状态点只能亮到投递命令
    // 返回为止(实测 17s,而回合真长 137s),其余时间显示空闲 —— #5438 / owner 2026-09-11。
    // 键名取自装机自带的 docs/features/hooks.md 事件表:「UserPromptSubmit —— Before supported
    // model invocations」。❌ 不凭记忆写键名:harness 忽略未知键,装了个不会触发的钩子比没装更坏
    // (代码看起来修好了)。
    { hookKey: 'UserPromptSubmit', command: makeStdinHookCommand('start') },
    // 等人:按 `tool_name` 分批准 / 问题 / 计划(见 parseQwenPermissionRequest)。
    { hookKey: 'PermissionRequest', command: makeStdinHookCommand('wait') },
    // 回合被用户 Esc 取消时 qwen **不发 `Stop`**,只在取消那一刻发 `Notification{notification_type:'idle_prompt'}`
    // (mac1 实测 2/2,与 Esc 相差 <10ms;正常回合则是 `Stop` 之后约 25ms 再发一条)。不装这一键,取消的回合就
    // 永远停在 working —— 派生本就把 `idle_prompt` 当「还标着 working 的会话回到 idle」(#6421)。
    // qwen 的 hook 没有 matcher 过滤类型:别的类型(`permission_prompt` 与 PermissionRequest 同一事实、
    // `auth_success` 不携带状态)经默认解析各归其位。
    { hookKey: 'Notification', command: makeStdinHookCommand('notification') },
    { hookKey: 'Stop', command: makeStdinHookCommand('stop') },
    // 回合失败时 qwen 不发 Stop、发 StopFailure;0.19.6 起的发行包都认识这个键,不需要版本门。
    { hookKey: 'StopFailure', command: makeStdinHookCommand('error') },
    { hookKey: 'SessionEnd', command: makeStdinHookCommand('stop') },
  ];
}

/**
 * qwen 的 hook 行为只剩**解析**:条目由终端腿的会话级 settings 副本交付(`session-bundle.ts`,
 * descriptor `hooks.scope = 'session'`),❌ 不挂任何往用户 `~/.qwen/settings.json` 写的写入器(#6195)。
 */
export function buildQwenHookConfig() {
  return { parseHookEvent: parseQwenHookEvent };
}
