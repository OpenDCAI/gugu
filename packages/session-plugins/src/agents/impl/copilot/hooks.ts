import type { CanonicalHookEvent, PluginFs } from '@gugu/session-core/agents/plugins';
import type { HookRegistration } from '@gugu/session-core/agents/plugins';
import {
  GUGU_HOOK_MARKER,
  buildFlatEntry,
  defaultHookEventParser,
  filterUserHooks,
  removeLegacyGuguFiles,
  makeStdinHookCommand,
  readJsonConfig,
  stripManagedJsonHooks,
  writeJsonConfig,
} from '@gugu/session-core/agents/plugins/helpers';

export const COPILOT_HOOKS_PATH = '.github/hooks/gugu.json';
/** 改名前的路径,见 `removeLegacyGuguFiles`。 */
const LEGACY_COPILOT_HOOKS_PATH = '.github/hooks/emdash.json';

type CopilotHookSpec = { hookKey: string; command: string; matcher?: string };

/** 咕咕托管的全部条目;键名取自 copilot 自带 `schemas/api.schema.json` 的 HookType enum。 */
function copilotHookSpecs(): CopilotHookSpec[] {
  return [
    { hookKey: 'agentStop', command: makeStdinHookCommand('stop') },
    // 回合的**起始边**。缺它时派生永远看不到 working,状态点只能亮到投递命令返回为止。
    // ⚠️ 键名是 `userPromptSubmitted`(过去式)—— enum 里**没有** `userPromptSubmit`。
    { hookKey: 'userPromptSubmitted', command: makeStdinHookCommand('start') },
    { hookKey: 'sessionStart', command: makeStdinHookCommand('session') },
    // 对话框真的出现时才发;`matcher` 按 `notification_type` 过滤:批准框与问人要答案的对话框。
    { hookKey: 'notification', command: makeStdinHookCommand('notification'), matcher: 'permission_prompt|elicitation_dialog' },
    // 工具跑完 = 为它停着的等待了结;没有工具调用 id,了结全部。
    { hookKey: 'postToolUse', command: makeStdinHookCommand('wait_resolved') },
    { hookKey: 'postToolUseFailure', command: makeStdinHookCommand('wait_resolved') },
    // 只有 `recoverable: false` 是失败边,见 parseCopilotError。
    { hookKey: 'errorOccurred', command: makeStdinHookCommand('error') },
  ];
}

/**
 * 以前装过、现在不装的键:写入时摘掉咕咕的条目(用户的留着)。`permissionRequest` 在自动放行之前就触发,
 * 拿它当「等批准」会把每个已放行的工具读成 needs_user(等批准)。
 */
const RETIRED_COPILOT_HOOK_KEYS = ['permissionRequest'] as const;

/**
 * @@@subagent-stop (#6385) copilot 把后台 / 同步子代理结束时的 `agentStop` 也打进这条会话的 hook 流。
 * 能分开它的事实就在这一条 payload 里(copilot 1.0.82,10 次实跑 23/23 条 agentStop):
 * `transcriptPath` 一律是**主会话**的 `session-state/<主会话 id>/…`,而 `sessionId` 是发出这条边的那个会话 ——
 * 子代理的 agentStop 两者不等(= subagentStop.agentId),主会话的相等。
 * ⇒ 不等即标 `origin: 'subagent'`,由 deriveAgentStatus 判它不携带状态。❌ 查库、比顺序、计时。
 * 路径读不出会话 id = 与 copilot 协议对不上 ⇒ 响亮失败(这一条丢弃并记日志),❌ 当成主会话的边。
 * 子代理的 userPromptSubmitted 没有 transcriptPath,自证不了,不标(实测它总落在主回合之内,见 spec 已知边界)。
 */
const TRANSCRIPT_SESSION_ID = /session-state\/([^/]+)\//;

function parseCopilotStop(body: Record<string, unknown>): CanonicalHookEvent {
  const event = defaultHookEventParser('stop', body);
  if (event.kind !== 'status') return event;
  const { sessionId, transcriptPath } = body;
  if (typeof sessionId !== 'string' || typeof transcriptPath !== 'string') return event;
  const owner = TRANSCRIPT_SESSION_ID.exec(transcriptPath)?.[1];
  if (!owner) {
    throw new Error(`copilot agentStop transcriptPath carries no session id: ${transcriptPath}`);
  }
  return owner === sessionId ? event : { ...event, origin: 'subagent' };
}

