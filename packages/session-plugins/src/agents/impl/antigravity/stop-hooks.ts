import { spawn } from 'node:child_process';
import { readFile, realpath } from 'node:fs/promises';
import { join } from 'node:path';
import type { AcpTurnEndContext } from '@gugu/session-core/agents/plugins';
import { isGuguHookText } from '@gugu/session-core/agents/plugins/helpers';

/**
 * Antigravity 的 `Stop` 钩子 —— 由咕咕在**每一轮**结束时代跑(#6335)。
 *
 * ## 为什么要咕咕跑
 *
 * 官方文档里 `Stop` 是「agent 循环停下时」触发,返回 `{"decision":"continue","reason":…}` 就把
 * reason 当一条消息送回去、接着干(https://antigravity.google/docs/hooks)。`agy_acp_server` 1.2.1 把它
 * 接成了**会话结束**时跑一次(`ExternalOnSessionEndHook`「Enforces Stop hooks when the session ends」),
 * 且 `continue` 被显式忽略(stderr「Resuming execution (decision='continue') is not supported by the SDK
 * yet」)。SDK 自己的 stop hook 支持 CONTINUE(sdk hooks.md)—— 缺的是这个服务,不是这件事。
 *
 * ## 照它的契约跑
 *
 *  · 配置:`$GEMINI_HOME/config/hooks.json`(全局)+ 工作区 `.agents|.agent|_agents|_agent/hooks.json`。
 *    工作区的只在工作区**被信任**时跑 —— 信任名单就是它自己那份
 *    `$GEMINI_HOME/antigravity-acp/trusted_workspaces.json`(`{"trusted":[realpath…]}`),与它同一把尺子。
 *  · 形状:顶层按名字分组,组里 `enabled:false` 就跳过;`Stop` 下的条目要么自己带 `command`,
 *    要么带 `hooks:[{command,timeout}]`。
 *  · 执行:stdin 喂 JSON(`executionNum` / `terminationReason` / `fullyIdle` / `conversationId` /
 *    `workspacePaths` …,驼峰),stdout 读 JSON;`timeout` 秒,缺省 30。多条按顺序,第一条 `continue` 短路。
 */
const DOT_DIRS = ['.agents', '.agent', '_agents', '_agent'];
const DEFAULT_TIMEOUT_S = 30;

type HookCommand = { command: string; timeout?: number };

export async function runAntigravityStopHooks(ctx: AcpTurnEndContext): Promise<{ continueWith: string } | null> {
  const commands = await loadStopCommands(ctx);
  const input = JSON.stringify({
    executionNum: ctx.executionNum,
    terminationReason: 'model_stop',
    error: '',
    fullyIdle: true,
    conversationId: ctx.providerSessionId,
    workspacePaths: [ctx.cwd],
  });
  for (const hook of commands) {
    const output = await runCommand(hook, ctx.cwd, input);
    const decision = parseDecision(output);
    if (decision) return { continueWith: decision };
  }
  return null;
}

export async function loadStopCommands(
  ctx: Pick<AcpTurnEndContext, 'cwd' | 'env' | 'homeDir'>
): Promise<HookCommand[]> {
  const home = ctx.env.GEMINI_HOME?.trim() || join(ctx.homeDir, '.gemini');
  const global = await readJson(join(home, 'config', 'hooks.json'));
  let workspace: Record<string, unknown> | null = null;
  if (await workspaceTrusted(home, ctx.cwd, ctx.env)) {
    for (const dir of DOT_DIRS) {
      workspace = await readJson(join(ctx.cwd, dir, 'hooks.json'));
      if (workspace) break;
    }
  }
  // 与它的 merge_hooks_configs 同向:全局先跑,工作区同名组覆盖启用状态。
  const groups = new Map<string, Record<string, unknown>>();
  for (const config of [global, workspace]) {
    for (const [name, group] of Object.entries(config ?? {})) {
      if (!isObject(group)) continue;
      const previous = groups.get(name);
      groups.set(name, previous ? { ...previous, ...group } : group);
    }
  }
  const commands: HookCommand[] = [];
  for (const group of groups.values()) {
    if (group.enabled === false || !Array.isArray(group.Stop)) continue;
    for (const entry of group.Stop) {
      if (!isObject(entry)) continue;
      const handlers = Array.isArray(entry.hooks) ? entry.hooks : [entry];
      for (const handler of handlers) {
        // ⚠️ 咕咕自己写的条目(终端腿的回合边界,见 ./hooks.ts)**跳过**:它是给 `agy` 终端会话报状态的,
        //    由 `agy` 自己在每轮结束时跑;这里再代跑一次 = 把聊天面板会话的回合冒充成某条终端会话的。
        //    认它靠命令体里的 `GUGU_HOOK_PORT` 标记(`isGuguHookText`,与全仓剔除咕咕条目同一个判据)。
        if (isObject(handler) && typeof handler.command === 'string' && isGuguHookText(handler.command)) continue;
        if (isObject(handler) && typeof handler.command === 'string' && handler.command.trim()) {
          commands.push({
            command: handler.command,
            ...(typeof handler.timeout === 'number' ? { timeout: handler.timeout } : {}),
          });
        }
      }
    }
  }
  return commands;
}

export function parseDecision(stdout: string): string | null {
  try {
    const parsed = JSON.parse(stdout.trim()) as { decision?: unknown; reason?: unknown };
    if (parsed.decision === 'continue' && typeof parsed.reason === 'string' && parsed.reason.trim()) {
      return parsed.reason.trim();
    }
  } catch {
    // 不是 JSON = 没有决定(它的契约里 stdout 可以为空)。
  }
  return null;
}

async function workspaceTrusted(home: string, cwd: string, env: Readonly<Record<string, string>>): Promise<boolean> {
  if (/^(1|true|yes)$/i.test(env.AGY_ACP_DISABLE_WORKSPACE_TRUST ?? '')) return true;
  const trust = await readJson(join(home, 'antigravity-acp', 'trusted_workspaces.json'));
  const trusted = Array.isArray(trust?.trusted) ? trust.trusted : [];
  const canonical = await realpath(cwd).catch(() => cwd);
  return trusted.includes(canonical);
}

function runCommand(hook: HookCommand, cwd: string, input: string): Promise<string> {
  return new Promise((resolve) => {
    const child = spawn(hook.command, { cwd, shell: true, stdio: ['pipe', 'pipe', 'ignore'] });
    let stdout = '';
    const timer = setTimeout(() => child.kill('SIGKILL'), (hook.timeout ?? DEFAULT_TIMEOUT_S) * 1000);
    child.stdout.on('data', (chunk: Buffer) => { stdout += chunk.toString('utf8'); });
    child.on('error', () => { clearTimeout(timer); resolve(''); });
    child.on('close', () => { clearTimeout(timer); resolve(stdout); });
    child.stdin.on('error', () => undefined);
    child.stdin.end(input);
  });
}

async function readJson(path: string): Promise<Record<string, unknown> | null> {
  try {
    const parsed: unknown = JSON.parse(await readFile(path, 'utf8'));
    return isObject(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
