/**
 * MiMo-Code 的推理档 —— **档位清单**与它**在配置文档里的形状**，一处真值。
 *
 * 出处一律是 `XiaomiMiMo/MiMo-Code@c3ed45f`（2026-08-27 读的源码），不是本仓旧注释。
 *
 * ## 为什么这一家的档位不是「编数据」
 *
 * ① **它的 ACP 没有推理强度这条轴。** `packages/opencode/src/acp/agent.ts` 的
 *    `buildConfigOptions()` 只造 `category:"model"` 与 `"mode"` 两类；整个仓 `thought_level`
 *    命中 **0** 次（阳性对照：同一次检索 `configOptions` 命中 4）。⇒ 活目录那一级
 *    （`harnessCatalogToEfforts`）对这家**恒为空**，换什么模型都一样。
 *
 * ② **它把「深浅」表达成模型的 variant。** `cli/cmd/run.ts:295` 的 `--variant`，help 原文
 *    「model variant (provider-specific reasoning effort, e.g., high, max, minimal)」。
 *    生效处 `session/llm.ts:482-497`：
 *      `const variant = !small && model.variants && user.model.variant ? model.variants[…] : {}`
 *      `pipe(base, mergeDeep(model.options), mergeDeep(agent.options), mergeDeep(variant))`
 *    ⇒ **模型上没有那个 variant 就静默合个空对象，旗标白给、不报错**。
 *
 * ③ **`variants` 是模型自己在配置里声明的字段，而咕咕本来就在写那份配置。**
 *    schema：`config/provider.ts:82`；官方文档 `packages/web/src/content/docs/models.mdx:108-131`
 *    给的就是 `provider.<id>.models.<model>.variants.<level> = { reasoningEffort: … }`。
 *    合并语义：`provider/provider.ts:1427` 与 `:1592` 都是
 *      `mergeDeep(ProviderTransform.variants(model), configVariants)`
 *    —— **显式声明的 variants 盖在派生表之上**。所以 `transform.ts:1222` 那句
 *    `if (!model.capabilities.reasoning) return {}` 和 `:1226-1234` 的
 *    `glm`/`kimi`/`qwen`/`minimax` 子串黑名单**只影响派生表，绕得过去**：派生出 `{}`，
 *    我们这份原样落地。⇒ 不需要给模型条目补 `reasoning: true`。
 *
 * ## 档位清单为什么是 low / medium / high
 *
 * 这是 **opencode 系这一侧**的词表：咕咕的平台 provider 声明的 npm 是 `@ai-sdk/openai-compatible`
 * （见 `opencode-family-model-config.ts`）。upstream 自己给这个 npm 派生的档位就是
 * `transform.ts:1360` 的 `WIDELY_SUPPORTED_EFFORTS`（`:1208` = `["low","medium","high"]`），
 * 形状逐字是 `{ [effort]: { reasoningEffort: effort } }`。文档里 `none/minimal/xhigh`
 * 那些是 `@ai-sdk/openai` / `@ai-sdk/gateway` / OpenRouter 那几支的，**不是这一支**的。
 *
 * ⚠️ 这里曾经还有第二条来源「网关这一端只认三档」（读的是 New API
 * `service/relayconvert/internal/oai_chat/to_claude_messages_req.go:177-195` 那个只有三个 case 的
 * switch）。那是 OpenAI Chat→Claude **协议转换器**；#5775（2026-09-18）起网关对所有渠道都是
 * `converter: none` 直通，那段代码不在任何平台请求的路径上。某个平台模型认哪几档是上游的事，
 * 各不相同（glm-5.3 只认 low/high/max），由网关目录逐模型下发、在选档那一步取交集（#6447）。
 *
 * ## 这份表怎么到达会话（两条腿）
 *
 *  · **tui / pty**：`--variant <level>`（`buildStandardCommand` 的 `effortFlag`）。
 *    `run.ts:688/696` → `prompt.ts:2401` → `user.model.variant` → `llm.ts:482`。
 *    ⚠️ 只有旗标不够 —— 下面这张 `variants` 必须同时写进配置文档，否则就是上面②那个静默空合并。
 *  · **acp / Chat UI**：`mimo acp` 的选项表只有 network options 与 `cwd`
 *    （`cli/cmd/acp.ts:14-20`），**没有 argv 格**；咕咕的 ACP 注入信封
 *    （`EmdashSessionCapabilityInjection`）也没有 extraArgs 字段。所以这条腿只能走配置文档：
 *    把选中那一档的 payload 直接写进模型条目的 `options`（`llm.ts:493` 的
 *    `mergeDeep(input.model.options)` 是**无条件**应用的，与 agent / mode / variant 都无关）。
 *
 * ⚠️ ❌ **别把 variant 折进配置文档的 `model` 字符串**（`gugu-platform/<id>/high`）：
 *    `provider/provider.ts:2047` 的 `parseModel` 只按第一个 `/` 切，`modelID` 会变成
 *    `<id>/high`；`acp/agent.ts` 的 `defaultModel()` 查不到这个 id 之后**不会报错**，而是
 *    落到「随便挑一个最好的模型」（:1575-1601）—— 界面写着咕咕的模型、请求带着别的模型名，
 *    再被网关按单模型白名单拒掉。ACP 那条 `provider/model/<variant>` 形态只在
 *    `session/set_model` / `setSessionConfigOption('model')` 上成立（`parseModelSelection`，
 *    `acp/agent.ts:1722-1751`），不是配置文档这一格。
 */

/**
 * 写进配置文档 `provider.<id>.models.<model>.variants` 的那张表。
 *
 * 键 = 咕咕 composer 里的档位 id，也是 `--variant` 的取值；值 = upstream 给
 * `@ai-sdk/openai-compatible` 派生的同一份 payload（`transform.ts:1360`）。
 * 它最终经 `llm.ts:776` 的 `ProviderTransform.providerOptions` 变成
 * `providerOptions['gugu-platform']`，再由 `@ai-sdk/openai-compatible@2.0.41`
 * （`dist/index.mjs:332` 的 options schema、`:538` 的 `reasoning_effort: compatibleOptions.reasoningEffort`）
 * 落成请求体的 `reasoning_effort`。宿主注入的平台 provider 是 `@ai-sdk/openai`(`/v1/responses`)时,
 * 同一个 option 由那个包落成 `reasoning.effort`(opencode 同表实测,见 `OPENCODE_REASONING_VARIANTS`)。
 */
export const MIMOCODE_REASONING_VARIANTS = {
  low: { reasoningEffort: 'low' },
  medium: { reasoningEffort: 'medium' },
  high: { reasoningEffort: 'high' },
} as const satisfies Record<string, Record<string, unknown>>;

/** composer 里那一行的展示。键必须与上表逐字一致 —— `efforts.test.ts` 双向钉住。 */
export const MIMOCODE_EFFORT_OPTIONS = {
  low: { name: '低', description: '快速回应，推理较浅' },
  medium: { name: '中', description: '兼顾速度与推理深度，适合日常任务' },
  high: { name: '高', description: '更深的推理，适合复杂问题' },
} as const satisfies Record<keyof typeof MIMOCODE_REASONING_VARIANTS, { name: string; description?: string }>;
