import { definePluginCapability } from '@gugu/session-shared/plugins';
import z from 'zod';

export const effortOptionSchema = z.object({
  /** Display label, e.g. 'High'. */
  name: z.string(),
  /** One-line explanation shown next to the level. */
  description: z.string().optional(),
});
export type EffortOptionDescriptor = z.infer<typeof effortOptionSchema>;

/**
 * EffortDescriptor declares the reasoning/thinking levels an agent knows about.
 *
 * This is the agent-wide *catalog* — each level's label/description lives here once.
 * Which subset a given model actually accepts is declared per model through
 * `models.modelOptions[id].effortIds` (see `capabilities/models.ts`), because the tiers
 * genuinely differ by model: codex 0.144.6 gives gpt-5.6-sol six levels up to `ultra`
 * while gpt-5.5 stops at `xhigh`.
 *
 * ## Vendors express "think harder" in four different shapes
 *
 * Surveyed against the CLIs themselves, not docs. Only the first shape needs this capability;
 * the others are already covered by `models` alone or by nothing at all.
 *
 * 1. **Its own axis, static tiers** — the case this capability exists for.
 *    - `codex` 0.144.6: `-c model_reasoning_effort=<level>`; catalog from `codex debug models`
 *      (`supported_reasoning_levels` / `default_reasoning_level`), which differs per model.
 *    - `claude` 2.1.220: `--effort <level>` ("Effort level for the current session").
 *      Levels are not narrowed per model here: the CLI's minified `supportsEffort` says false
 *      for haiku-4-5, but `claude --model haiku --effort xhigh` is accepted and the running
 *      session's status line shows xhigh. Behaviour beats reading compiled internals, so all
 *      four models get the full list and the real narrowing is left to the live ACP session,
 *      which re-advertises `thought_level` per model.
 * 2. **Its own axis, but the tiers depend on the provider** — cannot be a static table.
 *    `opencode` 1.17.9 has `--variant`, documented as "provider-specific reasoning effort,
 *    e.g., high, max, minimal", and `opencode models` only lists whatever providers the user
 *    has authenticated. Declaring a fixed catalog would be inventing data; opencode therefore
 *    declares no effort and relies on ACP advertising the levels for the live session.
 * 3. **Baked into the model id** — no separate axis, and none is needed. `antigravity`'s ACP
 *    catalog reports `gemini-3.7-flash-(low|medium|high)` (agy_acp_server 1.1.1, #6335); `amp`'s entire model list *is* `Low/Medium/High/
 *    Ultra`. These are ordinary models with no `effortIds`, and the picker correctly hides
 *    the row.
 * 4. **No control at all** — `gemini` 0.47.0 exposes only `-m` (its thinking budget lives in
 *    settings/API, not the CLI); `mistral` (vibe) has none. `kind: 'none'`, nothing renders.
 *
 * @param kind: 'selectable' - The agent supports selecting an effort level.
 * @param kind: 'none' - The agent does not support selecting an effort level.
 */
/*
 * 咕咕平台模型认哪些推理档,**不在这里**:那是每个模型自己的事实,由网关模型目录逐条下发
 * (`billing.platform_models.reasoning_efforts`,#6447),随目录条目 / 可切清单 / 签发到客户端。
 *
 * 这里曾经有一张全局常量 `PLATFORM_GATEWAY_REASONING_EFFORTS = low/medium/high`,理由是「网关只兑现
 * 这三档」。那读的是 New API 的 OpenAI Chat→Claude 转换器;#5775 起网关对所有渠道是 `converter: none`
 * 直通,档位原样到上游、由上游自己校验 —— 而上游各不相同:glm-5.3 / kimi-k3 只认 low/high/max,
 * gpt-5.6 到 max,claude-*-5 到 max(实测读数汇总在 #6447)。
 * 一张全局表必然两头错:砍掉 GPT/Claude 真能用的档,又给 Kimi 摆着它不认的 medium。
 */

/**
 * 平台会话启动时,会话记录里存的推理档**武装不武装** —— 与 composer 能选的档同一个交集:
 * 该模型在目录里认它(`reasoningEfforts`),且这家引擎的词表里有它(`effortOptions` 的键),才武装。
 *
 * 其余返回 null(harness 用自己的默认档,界面显示活会话报回的那一档)。会走到「记录里有、却不在交集里」的:
 * #6199 之前的存档、会话中途换模型后留下的旧档(从自有模型的 `max` 热切到平台 GLM 之类)。
 * ❌ 不能原样交给物化器:OpenCode 家族对词表外的档是响亮抛错,会话就开不起来。
 * ❌ 不猜「就近的一档」:那是替用户做一个他没做过的选择。
 *
 * `harnessEfforts` 为 null = 这家不声明词表(档位全靠活会话报),不按词表收窄。
 */
export function platformArmedEffort(
  recorded: string | null | undefined,
  modelEfforts: readonly string[] | null | undefined,
  harnessEfforts: readonly string[] | null
): string | null {
  const id = recorded?.trim();
  if (!id || !modelEfforts?.includes(id)) return null;
  return harnessEfforts && !harnessEfforts.includes(id) ? null : id;
}

export const effortCapability = definePluginCapability()(
  'effort',
  z.discriminatedUnion('kind', [
    z.object({
      kind: z.literal('selectable'),
      /** Every level this agent understands, keyed by the id handed to the CLI. */
      effortOptions: z.record(z.string(), effortOptionSchema),
      /** Native reset value, separate from the ordered intensity catalog. */
      resetId: z.string().optional(),
      /**
       * Session-page legs where a level picked for a **Gugu platform model** is measured not to reach
       * the gateway (gateway ledger `reasoning_effort` absent, #6218). On those legs the platform
       * model offers no effort axis at all: a control that shows "High selected" while the request
       * carries nothing is a fake control (#6199). Remove the leg once delivery is fixed and
       * re-measured on the ledger. Own-key models are unaffected.
       */
      platformUndeliveredOn: z.array(z.enum(['tui', 'acp'])).optional(),
    }),
    z.object({
      kind: z.literal('none'),
    }),
  ]),
  { kind: 'none' }
);
