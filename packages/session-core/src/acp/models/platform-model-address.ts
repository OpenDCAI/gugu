/**
 * 咕咕平台模型在**一条活 ACP 会话上**怎么寻址 —— 规范 id(`glm-5.3`)与这一家自报的写法
 * (pi / opencode 是 `gugu-platform/glm-5.3`,claude 是 `claude-opus-5[1m]`)之间的换算。
 *
 * 住在 session-core 而不是渲染层,是因为有两个属主要问同一件事:渲染层的热切(`planModelSwitch`)
 * 和运行时重开后的模型断言(`session-manager.applyInitialModel`,#6196)。两份各写一遍,
 * 某天只改一份,症状是「断言的与热切的不是同一个模型」,不报错。
 *
 * ❌ 不 import 任何东西:渲染层、会话页主进程、runtime worker 三次打包都会拉它。
 */

/** Provider-native namespace used by the platform capability bundles (OpenCode and Pi). */
export const PLATFORM_NATIVE_OPTION_PREFIX = 'gugu-platform/';

/**
 * Claude Code 的写法是**后缀**:目录窗口 ≥ 1M 的 `claude-*` 平台模型写成 `<id>[1m]`。
 *
 * 那是 Claude Code 认 1M 窗口的唯一写法 —— 它发请求时自己剥掉后缀、改带 `context-1m` beta,网关看到的
 * model 仍是 `<id>`。`claude-*` 它认得,于是不理 `CLAUDE_CODE_MAX_CONTEXT_TOKENS`(modelAccess.ts),
 * 中转地址又不是 Anthropic 官方 ⇒ 一律按 200K 算:界面显示 200K、到 ~167K 就自动压缩,而目录说 1M。
 * 实测 claude 2.1.282(假端点读 `modelUsage[].contextWindow`):`claude-opus-5` → 200000,
 * `claude-opus-5[1m]` → 1000000,请求体的 model 是 `claude-opus-5`。其余模型原样返回。
 */
export const CLAUDE_1M_MODEL_SUFFIX = '[1m]';

/** 平台模型交给 Claude Code 时的写法(物化器用它,上面的换算用同一个后缀剥回来)。 */
export function claudePlatformModelOption(modelId: string, contextWindow: number | null | undefined): string {
  return modelId.startsWith('claude-') && (contextWindow ?? 0) >= 1_000_000
    ? `${modelId}${CLAUDE_1M_MODEL_SUFFIX}`
    : modelId;
}

/**
 * ZCode 的桥把 provider 表里的模型写成 `providerId\modelId`(zcode-acp `formatModelValue`):provider id 同是
 * `gugu-platform`(impl/zcode `zcodePlatformEnv` 写的表),分隔符是反斜杠。
 */
const ZCODE_PLATFORM_OPTION_PREFIX = 'gugu-platform\\';

/** 去掉平台寻址前缀(或 Claude 的 `[1m]` 后缀)后的 id;都不带就返回 null(不认识的写法 ❌ 猜)。 */
export function platformModelIdFromNativeOption(optionId: string): string | null {
  for (const prefix of [PLATFORM_NATIVE_OPTION_PREFIX, ZCODE_PLATFORM_OPTION_PREFIX]) {
    if (optionId.startsWith(prefix)) return optionId.slice(prefix.length) || null;
  }
  if (optionId.endsWith(CLAUDE_1M_MODEL_SUFFIX)) {
    return optionId.slice(0, -CLAUDE_1M_MODEL_SUFFIX.length) || null;
  }
  return null;
}

/** Resolve a provider's live model id to the canonical platform id when the catalog knows it. */
export function platformModelIdFromRuntimeOption(
  optionId: string,
  knownModelIds: Iterable<string>,
): string | null {
  const known = new Set(knownModelIds);
  if (known.has(optionId)) return optionId;
  const modelId = platformModelIdFromNativeOption(optionId);
  return modelId !== null && known.has(modelId) ? modelId : null;
}

/**
 * 反过来:**这条平台模型,在这条活会话上该用哪个值去下发**。
 *
 * `set_config_option` 收的不是咕咕的规范 id,而是**这一家自己的寻址形式**。那个前缀的真值
 * 只有一处 —— 写 provider 配置文档的物化器(`capability-bundle.ts` / 各家 session-bundle)。
 *
 * ⚠️ 所以这里**不拼字符串**,而是去活会话**自己报出来的那份清单**里挑:那份清单正是同一份配置
 * 文档生成的,所以它与前缀是同一个真值,按构造就不可能漂。
 * ❌ 别改成 `` `${PLATFORM_NATIVE_OPTION_PREFIX}${modelId}` `` —— 那是在编码处写第二份前缀字面量。
 *
 * ⚠️ 判定复用 {@link platformModelIdFromRuntimeOption},**不另写一份**。调用方负责先确认这条会话
 * 真在平台那条计费路上 —— BYOK 会话里同名的那条是另一条真凭据路径,不该被当成平台别名。
 *
 * 挑不到就返回 null,由调用方决定怎么办;❌ 这里不编一个「看起来对」的值兜底。
 */
export function runtimeOptionForPlatformModelId(
  platformModelId: string,
  advertised: Iterable<string>,
): string | null {
  const known = [platformModelId];
  for (const optionId of advertised) {
    if (platformModelIdFromRuntimeOption(optionId, known) === platformModelId) return optionId;
  }
  return null;
}
