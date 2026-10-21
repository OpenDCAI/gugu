import type { HarnessCatalogState } from '@main/core/agents/harness-model-catalog';
import {
  resolveModelEfforts,
  type ResolvedModelEfforts,
} from '@gugu/session-core/agents/plugins';

/**
 * 推理档在「新建一条会话」这一步怎么算 —— 桌面 composer 与手机新建页共用的**唯一**一份。
 *
 * 三级来源合成一个目录:活目录(ACP `thought_level`)→ 插件声明 → 按 modelId 查插件静态表;
 * 平台模型再与**该模型**在目录里认的档位取交集(见 resolveEffortCatalog,#6447)。
 * 下面几条纯规则原样从 renderer 的 harness-model-field.tsx / effort-options.ts 搬来
 * (那两处 re-export 保旧 import 路径),入口是最底下的 resolveCreateEfforts。
 */

/**
 * 一条会话能选的推理档 = 这条调用链路**真正兑现得了**的那几档。
 *
 * - **harness 自家模型(自有 key)**:harness 报什么就是什么。活目录(ACP `thought_level`)是真值;
 *   活目录是声明的子集时,只贡献「当前是哪一档」,仍列出完整声明(声明之外的 id —— 例如重置项 ——
 *   不能证明模型来源,所以不据此推断任何事)。
 * - **咕咕平台模型**:网关对推理档是直通(`converter: none`),请求原样到上游,由**上游模型**校验 ——
 *   而各模型认的档不同(glm-5.3 只认 low/high/max,gpt-5.6 到 max,claude-*-5 到 max)。
 *   ⇒ 档位 = 该模型在目录里认的那一组(`billing.platform_models.reasoning_efforts`,#6447)
 *   ∩ harness 这一侧说得出口的清单(活目录优先,没有就用插件声明 —— harness 送不出去的档同样不兑现)。
 *   目录没有这条事实(null)或说没有这根轴(`[]`)⇒ 不画推理档。
 *   ⚠️ 两个方向都撞过:#6199 之前直接返回插件声明(codex 自家 GPT 的六档到 `ultra` 摆在 GLM 上);
 *   #6199 改成与一张全局三档表(「网关只兑现 low/medium/high」)取交集,于是 GPT/Claude 真能用的
 *   xhigh/max 被砍掉,Kimi 又摆着它不认的 medium。❌ 两种都不要:档位按模型,来源是目录。
 *
 * 新建页(`resolveCreateEfforts`)与会话内(acp-chat-panel)都经这里,❌ 两处各算一遍、❌ 按 harness 特判。
 */
export function resolveEffortCatalog(
  declared: ResolvedModelEfforts | null,
  live: ResolvedModelEfforts | null,
  source: EffortSource,
  /** 平台模型在目录里认的推理档;只在 `source === 'platform'` 时读,自有模型传 null。 */
  platformModelEfforts: readonly string[] | null
): ResolvedModelEfforts | null {
  if (source === 'platform-undelivered') return null;
  if (source === 'platform') return honoredByModel(live ?? declared, platformModelEfforts);
  if (!live) return declared;
  if (!declared) return live;

  const liveIds = Object.keys(live.options);
  const liveIsCoveredByDeclaration = liveIds.every((id) => id in declared.options);
  if (!liveIsCoveredByDeclaration) return live;

  const defaultId =
    live.defaultId && declared.options[live.defaultId]
      ? live.defaultId
      : null;
  return { options: { ...declared.options }, defaultId };
}

/**
 * 这条会话的推理档由谁兑现:`harness`(自有 key)、`platform`(网关),或 `platform-undelivered` ——
 * 平台模型、但这一家在这条腿上选的档到不了网关(插件能力事实 `effort.platformUndeliveredOn`,#6218):
 * 那一格没有推理档可选,❌ 不画一个按得动却不生效的控件。
 */
export type EffortSource = 'harness' | 'platform' | 'platform-undelivered';

export function effortSourceFor(
  platformModel: boolean,
  effortCapability: { kind: string; platformUndeliveredOn?: readonly string[] } | undefined,
  leg: 'tui' | 'acp'
): EffortSource {
  if (!platformModel) return 'harness';
  return effortCapability?.kind === 'selectable' && effortCapability.platformUndeliveredOn?.includes(leg)
    ? 'platform-undelivered'
    : 'platform';
}

