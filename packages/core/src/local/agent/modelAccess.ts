import { listAgents, updateAgent, type LocalAgentRecord } from '../state/agents'
import {
  normalizeAgentModelSelection,
  type AgentModelSelection,
  type ModelAccessProtocol,
} from '../../shared/agentModelSelection'

// #5276 协议表、引擎表、选择的形状与归一化都搬进了 shared/agentModelSelection.ts（纯模块，渲染层也能
// import）。这里只剩要碰本机状态与注入闭包的部分；下面 re-export 让既有 import 路径一个字不用改。
export {
  agentModelSelectionForProtocol,
  isModelAccessProtocol,
  MODEL_ACCESS_PROTOCOL_GATEWAY_PATH,
  normalizeAgentModelSelection,
  MODEL_ACCESS_PROTOCOL_IDS,
  type AgentModelSelection,
  type ModelAccessProtocol,
} from '../../shared/agentModelSelection'

const CACHE_KEY = 'model_access'

/**
 * Which engine's models this agent may be offered — a label, for filtering a catalog and
 * validating a selection.
 *
 * Historical `cache.acp_engine_id` values are ignored. That key selected the removed Gugu ACP
 * runtime and may be stale; immutable agent type is the only live provider identity.
 */
export function catalogEngineIdForAgent(
  agent: Pick<LocalAgentRecord, 'agent_type'> & { cache?: Record<string, unknown> | null },
  engineIdForType: (agentType: LocalAgentRecord['agent_type']) => string | null,
): string | null {
  return engineIdForType(agent.agent_type)
}

/**
 * A protocol is defined once, by the credential an agent already asks for and the
 * variables that redirect that agent at the platform relay.
 *
 * An agent qualifies for a protocol because it declares that protocol's credential,
 * not because its id appears on a list here. That is what lets the session page grow
 * past the two agents this started with: onboarding one more is a matter of the
 * agent declaring what it already needs, and adding a protocol is one entry below.
 */
const MODEL_ACCESS_PROTOCOLS: Record<
  ModelAccessProtocol,
  {
    inject: (relayUrl: string, token: string, contextWindow?: number | null) => Record<string, string>
  }
