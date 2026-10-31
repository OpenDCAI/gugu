import { definePluginCapability } from '@gugu/session-shared/plugins';
import type { GuguPermissionMode } from '../../../acp/models/permissions';
import z from 'zod';

export type CommandContext = {
  cli: string; // absolute path to the cli binary
  extraArgs?: string[]; // user-configured in settings
  /** 咕咕的权限档;缺席按编辑档(`resolveSessionPermissionMode`)。 */
  permissionMode?: GuguPermissionMode;
  initialPrompt?: string;
  /** Session-page conversation UUID — used as the session token for providers that track their
   * own session across the session-page lifetime (e.g. claude --session-id, opencode --session). */
  cliSessionId?: string;
  /** Provider-native session identifier stored by the agent classifier. When present, used
   * for resume on providers that generate their own session IDs (e.g. grok, copilot, kimi,
   * codex, droid). Undefined means the provider has not yet emitted a session ID. */
  providerSessionId?: string;
  /** Provider-native session id of a source conversation to fork from. Mutually exclusive
   * with isResuming: a fork spawn resumes the SOURCE session under a NEW session id
   * (ctx.sessionId), e.g. claude `--resume <src> --fork-session --session-id <new>`. */
  forkFromProviderSessionId?: string;
  isResuming?: boolean;
  model: string;
  /** Reasoning-effort level picked in the composer. Empty when none was chosen. */
  effort?: string;
};

export type AgentCommand = {
  command: string;
  args: string[];
  env: Record<string, string>;
  /**
   * gugu 真的把这家的 auto-approve flag 推上了这条 argv —— ❌ 不是「用户选了完全访问」。
   *
   * 两者会分叉:没声明 `autoApproveFlag` 的 harness 在任何档位下都不推。缺席 = 没推(保守的那一侧)。
   * 消费者是 spec hook-status-derivation:一条 permission 通知到底是不是「阻塞在人」,
   * 取决于这条 argv 上有没有那个 flag,而不是别处再推一遍那个决定。
   */
  autoApproved?: boolean;
  /** The sessionpage host must replace this command with its provider-native fork transport. */
  forkHandledByHost?: boolean;
};

/**
 * Whether a provider consumes the first prompt as part of session startup.
 * The decision is deliberately derived from the provider's declared prompt
 * capability, so renderer and device-side callers cannot drift into provider
 * name branches. ACP sessions have a native session/prompt channel; PTY
 * sessions require an argv or stdin-pipe declaration. Keystroke/none PTY
 * declarations stay on the legacy post-spawn delivery path.
 */
export function providerConsumesStartupPrompt(
  prompt: { kind: string; startupDelivery?: string } | undefined,
  transport: 'pty' | 'acp',
): boolean {
  if (transport === 'acp') return true;
  if (transport !== 'pty') return false;
  if (prompt?.startupDelivery === 'delivery-bridge') return false;
  return prompt?.kind === 'argv' || prompt?.kind === 'stdin-pipe';
}

/**
 * 终端腿首句由**宿主在这一家就绪之后**、经这条腿**平常收消息的那条路**(`local-session`:整段写进 pty)送进去,
 * 而不是塞进启动参数。
 *
 * 成立条件两格缺一不可:
 *  · `startupDelivery: 'delivery-bridge'` —— 这一家声明首句不走启动槽;
 *  · 这条腿的消息通道是 `local-session` —— 宿主自己往 pty 里写。通道是 `router` 的家(codex app-server、
 *    opencode serve)由它们各自的宿主适配层接住首句,❌ 这里再送一遍就是重复投递。
 *
 * 用于「首句进启动参数就赶不上」的家:Antigravity `agy` 带 `-i` 起,第一轮的 MCP 提示段在任何 stdio server
 * 应答之前就拼好了,咕咕的工具第一轮不在(2026-09-24 实测);首句在宿主看到这条会话的 gugu MCP
 * `tools/list` 之后再送,第一轮就有。
 */
export function providerStartupTurnViaLocalSession(
  prompt: { kind: string; startupDelivery?: string } | undefined,
  sessionTuiMessageTransport: string | undefined,
): boolean {
  return prompt?.startupDelivery === 'delivery-bridge' && sessionTuiMessageTransport === 'local-session';
}

/**
 * Whether the terminal leg can start with a first turn that is a real Gugu message (a chat-page first sentence or a
 * dispatched task card, carried as a route=chat envelope): through its argv/stdin startup slot, or host-injected over
 * local-session. The new-task composer offers Terminal for such a creation only when this holds, and the PTY spawn
 * refuses otherwise — one predicate, so the control never offers a leg that cannot start.
 */
export function providerTakesMessageStartupInPty(
  prompt: { kind: string; startupDelivery?: string } | undefined,
  sessionTuiMessageTransport: string | undefined,
): boolean {
  return providerConsumesStartupPrompt(prompt, 'pty')
    || providerStartupTurnViaLocalSession(prompt, sessionTuiMessageTransport);
}

type Prompt = {
  buildCommand(ctx: CommandContext): AgentCommand;
};

/**
 * PromptDeliveryOption is used to describe a prompt delivery that an agent supports.
 * @param kind - The kind of prompt delivery option.
 */
export const promptCapability = definePluginCapability<Prompt>()(
  'prompt-delivery',
  z.discriminatedUnion('kind', [
    z.object({
      kind: z.literal('argv'),
      flag: z.string().optional(),
      startupDelivery: z.enum(['startup-prompt', 'delivery-bridge']).optional(),
    }),
    z.object({
      kind: z.literal('keystroke'),
      submitSequence: z.string().optional(),
      submitDelayMs: z.number().optional(),
      startupDelivery: z.enum(['startup-prompt', 'delivery-bridge']).optional(),
    }),
    z.object({
      kind: z.literal('stdin-pipe'),
      startupDelivery: z.enum(['startup-prompt', 'delivery-bridge']).optional(),
    }),
    z.object({
      kind: z.literal('none'),
      /**
       * 这一家为什么没有可用的消息通道 —— 会**逐字进用户看到的那句错误**(见
       * `keystroke-injection.ts` 的 reject 与 `planSystemBootstrap` 的抛出)。
       *
       * ⚠️ 它存在的理由:`none` 有两种完全不同的成因,而用户需要知道是哪一种 ——
       * 「这家是无状态一次性引擎」(gemini)和「这条腿实测没有非-pty 的首句通道」
       * (kimi)给出的下一步动作不一样。❌ 不许改成按 provider 名字分支去凑文案:
       * 那是把一条一般机制换成一张一家一行的表。缺席 = 只说得出「没有声明消息编码」。
       */
      reason: z.string().optional(),
      startupDelivery: z.enum(['startup-prompt', 'delivery-bridge']).optional(),
    }),
  ])
);