/** harness 这一侧的清单里该模型认的那几档,顺序照 harness(它的档名文案更贴切)。一档不剩 = 没有这根轴。 */
function honoredByModel(
  catalog: ResolvedModelEfforts | null,
  modelEfforts: readonly string[] | null
): ResolvedModelEfforts | null {
  if (!catalog || !modelEfforts?.length) return null;
  const accepted = new Set(modelEfforts);
  const options = Object.fromEntries(
    Object.entries(catalog.options).filter(([id]) => accepted.has(id))
  );
  if (Object.keys(options).length === 0) return null;
  const defaultId = catalog.defaultId && options[catalog.defaultId] ? catalog.defaultId : null;
  return { options, defaultId };
}


/**
 * 从目录合成一份「models 能力」，专供 `resolveModelEfforts` 查档位。
 *
 * 为什么需要它：推理强度控件的档位不是从 `ComposerModelOption` 来的（那个类型根本没有
 * `effortIds`），而是 `resolveModelEfforts` 拿 **modelId 去插件的静态能力表里查**。模型改由
 * ACP 提供之后，id 变成 `opus[1m]` 这样的别名，在静态表（键是 `claude-opus-4-8`）里一个也查
 * 不到 —— 于是强度控件对每个模型都消失。这是换数据源时最容易漏掉的**静默退化**：不报错、
 * 没日志，只是那个控件从此不出现。
 *
 * ⚠️ ACP 把档位给成**会话级**一份（`category="thought_level"`），不是每模型一份，所以这里每个
 * 模型挂的是同一份 —— ❌ 不因为目标形状是 per-model 就假装它们各不相同。
 *
 * 档位 id 过滤到插件自己声明的词表内：composer 拿 id 去查文案，查不到就是个没名字、点了会被
 * CLI 拒的选项。
 */
export function harnessCatalogToModelsCapability(
  state: HarnessCatalogState,
  effortOptionIds: readonly string[]
): {
  kind: 'selectable';
  modelOptions: Record<string, { name: string; effortIds?: string[]; defaultEffortId?: string }>;
  defaultModelId?: string;
} | null {
  // unsupported 也回 null —— 调用方于是继续用插件静态能力表，与改动前逐字节一致。
  if (state.kind !== 'ready' || state.models.length === 0) return null;
  const known = new Set(effortOptionIds);
  const effortIds = state.efforts.map((e) => e.id).filter((id) => known.has(id));
  return {
    kind: 'selectable',
    // harness 自己当前选中的那个 —— 默认值也该由它说了算，❌ 不用插件静态表里那个钉死的 id。
    ...(state.selected ? { defaultModelId: state.selected } : {}),
    modelOptions: Object.fromEntries(
      state.models.map((model) => [
        model.id,
        {
          name: model.name,
          ...(effortIds.length ? { effortIds } : {}),
          // `selectedEffort` 是 harness 自己当前的档位（`thought_level` 的 currentValue）——
          // 不把它接成 `defaultEffortId`，`resolveModelEfforts` 的 defaultId 恒为 null，composer
          // 那个档位标签就从「默认（中）」退化成「默认」，甚至整块不渲染（触发器只在
          // `selectedEffortItem ?? defaultEffortItem` 非空时才画）。
          // 这与 `effortIds` 是同一处静默退化，之前只救了一半。
          ...(state.selectedEffort && known.has(state.selectedEffort)
            ? { defaultEffortId: state.selectedEffort }
            : {}),
        },
      ])
    ),
  };
}