> = {
  'anthropic-messages': {
    inject: (relayUrl, token, contextWindow) => ({
      ANTHROPIC_BASE_URL: relayUrl,
      ANTHROPIC_AUTH_TOKEN: token,
      // Blank rather than absent: a user's own key must not leak into a platform
      // session just because it happens to be exported in the parent environment.
      ANTHROPIC_API_KEY: '',
      // @@@2503 C6 —— tell the harness the platform model's real context window.
      //
      // The gateway model id (`glm-5.2-claude`, `gpt-5.6-sol`) is not one Claude Code recognizes,
      // so it assumes a 200K window and compacts — or hard-errors "Prompt is too long" client-side,
      // before a request is ever sent — long before the model's real limit.
      //
      // ⚠️ It must be MAX_CONTEXT_TOKENS, not AUTO_COMPACT_WINDOW. The two are not interchangeable:
      // AUTO_COMPACT_WINDOW is clamped to the window the harness already believes in
      // (`Math.min(assumedWindow, value)`), so on an unrecognized id it can only ever lower the
      // threshold — feeding it 1,000,000 still yields 200,000. MAX_CONTEXT_TOKENS is what replaces
      // the assumed window, and it applies directly precisely because the id is unrecognized (for
      // ids starting with `claude-` it is ignored unless DISABLE_COMPACT is set — ours never do).
      // Measured on claude 2.1.226 against a stub endpoint, reading `modelUsage[].contextWindow`
      // out of `--output-format json`: with AUTO_COMPACT_WINDOW=1000000 → 200000; with
      // MAX_CONTEXT_TOKENS=1000000 → 1000000. Documented on code.claude.com's env-vars page.
      //
      // ❌ We do not also set AUTO_COMPACT_WINDOW: where a user compacts inside the real window is
      // their own preference, and a platform session has no business overriding it. We only correct
      // what the harness believes the window IS. Absent/invalid window → omit the key entirely and
      // let the harness use its own default, never a wrong large value.
      ...(Number.isSafeInteger(contextWindow) && (contextWindow as number) > 0
        ? { CLAUDE_CODE_MAX_CONTEXT_TOKENS: String(contextWindow) }
        : {}),
    }),
  },
  'openai-responses': {
    // No window key here — not because codex and opencode do not need one (they do: codex has
    // `model_context_window`, opencode has `models.<id>.limit.context`), but because neither reads
    // it from the environment. Both take it through their own config surface, so the window is
    // emitted alongside the model id in each dialect's injection (see each plugin's platform-model.ts, not
    // capability-bundle.ts). This protocol only carries what genuinely travels as env vars.
    inject: (relayUrl, token) => ({
      OPENAI_BASE_URL: `${relayUrl}/v1`,
      OPENAI_API_KEY: token,
    }),
  },
  'openai-chat-completions': {
    // 与 `openai-responses` **逐字相同**,这不是复制粘贴的疏漏:两个协议的凭据面本来就是同一个
    // (`OPENAI_BASE_URL` + `OPENAI_API_KEY`),差别只在 harness 把请求打到 `/chat/completions`
    // 还是 `/responses` —— 而那是 harness 那侧的旋钮,不由环境变量表达。
    // ⇒ 这正是 2026-09-18 之前那个 bug 的根:协议从前是**按凭据变量名推**出来的,于是这两条
    //   在推导里塌成了一条,而网关只认得其中一条的路径(#5824)。
    inject: (relayUrl, token) => ({
      OPENAI_BASE_URL: `${relayUrl}/v1`,
      OPENAI_API_KEY: token,
    }),
  },
  'gemini-generate-content': {
    // Gemini wire format (`/v1beta/models/<id>:streamGenerateContent`, key in `x-goog-api-key`) —
    // gemini-cli appends the `/v1beta/...` path itself, so the relay URL travels bare (measured
    // against gemini-cli 0.57.0 with a stub endpoint, #4655). The gateway's nginx routes
    // `^/(v1|v1beta)/` to New API and an unauthenticated `/v1beta` probe returns the same New API
    // 401 shape as `/v1/models`, so the inbound route exists; whether the catalog actually offers
    // models on this protocol is the server's call (billing.platform_models rows), and until it
    // does the composer simply lists no platform models for this protocol — BYOK is unaffected.
    // The model id itself travels in the engine's injection dialect (`gemini-env`), not here.
    inject: (relayUrl, token) => ({
      GOOGLE_GEMINI_BASE_URL: relayUrl,
      GEMINI_API_KEY: token,
    }),
  },
}

/**
 * Environment that points one agent at the platform relay for the chosen protocol.
 *
 * `contextWindow` (tokens) is the platform model's real window. Only the anthropic-messages
 * protocol consumes it here, as CLAUDE_CODE_MAX_CONTEXT_TOKENS (see that protocol's inject);
 * the OpenAI-surface harnesses take their window through their own config surface instead.
 * Null/absent → the window key is omitted and the harness keeps its own default.
 */
export function platformModelAccessEnv(
  protocol: ModelAccessProtocol,
  relayUrl: string,
  token: string,
  contextWindow?: number | null,
): Record<string, string> {
  return MODEL_ACCESS_PROTOCOLS[protocol].inject(relayUrl, token, contextWindow)
}

export function cachedAgentModelSelection(agent: LocalAgentRecord): AgentModelSelection {
  return normalizeAgentModelSelection(agent.cache?.[CACHE_KEY])
}

export async function findLocalAgentByUserId(
  agentUserId: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<LocalAgentRecord | null> {
  const id = agentUserId.trim()
  if (!id) return null
  return (await listAgents(env)).find((agent) => agent.gugu_user_id === id) ?? null
}

export async function setLocalAgentModelSelection(
  agentUserId: string,
  selection: AgentModelSelection,
  env: NodeJS.ProcessEnv = process.env,
): Promise<AgentModelSelection> {
  const agent = await findLocalAgentByUserId(agentUserId, env)
  if (!agent) throw new Error('这个 Agent 不在当前设备上运行')
  const normalized = normalizeAgentModelSelection(selection)
  await updateAgent({ guguUserId: agentUserId }, {
    cache: { ...(agent.cache ?? {}), [CACHE_KEY]: normalized },
  }, env)
  return normalized
}
