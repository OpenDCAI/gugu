import {
  type ModelConfigDialect,
  type SessionModelCapability,
} from '@gugu/session-core/agents/plugins';

/**
 * opencode 系（opencode 本体 + 它的品牌化 fork MiMo-Code）把「用哪个模型」写进配置文档的那段形状。
 *
 * ## 为什么必须共用这一份
 *
 * MiMo-Code 是 sst/opencode 的 fork —— 它的主包目录就叫 `packages/opencode`，配置 schema 逐字相同，
 * 两家的差别只有**承载这份文档的环境变量名**（`OPENCODE_CONFIG_CONTENT` / `MIMOCODE_CONFIG_CONTENT`）。
 *
 * ⚠️ 各写一份的后果不是「有点重复」，而是**静默的错**：opencode 系遇到自己读不懂的配置键
 * 是**走默认**，不报错。所以两边一旦漂移，那家会安安静静地用它自己的默认模型跑起来，
 * 而这次会话的中转令牌在网关上只白名单了用户选中的那一个 ⇒ 每个请求被拒。
 * 症状（会话起得来、每轮都失败）离病根（某个字段名写岔了）隔着两层，极难往回查。
 *
 * ❌ 所以别在任何一家的 session-bundle 里重新拼这段 JSON。要改形状，改这里，两家一起动。
 *
 * ## 与 `opencode-family-platform-model.ts` 的分工
 *
 * 那边的 `openCodeFamilyConfigContent` 服务的是**会话页直接拉起引擎**那条路（产出 spawnEnv）；
 * 这里服务的是**插件 session-bundle 物化**那条路（产出配置对象，由各家 merge 进自己的文档）。
 * 两条路的调用时机和产物类型都不同，所以没有合并成一个函数 —— 但它们写出的
 * provider 声明必须同形，任何一边改了 `npm` / `options` / `models.limit` 的形状，另一边要跟。
 */
export interface OpenCodeFamilyModelSpec {
  /** 报错串里的人类可读名，例如 `OpenCode` / `MiMo-Code`。 */
  readonly displayName: string;
  /** 这一家在引擎目录里登记的注入方言；收到别家的方言要响亮地炸。 */
  readonly dialect: ModelConfigDialect;
  /** 平台 provider 在配置里的 id，模型按 `<providerId>/<model>` 寻址。 */
  readonly platformProviderId: string;
  /** 平台 provider 的展示名。 */
  readonly platformProviderName: string;
  /** 自定义 provider 的模型在 catalog 里没有条目，输出上限得自己声明。 */
  readonly outputLimit: number;
  /**
   * 这一家的推理档在配置文档里的形状（`variants`）。**不声明 = 这一家不接推理档**。
   *
   * 值是 AI SDK 的 provider option,不是请求体字段:opencode 系把它交给 provider 包,由包自己
   * 翻成线上字段。两家都用 `reasoningEffort`(见 `OPENCODE_REASONING_VARIANTS` 的实测)。
   */
  readonly reasoningVariants?: Readonly<Record<string, Readonly<Record<string, unknown>>>>;
}

/**
 * 模型条目里跟「推理档」有关的那两个键，opencode 系两条注入路共用这一份。
 *
 * - `variants`：整张档位表。没有它，`--variant <level>` 在 `session/llm.ts:482` 会
 *   **静默合个空对象** —— 旗标白给、退出码 0、零 warning。
 * - `options`：**这次会话选中的那一档**。`llm.ts:493` 的 `mergeDeep(input.model.options)`
 *   是无条件应用的（与 agent / mode / 用户有没有自己切 variant 都无关），所以它是
 *   **没有 argv 的那条腿（ACP）唯一到得了的通道**；用户自己在 TUI 里切 variant 时，
 *   `mergeDeep(variant)` 排在它后面，照样赢得过它。
 *
 * ⚠️ 词表里没有的档位**响亮地炸**：静默送出去的话，上游要么原样转发给一个不认识它的模型，
 *    要么（Claude 那一支）一声不吭地当没设过 —— 界面上却写着「已选 xhigh」。
 */