/**
 * 从活目录取**会话级**推理档位,composer 直接用,不绕 modelId。
 *
 * 为什么不继续走 `harnessCatalogToModelsCapability` + `resolveModelEfforts`:那条路要先有一个
 * 在 `modelOptions` 里查得到的 modelId。而选「咕咕提供的模型」时会话的 model 恒为 null
 * (模型由网关签发的 token 钉死,再报一个只会打架),于是 `resolveModelEfforts` 的
 * `if (!modelId) return null` 当场短路 —— 推理强度控件对**每个平台模型**都不出现。
 * 那正是这次要修的:引擎明明有六档,付费模型上一档都调不到。
 *
 * ACP 把档位给成会话级一份(`category="thought_level"`),它本来就与 modelId 无关,所以这里
 * 直接取,不再假装它是 per-model 的 —— 绕那一圈只是为了迁就插件静态表的形状。
 *
 * 原生 harness 模型的档位来自活会话;平台模型的档位来自插件声明。两者在调用方通过同一个
 * resolver 合并:活会话只是发现声明之外的原生档位,声明一致时仍是唯一的目录真值。
 *
 * `ready` 之外一律 null —— 调用方于是使用插件声明或已有 model resolver 的结果。
 */
/**
 * 插件自己声明的那份档位全集 —— 活目录读不到、又没有 harness modelId 可查时的**最后**一档。
 *
 * 为什么需要第三级:`resolveModelEfforts` 那条路要 `modelId` 才查得到档位,而两种常见情形下
 * 它恒为 null —— 选了咕咕的平台模型(模型由网关签发的 token 钉死),或这家一个静态模型都不声明。
 * 于是 kimi / qoder / mimocode 这些「装没装还没读出来」的家,推理强度那一行整个不画。
 * owner 2026-08-26 定的线:每家 harness 模型和推理强度都得有,**没有本身就是 bug**。
 *
 * ❌ 这不是「列一张跑不了的表」——那条红线管的是**模型**(列出用户跑不动的模型就是 fake)。
 * 档位不一样:插件那份 `effortOptions` 是对着各家 CLI 的 `--help` 实测抄下来的,
 * 每一档都送得到进程(argv 旗标或 ACP 会话选项)。
 *
 * `kind: 'none'` 的引擎(gemini CLI / mistral)在这里返回 null —— 它们真的没有这根轴。
 */
/**
 * 这个取值是不是 thinking 的**开关**(而不是一个推理档位)。
 *
 * 判据来自 harness 自己的词汇表:`off` / `on` 是开关的两个位置,而档位是
 * low/medium/high/xhigh/max 那一族。⚠️ 只认这两个字面量 —— ❌ 别扩成「短的就是开关」之类的
 * 启发式,那会把某家真的叫 `low` 的档位误判成开关、把整条轴吃掉。
 */
const THINKING_TOGGLE_VALUES = new Set(['off', 'on']);
function isThinkingToggleValue(id: string): boolean {
  return THINKING_TOGGLE_VALUES.has(id.trim().toLowerCase());
}

export function pluginDeclaredEfforts(
  effortCatalog: ResolvedModelEfforts['options'] | undefined
): ResolvedModelEfforts | null {
  if (!effortCatalog || Object.keys(effortCatalog).length === 0) return null;
  // 静态表说不出「当前是哪一档」,defaultId 只能是 null —— ❌ 不挑一个充数。
  return { options: { ...effortCatalog }, defaultId: null };
}

