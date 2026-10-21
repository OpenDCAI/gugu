import type { CanonicalHookEvent, HookRegistration, PluginFs } from '@gugu/session-core/agents/plugins';
import {
  defaultHookEventParser,
  isGuguHookText,
  makeStdinHookCommand,
  readJsonConfig,
  writeJsonConfig,
} from '@gugu/session-core/agents/plugins/helpers';
import { ANTIGRAVITY_INVOCATION_CONTEXT_ENV } from './session-bundle';

/**
 * 咕咕托管那份 `.gemini` 里的全局 hooks 文件 —— 相对**影子 home**(这一家的 `PluginFs` 锚在那里,
 * 见 `capabilities/config-root.ts`)。官方 https://antigravity.google/docs/hooks「Managing hooks in
 * Antigravity CLI」:「**Global level**: `~/.gemini/config/hooks.json`」。
 * ⚠️ 两条腿读的是**同一份**:聊天面板腿的 `agy_acp_server` 也读它(`./stop-hooks.ts` 抬头),
 *    所以咕咕的条目必须认得出来、在那边被跳过(`isGuguHookText`)。
 */
export const ANTIGRAVITY_HOOKS_PATH = '.gemini/config/hooks.json';

/**
 * 咕咕那一组的名字。hooks.json 顶层按**名字**分组(同一页「The `hooks.json` file maps hook names to their
 * event configurations」),咕咕整组拥有它、每次整组重写;用户的组一个都不碰。
 * ⚠️ 名字带前缀而不是裸 `gugu`:用户自己的组叫什么咕咕管不着,撞名就会被整组顶掉。
 */
export const ANTIGRAVITY_GUGU_HOOK_GROUP = 'gugu-task-status';

/**
 * 把一行 shell 脚本包成 `/bin/sh -c '<脚本>'`。
 *
 * 两条腿读同一份 hooks.json,却用两种方式执行 `command`(实测,2026-09-24):
 *  · 终端腿 `agy` 1.2.9 交给 shell 跑 —— 裸脚本 `if [ … ]; then …` 能跑;
 *  · 聊天面板腿 `agy_acp_server` 走 `asyncio.create_subprocess_exec`(hooks.py:48),把命令**按词拆开直接 exec**,
 *    裸脚本的第一个词 `if` 被当成可执行文件 → `FileNotFoundError: 'if'`,每一回合在 stderr 打一段 traceback
 *    加「External hook 'gugu-task-status' failed to execute」。
 * 包一层之后两边都是「exec /bin/sh,脚本是它的一个参数」,实测都干净:ACP 两回合 end_turn、零 traceback;
 * 终端腿 PreInvocation×2 / Stop×1 照常打到咕咕的钩子服务。脚本里的 `GUGU_HOOK_PORT` 仍在命令文本里,
 * `isGuguHookText` 照样认得出。
 */