/**
 * `errorOccurred`:`recoverable: true` 时 copilot 会接着跑(重试、把工具错误交回模型),不是失败边;
 * `false` 才是这一轮停在错误上。`error` 可能是字符串或 `{message}`,两种都认;字段缺失响亮失败。
 */
function parseCopilotError(body: Record<string, unknown>): CanonicalHookEvent {
  const { recoverable, error } = body;
  if (typeof recoverable !== 'boolean') throw new Error('copilot errorOccurred hook carries no recoverable flag');
  if (recoverable) return { kind: 'ignore' };
  const message =
    typeof error === 'string'
      ? error
      : typeof (error as { message?: unknown } | null)?.message === 'string'
        ? (error as { message: string }).message
        : undefined;
  if (!message) throw new Error('copilot errorOccurred hook carries no error message');
  const context = typeof body.errorContext === 'string' ? body.errorContext : undefined;
  return { kind: 'status', type: 'error', message: context ? `${context}: ${message}` : message };
}

function parseCopilotHookEvent(eventType: string, body: Record<string, unknown>): CanonicalHookEvent {
  switch (eventType) {
    case 'notification':
      // 问人要答案的对话框:问题等待,作答后工具跑完的 postToolUse 关它。
      if (body.notification_type === 'elicitation_dialog') return { kind: 'status', type: 'wait', waitKind: 'question' };
      return defaultHookEventParser(eventType, body);
    case 'stop':
      return parseCopilotStop(body);
    case 'error':
      return parseCopilotError(body);
    case 'wait_resolved':
      return { kind: 'status', type: 'wait_resolved' };
    default:
      return defaultHookEventParser(eventType, body);
  }
}

function copilotEntry({ command, matcher }: CopilotHookSpec): Record<string, unknown> {
  return matcher === undefined ? buildFlatEntry(command) : { ...buildFlatEntry(command), matcher };
}

function hasGuguEntry(hooks: Record<string, unknown[]>, key: string): boolean {
  const entries = Array.isArray(hooks[key]) ? hooks[key] : [];
  return entries.some((e) => JSON.stringify(e).includes(GUGU_HOOK_MARKER));
}

export function buildCopilotHookConfig() {
  const specs = copilotHookSpecs();
  const managedKeys = specs.map((spec) => spec.hookKey);

  return {
    async readHooks(fs: PluginFs): Promise<HookRegistration[]> {
      const config = await readJsonConfig(fs, COPILOT_HOOKS_PATH, 'gugu-managed');
      const hooks = (config.hooks ?? {}) as Record<string, unknown[]>;
      const installed = managedKeys.some((k) => hasGuguEntry(hooks, k));
      return installed ? [{ event: 'gugu', command: GUGU_HOOK_MARKER }] : [];
    },
    async writeHooks(fs: PluginFs, _hooks: HookRegistration[]): Promise<string[]> {
      const config = await readJsonConfig(fs, COPILOT_HOOKS_PATH, 'gugu-managed');
      const hooks = (config.hooks ?? {}) as Record<string, unknown[]>;

      for (const key of RETIRED_COPILOT_HOOK_KEYS) {
        if (!Array.isArray(hooks[key])) continue;
        const user = filterUserHooks(hooks[key] as Record<string, unknown>[]);
        if (user.length > 0) hooks[key] = user;
        else delete hooks[key];
      }
      for (const spec of specs) {
        const existing = Array.isArray(hooks[spec.hookKey]) ? hooks[spec.hookKey] : [];
        hooks[spec.hookKey] = [...filterUserHooks(existing as Record<string, unknown>[]), copilotEntry(spec)];
      }

      await writeJsonConfig(fs, COPILOT_HOOKS_PATH, { ...config, version: 1, hooks }, 'gugu-managed');
      await removeLegacyGuguFiles(fs, [LEGACY_COPILOT_HOOKS_PATH]);
      return [COPILOT_HOOKS_PATH];
    },
    async deleteHooks(fs: PluginFs): Promise<void> {
      await stripManagedJsonHooks(fs, COPILOT_HOOKS_PATH, 'gugu-managed');
      await removeLegacyGuguFiles(fs, [LEGACY_COPILOT_HOOKS_PATH]);
    },
    async getHooksInstalled(fs: PluginFs): Promise<boolean> {
      const config = await readJsonConfig(fs, COPILOT_HOOKS_PATH, 'gugu-managed');
      const hooks = (config.hooks ?? {}) as Record<string, unknown[]>;
      return managedKeys.some((k) => hasGuguEntry(hooks, k));
    },
    parseHookEvent: parseCopilotHookEvent,
  };
}