/**
 * OpenCode 平台模型的推理档 payload。ACP 与 session-TUI 两条物化路共用这一张表,两条腿报出的档位不会分叉。
 *
 * 键是 AI SDK 的 provider option `reasoningEffort`,由 provider 包翻成线上字段:
 * `@ai-sdk/openai`(平台 provider,走 `/v1/responses`)→ `reasoning.effort`;
 * `@ai-sdk/openai-compatible`(`/v1/chat/completions`)→ `reasoning_effort`。
 * ❌ 不能直接写请求体字段名 `reasoning_effort`:`@ai-sdk/openai` 不认这个 option,**静默丢掉**,
 * 请求照常发、不带任何推理档(#6218,opencode 1.18.25 对假端点实测:`{reasoning_effort:'high'}`
 * → 请求体无推理字段;`{reasoningEffort:'high'|'low'}` → `reasoning:{effort:'high'|'low'}`)。
 *
 * 这三档是 **opencode 这一侧**的词表(upstream 给 openai 系 provider 包派生的 `WIDELY_SUPPORTED_EFFORTS`,
 * 见 `impl/mimocode/efforts.ts`),不是「网关只认三档」—— 网关对推理档是直通(#6447)。某个平台模型
 * 认不认其中哪一档由目录逐模型下发,界面在选档那一步取交集(`resolveEffortCatalog`);这里多声明
 * 一档只是一个选不到的 variant,❌ 不必按模型拆表。
 */
const OPENCODE_REASONING_EFFORTS = ['low', 'medium', 'high'] as const;
export const OPENCODE_REASONING_VARIANTS = Object.fromEntries(
  OPENCODE_REASONING_EFFORTS.map((effort) => [effort, { reasoningEffort: effort }]),
) as { readonly [E in (typeof OPENCODE_REASONING_EFFORTS)[number]]: { readonly reasoningEffort: E } };

/** Derive the plugin-facing effort catalog from the provider payload keys. */
export function effortOptionsFromReasoningVariants(
  variants: Readonly<Record<string, Readonly<Record<string, unknown>>>>
): Record<string, { name: string }> {
  return Object.fromEntries(Object.keys(variants).map((id) => [id, { name: id }]));
}
export function openCodeFamilyReasoningEntry(
  spec: Pick<OpenCodeFamilyModelSpec, 'displayName' | 'reasoningVariants'>,
  reasoningEffort: string | undefined,
): Record<string, unknown> {
  const variants = spec.reasoningVariants;
  if (!variants) return {};
  const armed = reasoningEffort?.trim();
  const declared = { variants: { ...variants } };
  if (!armed) return declared;
  const payload = variants[armed];
  if (!payload) {
    throw new Error(
      `${spec.displayName} session adapter cannot arm reasoning level '${armed}': `
      + `declared levels are ${Object.keys(variants).join(' / ')}`,
    );
  }
  return { ...declared, options: { ...payload } };
}

export function openCodeFamilyModelConfig(
  spec: OpenCodeFamilyModelSpec,
  model: SessionModelCapability | null,
): Record<string, unknown> {
  if (!model) return {};
  if (model.dialect !== spec.dialect) {
    throw new Error(
      `${spec.displayName} session adapter cannot materialize model dialect '${model.dialect}'`,
    );
  }
  const selectedModel = model.model?.trim();
  if (!selectedModel) return {};
  // ❌ 非平台会话只钉模型、不写 provider：写了就会把用户自己配的端点顶掉。
  if (!model.platformProvider) return { model: selectedModel };
  const contextWindow = model.contextWindow;
  // 自定义 provider 下的模型在 catalog 里查不到，不声明窗口它就没有窗口。
  // `limit.context` 就是那个字段，和模型 id 写在同一条上。
  const modelEntry = {
    limit: {
      output: spec.outputLimit,
      ...(typeof contextWindow === 'number' && Number.isSafeInteger(contextWindow) && contextWindow > 0
        ? { context: contextWindow }
        : {}),
    },
    ...openCodeFamilyReasoningEntry(spec, model.reasoningEffort),
  };
  // 模型的寻址方式是 `provider/model`，所以平台模型只有在同一份文档里连 provider 一起声明
  // 之后才选得中。两半都是会话级的，随进程消亡。
  return {
    provider: {
      [spec.platformProviderId]: {
        npm: '@ai-sdk/openai-compatible',
        name: spec.platformProviderName,
        options: {
          baseURL: model.platformProvider.baseUrl,
          apiKey: model.platformProvider.apiKey,
        },
        models: { [selectedModel]: modelEntry },
      },
    },
    model: `${spec.platformProviderId}/${selectedModel}`,
  };
}