export function execSafeHookCommand(script: string): string {
  return `/bin/sh -c '${script.replace(/'/g, `'\\''`)}'`;
}

/**
 * 两个事件,各管一件事(事件表出处同上页「Supported Events」,只有 PreToolUse / PostToolUse /
 * PreInvocation / PostInvocation / Stop 五个 —— **没有** SessionStart / UserPromptSubmit):
 *
 *  · `PreInvocation` → `session`:每次调模型之前触发,stdin 带 `conversationId`(`agy` 自己分配的原生
 *    会话 id,调用方指定不了)。咕咕拿它记下这条终端会话的原生 id,重开时 `--conversation <id>` 续上。
 *    选它而不是只靠 `Stop`:进程若在第一轮中途被杀,`Stop` 从没触发过,而 PreInvocation 在那一轮一开头
 *    就报过了 —— 续跑不会丢掉那半轮。
 *  · `Stop` → `stop`:执行循环结束时触发 = 回合边界(实测 agy 1.2.9 交互终端里一轮一次,
 *    `terminationReason:"NO_TOOL_CALL"`、`fullyIdle:true`,见 session-bundle 抬头的读数)。
 *
 * ❌ 不挂 `PostInvocation`/`PostToolUse` 当「开始」:一轮里会触发很多次,而「开始」由宿主在注入输入时
 *    自己发(`session:input-submitted`),不必另造一个边。
 */
/**
 * PreInvocation 在报完 `session` 之后,把这次 spawn 的会话提示块原样打到 stdout —— 那份文件本身就是
 * 官方输出契约 `{"injectSteps":[{"ephemeralMessage":…}]}`(物化器写,路径经 env 递,见 session-bundle 的
 * `ANTIGRAVITY_INVOCATION_CONTEXT_ENV`)。env 没设(聊天面板腿、没有提示块的会话)⇒ 什么都不打,
 * 空 stdout 不卡回合(实测)。
 */
const PRE_INVOCATION_CONTEXT =
  `; if [ -n "$${ANTIGRAVITY_INVOCATION_CONTEXT_ENV}" ] && [ -r "$${ANTIGRAVITY_INVOCATION_CONTEXT_ENV}" ]; `
  + `then cat "$${ANTIGRAVITY_INVOCATION_CONTEXT_ENV}"; fi`;

const ANTIGRAVITY_HOOK_SPECS = [
  {
    event: 'PreInvocation',
    command: execSafeHookCommand(`${makeStdinHookCommand('session')}${PRE_INVOCATION_CONTEXT}`),
  },
  { event: 'Stop', command: execSafeHookCommand(makeStdinHookCommand('stop')) },
] as const;

function guguGroup(): Record<string, unknown> {
  return Object.fromEntries(
    ANTIGRAVITY_HOOK_SPECS.map(({ event, command }) => [event, [{ type: 'command', command }]])
  );
}

function isGuguGroup(group: unknown): boolean {
  return isGuguHookText(JSON.stringify(group ?? null));
}

/**
 * `session` 事件的原生 id 在 `conversationId` 里(驼峰,官方「Common Input Fields」表)——
 * 通用解析器只认 `session_id` / `sessionId` 那几种写法,读不到它。其余事件照通用解析。
 */
function parseAntigravityHookEvent(eventType: string, body: Record<string, unknown>): CanonicalHookEvent {
  if (eventType === 'session') {
    const id = typeof body.conversationId === 'string' ? body.conversationId.trim() : '';
    return id ? { kind: 'session', providerSessionId: id } : { kind: 'ignore' };
  }
  return defaultHookEventParser(eventType, body);
}

/**
 * 写入器 —— `hooks.scope = 'agent-home'`:宿主在起终端腿之前经 `ensureHooksInstalled` 调它,`fs` 锚在
 * 咕咕的影子 home(解析回用户真 HOME 会被宿主响亮拒绝,见 `hook-config-service.ts`)。
 *
 * key 级合并:只重写咕咕那一组,用户的组逐字保留(`readJsonConfig(…,'user')` 读不动就抛,
 * ❌ 不把一份读不懂的用户文件当成空的再覆盖掉)。
 */
export function buildAntigravityHookConfig() {
  return {
    parseHookEvent: parseAntigravityHookEvent,
    async readHooks(fs: PluginFs): Promise<HookRegistration[]> {
      const config = await readJsonConfig(fs, ANTIGRAVITY_HOOKS_PATH, 'user');
      return isGuguGroup(config[ANTIGRAVITY_GUGU_HOOK_GROUP])
        ? ANTIGRAVITY_HOOK_SPECS.map(({ event, command }) => ({ event, command }))
        : [];
    },
    async writeHooks(fs: PluginFs): Promise<string[]> {
      const config = await readJsonConfig(fs, ANTIGRAVITY_HOOKS_PATH, 'user');
      const existing = config[ANTIGRAVITY_GUGU_HOOK_GROUP];
      if (existing !== undefined && !isGuguGroup(existing)) {
        // 同名的组不是咕咕写的 ⇒ 那是用户的东西,❌ 不顶掉;响亮说出来让人改名。
        throw new Error(
          `Antigravity hooks group '${ANTIGRAVITY_GUGU_HOOK_GROUP}' in ${ANTIGRAVITY_HOOKS_PATH} is not Gugu-owned; rename it`
        );
      }
      await writeJsonConfig(fs, ANTIGRAVITY_HOOKS_PATH, { ...config, [ANTIGRAVITY_GUGU_HOOK_GROUP]: guguGroup() }, 'user');
      return [ANTIGRAVITY_HOOKS_PATH];
    },
    async deleteHooks(fs: PluginFs): Promise<void> {
      const config = await readJsonConfig(fs, ANTIGRAVITY_HOOKS_PATH, 'user');
      if (!isGuguGroup(config[ANTIGRAVITY_GUGU_HOOK_GROUP])) return;
      const { [ANTIGRAVITY_GUGU_HOOK_GROUP]: _removed, ...rest } = config;
      await writeJsonConfig(fs, ANTIGRAVITY_HOOKS_PATH, rest, 'user');
    },
    async getHooksInstalled(fs: PluginFs): Promise<boolean> {
      const config = await readJsonConfig(fs, ANTIGRAVITY_HOOKS_PATH, 'user');
      return isGuguGroup(config[ANTIGRAVITY_GUGU_HOOK_GROUP]);
    },
  };
}