export function harnessCatalogToEfforts(
  state: HarnessCatalogState,
  /** 插件声明的档位词表(`capabilities.effort.effortOptions`);不是 selectable 就传 undefined。 */
  effortCatalog: ResolvedModelEfforts['options'] | undefined
): ResolvedModelEfforts | null {
  // `auth-required` 也带档位:未登录 ≠ 这个引擎没有推理强度轴。那两格由目录的第二遍探测
  // (占位凭据)填,读不到就是空数组、走下面的内置表兜底。⇒ 用户没登录这家 harness、
  // 正打算用咕咕的模型跑时,深浅照样调得动。
  if (state.kind !== 'ready' && state.kind !== 'auth-required') return null;

  // ⚠️ ACP 报回来的那一格**不一定是档位轴** —— 官方文档(kimi `configuration/config-files`)原话:
  // thinking 控件「dynamically exposed based on model capabilities, such as **effort values**,
  // **boolean toggles**, or forced-on states」。三种形态里只有第一种是档位;
  // `off`/`on` 那种是**开关**(要不要思考),与「思考多深」根本不是同一个轴。
  //
  // owner 2026-08-28 实测撞到的就是这个:kimi 在咕咕平台模型上以开关形态出现,
  // 而这里照单全收,于是活会话一起来,`Thinking Off / Thinking On` 就把插件声明的
  // 五档(low/medium/high/xhigh/max)整个盖掉 —— 会话外五档、进去变两档。
  //
  // ⇒ 报的是开关、而插件手里有真正的档位表时,**以插件那份为准**。
  //   ❌ 别反过来把插件的档位表也降成开关:那等于让「思考多深」这一维消失。
  //   开关那一维咕咕的取向是**默认开启**(owner:「我们是默认开启 think 的」),所以不画它。
  const advertisedIsBooleanToggle =
    state.efforts.length > 0 && state.efforts.every((level) => isThinkingToggleValue(level.id));
  const catalogHasRealLevels =
    !!effortCatalog &&
    Object.keys(effortCatalog).length > 0 &&
    !Object.keys(effortCatalog).every((id) => isThinkingToggleValue(id));
  if (advertisedIsBooleanToggle && catalogHasRealLevels) {
    // 静态表说不出「当前是哪一档」,defaultId 只能是 null —— ❌ 不挑一个充数。
    return { options: { ...effortCatalog }, defaultId: null };
  }

  const advertised: ResolvedModelEfforts['options'] = {};
  for (const level of state.efforts) {
    // 插件声明过就用插件那份（文案是对着 CLI 写的，更贴切）；**没声明就用 ACP 自己报的名字**。
    //
    // ⚠️ 这里原本是一道白名单：`effortCatalog` 里查不到的 id 直接丢弃，插件没声明 `effortOptions`
    // 就整个返回 null。那条规矩的理由是「查不到文案 = 一个没名字、点了会被 CLI 拒的选项」——
    // 两条都不成立：ACP 的 `configOptions` 每一项自带 `name`/`description`（所以有名字），
    // 而这些 id 本来就是 harness 自己报上来的、又原样经 `setSessionConfigOption` 送回去
    // （所以不会被拒）。真正的后果是六家 P0（qwen/kimi/qoder/mimocode/copilot/opencode）
    // 一条 `effortOptions` 都没声明 ⇒ 推理强度那一行对它们**永远不出现**，
    // 正是 owner 实测的「模型和思考强度都没有接入」。
    //
    // ❌ 不改成「照插件静态表列」：那会列出 harness 这条会话并不接受的档位（换 CLI 版本就漂），
    //    正是 harness-model-catalog 抬头那段要消灭的东西。来源仍然只有一个 —— harness 自己。
    advertised[level.id] = effortCatalog?.[level.id] ?? {
      name: level.name,
      ...(level.description ? { description: level.description } : {}),
    };
  }

  // 活目录**没有** advertise 档位时,退回插件内置的那份全集。
  //
  // 实测(claude 2.1.245,2026-08-26):它的 ACP `session/new` 只回 `category="model"`,
  // 不回 `category="thought_level"` —— 目录里 `efforts: []`。可 CLI 自己明明有
  // `--effort <low|medium|high|xhigh|max>`(`claude --help` 原文)。
  // ❌ 这时返回 null 就会让**整个引擎**的档位控件消失(实机:claude 下不管选哪个模型都没有
  // 推理强度那一行),正是 product spec「推理强度」禁止的「引擎有、界面没有」。
  //
  // 这不是「猜档位」:插件那份 effortOptions 是对着 CLI 实测写下来的,而 `kind: 'none'` 的
  // 引擎(gemini / mistral)压根不会走到这里 —— 调用方对它们传的就是 undefined。
  if (Object.keys(advertised).length === 0) {
    // ACP 一档都没 advertise。插件有内置表就退回它(claude 那条:CLI 明明有 `--effort`,
    // 可它的 `session/new` 不回 `thought_level`);两边都空就是这家真没有档位可调 —— 返回 null,
    // 界面不画那一行。
    if (!effortCatalog || Object.keys(effortCatalog).length === 0) return null;
    // 内置表说不出「当前是哪一档」,defaultId 只能是 null —— ❌ 不许挑一个充数:
    // 那会让界面显示一个用户从没选过、CLI 也未必在用的档位。
    return { options: { ...effortCatalog }, defaultId: null };
  }

  // harness 自己当前的档位就是「默认」那一档 —— 不接它,composer 的标签会从「默认(中)」
  // 退化成「默认」,触发器上的内联档位也不画(它只在 selected ?? default 非空时才画)。
  const defaultId =
    state.selectedEffort && advertised[state.selectedEffort] ? state.selectedEffort : null;
  return { options: advertised, defaultId };
}


