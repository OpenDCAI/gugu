import type { SessionUpdate } from '@agentclientprotocol/sdk';
import type { NormalizedEvent } from '@gugu/session-core/acp';
import { terminalExitFromMeta } from '../../acp-terminal-exit';

/**
 * Codex-specific enrichment of a baseline `NormalizedEvent`.
 *
 * codex-acp does not take ACP's client-terminal route. It runs the command
 * itself, then synthesizes a `{ type: 'terminal', terminalId }` content block
 * whose id is its own tool-call item id — never an id the client handed out via
 * `terminal/create`. So the client's terminal registry is never populated for
 * this provider and there is no first-hand exit status to read; the only report
 * of how the command ended is the pair of fields promoted here.
 *
 * Two sources, in order:
 *
 *   • `rawOutput.exit_code` — where codex-acp puts it on every completing shell
 *     update. `rawOutput` is a standard ACP field but its *contents* are the
 *     provider's own shape, which is why reading `exit_code` out of it belongs
 *     to this provider's hook and not to the baseline decoder.
 *   • `_meta.terminal_exit` — the same reading, carried alongside, and the one
 *     that also names a signal.
 *
 * The `_meta` block wins when both are present: it is the only one of the two
 * that can say a signal killed the process, and its `exit_code` agrees with
 * `rawOutput` in every recorded update.
 */
export function enrichCodexUpdate(update: NormalizedEvent, raw: SessionUpdate): NormalizedEvent {
  if (update.kind !== 'tool_call' && update.kind !== 'tool_update') return update;

  const agentCall = codexAgentCall(raw);
  if (agentCall !== null) {
    return agentCall === IGNORE
      ? { kind: 'ignored' }
      : {
          kind: 'subagent',
          toolCallId: update.toolCallId,
          // ❌ 不给 title:codex 这四个工具的名字是函数名,不是给人读的词;行上的行为词
          //    由渲染层给。缺席 = 保持不变(见 normalized-event 里 title 那条)。
          status: update.status ?? null,
          parentToolCallId: update.parentToolCallId ?? null,
          ...(update.rawInput != null ? { rawInput: update.rawInput } : {}),
          ...(update.rawOutput != null ? { rawOutput: update.rawOutput } : {}),
          ...(update.outputText != null ? { outputText: update.outputText } : {}),
          ...(agentCall.task !== undefined ? { inputSummary: agentCall.task } : {}),
          ...(agentCall.agentId !== undefined ? { agentId: agentCall.agentId } : {}),
        };
  }

  const exitStatus = terminalExitFromMeta(raw) ?? exitStatusFromRawOutput(raw);
  if (exitStatus === undefined) return update;
  return { ...update, exitStatus };
}

/**
 * codex 派子任务用的四个工具,ACP kind 全是 `other` ⇒ 全都掉进 `unknown-tool-call`,
 * 一次委派在界面上摊成六行原始函数名(`spawnAgent` / `wait` ×3 / `sendInput` /
 * `closeAgent`)。真实录制 `fixtures/acp-transcript.json` 里就是这样,而 gugu 的子智能体
 * 行早就存在、claude 那侧一直在用 —— #4981 里反复出现的那个形状。
 *
 * ⚠️ **不只按名字认**:`wait` 是个太普通的词,别家一个同名工具会被误认、进而整条消失。
 * 判据加上 codex 自己的参数形状(`senderThreadId`)—— 名字与形状都对上才认。
 * 判据里配了阴控。
 */
const CODEX_AGENT_TOOLS = new Set(['spawnAgent', 'sendInput', 'wait', 'closeAgent']);

/** 只记账、对读者一个字都没说的那两个 —— 见判据里关于代价的说明。 */
const CODEX_AGENT_BOOKKEEPING = new Set(['wait', 'closeAgent']);

type CodexAgentInput = {
  prompt?: unknown;
  senderThreadId?: unknown;
  receiverThreadIds?: unknown;
};

/** 记账那两条的记号 —— 与「认出来了,但它没话说」区分开。 */
const IGNORE = Symbol('codex-agent-bookkeeping');

type CodexAgentCall = { task?: string; agentId?: string };

function codexAgentCall(raw: SessionUpdate): CodexAgentCall | typeof IGNORE | null {
  const title = (raw as { title?: unknown }).title;
  if (typeof title !== 'string' || !CODEX_AGENT_TOOLS.has(title)) return null;

  const input = (raw as { rawInput?: unknown }).rawInput;
  if (!input || typeof input !== 'object') return null;
  const { prompt, senderThreadId, receiverThreadIds } = input as CodexAgentInput;
  // 形状对不上就不是 codex 的子任务协议 —— 老实放过,❌ 不猜。
  if (typeof senderThreadId !== 'string') return null;

  if (CODEX_AGENT_BOOKKEEPING.has(title)) return IGNORE;

  const receiver = Array.isArray(receiverThreadIds) ? receiverThreadIds : [];
  const agentId = typeof receiver[0] === 'string' ? receiver[0] : undefined;
  const task = typeof prompt === 'string' && prompt !== '' ? prompt : undefined;
  return {
    ...(task !== undefined ? { task } : {}),
    ...(agentId !== undefined ? { agentId } : {}),
  };
}

function exitStatusFromRawOutput(raw: SessionUpdate): { exitCode: number; signal: null } | undefined {
  const rawOutput = (raw as { rawOutput?: unknown }).rawOutput;
  if (!rawOutput || typeof rawOutput !== 'object') return undefined;
  const exitCode = (rawOutput as { exit_code?: unknown }).exit_code;
  return typeof exitCode === 'number' ? { exitCode, signal: null } : undefined;
}
