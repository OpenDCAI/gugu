// Verbatim source of the Pi gugu extension, embedded as a string constant.
export const GUGU_PI_SYSTEM_PROMPT_ENV = 'GUGU_PI_SYSTEM_PROMPT';
export const GUGU_PI_MCP_SERVERS_ENV = 'GUGU_PI_MCP_SERVERS';
/**
 * 这一轮的权限档 —— 只有两个合法值,与 `SessionAutonomyCapability.mode` 同名。
 *
 * ⚠️ 缺席**不是**第三档,它是「这条腿没有声明自治」(终端腿今天就是),此时事件模块一个门都不加,
 *    行为与加这一维之前逐字一致。给一个**不认识**的值必须响亮失败:静默当成不设防,正是
 *    「界面说要问我、实际满权限跑」那种最坏的错法。
 */
export const GUGU_PI_AUTONOMY_ENV = 'GUGU_PI_AUTONOMY';

export const PI_EXTENSION_CONTENT = `\
import type { ExtensionAPI, McpServerConfig } from '@earendil-works/pi-coding-agent';

type PiMcpRuntimeServer = { name: string } & McpServerConfig;

function readMcpServers(): PiMcpRuntimeServer[] {
  const raw = process.env.${GUGU_PI_MCP_SERVERS_ENV};
  if (!raw) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error(
      'Gugu Pi MCP runtime declaration is invalid JSON: '
      + (error instanceof Error ? error.message : String(error)),
    );
  }
  if (!Array.isArray(parsed)) throw new Error('Gugu Pi MCP runtime declaration must be an array');
  return parsed as PiMcpRuntimeServer[];
}

async function notifyGugu(
  eventType: 'start' | 'stop' | 'error' | 'notification' | 'session' | 'wait' | 'wait_resolved',
  body: Record<string, unknown> = {}
) {
  const port = process.env.GUGU_HOOK_PORT;
  const token = process.env.GUGU_HOOK_TOKEN;
  const ptyId = process.env.GUGU_PTY_ID;

  if (!port || !token || !ptyId) return;

  try {
    await fetch(\`http://127.0.0.1:\${port}/hook\`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Gugu-Token': token,
        'X-Gugu-Pty-Id': ptyId,
        'X-Gugu-Event-Type': eventType,
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(2000),
    });
  } catch {
    // Gugu may not be running when pi is launched directly; ignore hook failures.
  }
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === 'string') return error;
  return 'Pi exited with an error';
}

type RunOutcome = { kind: 'completed' } | { kind: 'aborted' } | { kind: 'error'; message: string };

// 平台 AbortError 的固定消息(DOMException 与 Node 的 AbortError 同一句)。它是错误**类别**的常量,不是模型写的正文。
const ABORT_ERROR_MESSAGE = 'This operation was aborted';

// 一次运行怎么结束的:看这次运行最后一条助手消息的 stopReason('error' / 'aborted' / 其余 = 正常)。
// 工具跑着时按 Esc,pi 记成 stopReason 'error' + 平台 AbortError 的固定消息:这一种是打断,不是失败。
function outcomeOfRun(messages: readonly unknown[]): RunOutcome {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const message = messages[i] as { role?: unknown; stopReason?: unknown; errorMessage?: unknown } | null;
    if (message?.role !== 'assistant') continue;
    if (message.stopReason === 'error' && message.errorMessage === ABORT_ERROR_MESSAGE) return { kind: 'aborted' };
    if (message.stopReason === 'error') {
      const text = typeof message.errorMessage === 'string' && message.errorMessage ? message.errorMessage : 'Pi run failed';
      return { kind: 'error', message: text };
    }
    if (message.stopReason === 'aborted') return { kind: 'aborted' };
    return { kind: 'completed' };
  }
  return { kind: 'completed' };
}

// ctx.ui 提示的种类 → 咕咕「需要你」的原因:confirm 是一次是/否的放行,select / input / editor 要一个答案,
// custom 是扩展自己画的对话框。
function waitKindOfPrompt(kind: unknown): 'approval' | 'question' | 'dialog' {
  if (kind === 'confirm') return 'approval';
  if (kind === 'select' || kind === 'input' || kind === 'editor') return 'question';
  return 'dialog';
}

export default function (pi: ExtensionAPI) {
  for (const { name, ...config } of readMcpServers()) pi.registerMcpServer(name, config);
  let runOutcome: RunOutcome = { kind: 'completed' };
  let promptSeq = 0;
  const openPrompts: string[] = [];

  // 权限档 —— pi 引擎本身没有审批档位(官方 security 文档:不带沙箱,内建工具以进程权限直接执行),
  // 所以「改文件前问我」这一档只能由扩展在工具边界自己建起来:tool_call 允许在工具执行**之前**
  // 返回 { block: true } 拦下这次调用,而 ctx.ui.confirm 在 rpc 模式下由 pi-acp 桥成一条真正的
  // ACP session/request_permission(带 allow_once / reject_once),正好落进咕咕既有的权限往返。
  // ⚠️ ❌ 别改成读 pi 自己的 mode:pi-acp 的 session/set_mode 报的是**思考强度**,不是权限档。
  const autonomy = process.env.${GUGU_PI_AUTONOMY_ENV};
  if (autonomy !== undefined && autonomy !== 'approval-required' && autonomy !== 'full-access') {
    throw new Error(
      'Gugu Pi autonomy declaration is invalid: expected approval-required or full-access, got ' + autonomy,
    );
  }

  if (autonomy === 'approval-required') {
    pi.on('tool_call', async (event, ctx) => {
      const allowed = await ctx.ui.confirm('Gugu', 'Allow ' + event.toolName + '?');
      if (!allowed) return { block: true, reason: 'Denied by the Gugu permission mode for this session' };
    });
  }

  pi.on('before_agent_start', (event) => {
    const guguPrompt = process.env.GUGU_PI_SYSTEM_PROMPT;
    if (!guguPrompt) return;
    return { systemPrompt: event.systemPrompt + '\\n\\n' + guguPrompt };
  });

  pi.on('session_start', async (_event, ctx) => {
    const sessionFile = ctx.sessionManager.getSessionFile();
    if (!sessionFile) return;
    await notifyGugu('session', { providerSessionId: sessionFile });
  });

  // 回合的**起始边**(spec hook-status-derivation:「能报结束就必须能报开始」)。
  // 键名逐字取自 pi 自己的事件清单 —— @earendil-works/pi-coding-agent@0.85.1 docs/extensions.md
  // 「\`agent_start\` fires when a low-level agent run begins」;❌ 不是 \`turn_start\`(那一族在同一条 run 里
  // 按 LLM 调用反复触发),❌ 不是 \`before_agent_start\`(那是上面那条改写钩子)。理由见宿主侧描述符注释。
  pi.on('agent_start', async () => {
    runOutcome = { kind: 'completed' };
    await notifyGugu('start');
  });

  // 结算时报最后一次运行怎么结束的:自动重试成功照样是做完。
  pi.on('agent_end', (event) => {
    runOutcome = outcomeOfRun(event.messages);
  });

  // Pi docs/extensions.md: agent_end ends a low-level run, but auto-retry, compaction
  // recovery, or queued follow-ups may still continue. agent_settled is the status
  // integration boundary: Pi will not continue automatically, so Gugu can report idle.
  // 失败报 error,被打断报 stop + cancelled。
  pi.on('agent_settled', async () => {
    const outcome = runOutcome;
    runOutcome = { kind: 'completed' };
    if (outcome.kind === 'error') await notifyGugu('error', { message: outcome.message });
    else if (outcome.kind === 'aborted') await notifyGugu('stop', { message: 'Task cancelled', outcome: 'cancelled' });
    else await notifyGugu('stop', { message: 'Task completed' });
  });

  // pi 0.84.4 起报 ctx.ui 提示的起止。一对一个 waitId,嵌套时后开的先关。
  pi.on('ui_prompt_start', async (event) => {
    promptSeq += 1;
    const waitId = 'ui-' + promptSeq;
    openPrompts.push(waitId);
    await notifyGugu('wait', { waitKind: waitKindOfPrompt(event.kind), waitId, title: event.title });
  });

  pi.on('ui_prompt_end', async () => {
    const waitId = openPrompts.pop();
    if (!waitId) return;
    await notifyGugu('wait_resolved', { waitId });
  });

  // 退出时回合还开着就是被退出打断的。
  pi.on('session_shutdown', async (event) => {
    if (event.reason !== 'quit') return;
    await notifyGugu('stop', { message: 'Session ended', outcome: 'cancelled' });
  });

  process.once('uncaughtException', (error) => {
    void notifyGugu('error', { message: errorMessage(error) });
  });

  process.once('unhandledRejection', (reason) => {
    void notifyGugu('error', { message: errorMessage(reason) });
  });
}
`;