export type CreateEffortsInput = {
  /** 活目录的探测结果(四态);手机端与桌面拿到的是同一份主进程缓存。 */
  state: HarnessCatalogState;
  /** 插件的 effort / models 能力声明(`capabilities.effort` / `capabilities.models`)。 */
  effortCapability: Parameters<typeof resolveModelEfforts>[0];
  staticModelsCapability: Parameters<typeof resolveModelEfforts>[1];
  /** 选中的 harness 自家模型 id;选了平台模型或没选就 null。 */
  model: string | null;
  /**
   * 选中的咕咕平台模型在目录里认的推理档(`PlatformModelOption.reasoningEfforts`,#6447);
   * 选的是 harness 自家模型(或没选)就是 null。平台模型的档位 = harness 清单 ∩ 这一组。
   */
  platformModel: { reasoningEfforts: readonly string[] | null } | null;
  /** 这条会话落在会话页哪条腿上 —— 平台档位能否送到网关按腿声明(#6218)。 */
  leg: 'tui' | 'acp';
};

/**
 * 平台模型 id → `CreateEffortsInput.platformModel` 那一格:从目录条目里取它认的推理档。
 * 没选平台模型 ⇒ null;选了但目录里查不到它 ⇒ 推理档 null(目录没有这条事实,不画这根轴)。
 * 新建页、终端会话菜单、会话内 composer 三处都经这里,❌ 各自 find 一遍。
 */
export function platformEffortFacts(
  platformModelId: string | null | undefined,
  models: readonly { id: string; reasoningEfforts: readonly string[] | null }[]
): CreateEffortsInput['platformModel'] {
  if (!platformModelId) return null;
  return { reasoningEfforts: models.find((model) => model.id === platformModelId)?.reasoningEfforts ?? null };
}

/**
 * 桌面 initial-session-section 里那一段的原样搬迁(2026-09-15):
 *   liveEfforts   = harnessCatalogToEfforts(state, 声明词表)
 *   declared      = pluginDeclaredEfforts(声明词表)
 *   models 能力   = 目录 unsupported 时用插件静态表,否则用活目录合成的那份
 *   结果          = resolveEffortCatalog(declared, live ?? resolveModelEfforts(...), 模型来源)
 *                   (平台模型:再与该模型在目录里认的档位取交集)
 */
export function resolveCreateEfforts(input: CreateEffortsInput): ResolvedModelEfforts | null {
  const effortOptions =
    input.effortCapability?.kind === 'selectable'
      ? (input.effortCapability as { effortOptions: ResolvedModelEfforts['options'] }).effortOptions
      : undefined;
  const liveEfforts = harnessCatalogToEfforts(input.state, effortOptions);
  const declaredEfforts = pluginDeclaredEfforts(effortOptions);
  const liveModelsCapability = harnessCatalogToModelsCapability(
    input.state,
    Object.keys(effortOptions ?? {}),
  );
  const effectiveModelsCapability =
    input.state.kind === 'unsupported' ? input.staticModelsCapability : liveModelsCapability ?? undefined;
  // 平台模型:新建时还没有平台会话。本机探针报的是**用户自家默认模型**的档位清单与当前档,
  // 不是平台模型的事实 ⇒ 词表取插件声明(没声明才借探针的档名),默认档为 null。
  const live = input.platformModel
    ? declaredEfforts
      ? null
      : liveEfforts && { options: liveEfforts.options, defaultId: null }
    : liveEfforts ?? resolveModelEfforts(input.effortCapability, effectiveModelsCapability, input.model);
  return resolveEffortCatalog(
    declaredEfforts,
    live,
    effortSourceFor(input.platformModel !== null, input.effortCapability, input.leg),
    input.platformModel?.reasoningEfforts ?? null,
  );
}
