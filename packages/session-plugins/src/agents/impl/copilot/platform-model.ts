import { trimmedValue, type IPlatformModelBehavior } from '@gugu/session-core/agents/plugins';
import { COPILOT_WIRE_API, harnessPlatform } from './platform';
import { COPILOT_EFFORT_FLAG } from './session-bundle';

// GitHub Copilot CLI:自己一套 `COPILOT_PROVIDER_*`,纯环境变量、不落配置文件。
// ⚠️ 它**一个 canonical 名字都不读** —— 给 `OPENAI_BASE_URL` / `OPENAI_API_KEY` 没有任何作用。
//    这正是「OpenAI 兼容 ≠ 认 canonical 变量」的活例:协议同,变量名各家自定,必须逐家验。
export const platformModel: IPlatformModelBehavior = {
  declare: (input) => ({
    dialect: harnessPlatform.dialect,
    model: input.explicitModel ?? input.envOverride('GUGU_ACP_COPILOT_MODEL'),
    // 起始推理档 —— 下面 `load` 落成 `--effort <level>`(活会话改不了,只有 spawn 那一刻送得到,#6218)。
    ...(input.requestedEffort ? { reasoningEffort: input.requestedEffort } : {}),
    ...(input.platformProvider ? { platformProvider: input.platformProvider } : {}),
    ...(input.contextWindow !== undefined ? { contextWindow: input.contextWindow } : {}),
  }),
  // Copilot —— 四个 `COPILOT_PROVIDER_*` 一起给,纯进程环境。
  //
  // 实测 @github/copilot 1.0.80(隔离 HOME + 本地假 OpenAI 端点,未登录任何账号):
  // 四个变量都给 → 请求打到假端点、`Authorization: Bearer <给的 key>`、
  // body 的 `model` 就是给的 id,copilot 把假端点的回复原样打了出来;
  // **变异对照**:换 key 换 model id,两个读数都跟着变 ⇒ 探针判得了假。
  //
  // ⚠️ `COPILOT_PROVIDER_TYPE` 不能省 —— 它是「按自定义 provider 走」的开关本身。
  // ❌ 非平台会话一个键都不发:那会把用户自己配的 provider 顶掉。
  load: (model) => {
    const selectedModel = trimmedValue(model.model);
    const platform = model.platformProvider;
    if (!platform) return {};
    if (!selectedModel) return {};
    // 起始推理档只有 argv 这一条路(copilot 读不到任何 env/配置键;活会话里 set_config_option
    // 对平台模型被拒)。ACP 腿上 copilot 本体就是 adapter,这份 argv 经 adapter-env 信封挂上去(#6218)。
    const effort = trimmedValue(model.reasoningEffort);
    return {
      ...(effort ? { extraArgs: [COPILOT_EFFORT_FLAG, effort] } : {}),
      spawnEnv: {
        COPILOT_PROVIDER_TYPE: 'openai',
        // ⚠️ 不给它,copilot 落到默认的 `completions`,也就是 chat completions ——
        // 那正是 #5824 里它对每一个自营模型都拿到「无可用渠道」的原因。
        // 取值域出处:github-copilot-sdk 的 `ProviderConfig.wire_api`
        //(「API format (openai/azure only): "completions" or "responses". Defaults to "completions".」)。
        // 实测 @github/copilot(隔离 HOME + 本地假端点,其余变量不变):
        //   不设这一个 → POST /v1/chat/completions;设成 responses → POST /v1/responses。
        // ⇒ 值由 ./platform.ts 的 wireProtocol 查出(`COPILOT_WIRE_API`),只有一处可改。
        COPILOT_PROVIDER_WIRE_API: COPILOT_WIRE_API,
        COPILOT_PROVIDER_BASE_URL: platform.baseUrl,
        COPILOT_PROVIDER_API_KEY: platform.apiKey,
        COPILOT_PROVIDER_MODEL_ID: selectedModel,
      },
    };
  },
};
