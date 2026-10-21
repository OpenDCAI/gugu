import { positiveWindow, trimmedValue, type IPlatformModelBehavior } from '@gugu/session-core/agents/plugins';
import { harnessPlatform } from './platform';

// Kimi Code 的注入面 —— 纯环境变量，`KIMI_MODEL_*` 一族。
//
// 实测 `@moonshot-ai/kimi-code@0.38.0`（2026-08-25，隔离 HOME + 本地假 OpenAI 端点，
// **零登录、零 Moonshot 凭据、零真实推理请求**）：只给这几个变量、连 config.toml 都没有，
// 请求就真打到了假端点，`Authorization` 与 body 的 `model` 逐字等于给进去的值。
// 变异对照：换 key、换 model id，两个读数都跟着变 ⇒ 这个探针判得了假。
//
// ⚠️ **没有全局鉴权闸**（不像 grok 那样模型再自定义、没厂商 key 也拒启动）。判别方式是
//    对照错误形状：不注入时它报的是「No model configured…」（闸是「必须配着一个模型」，
//    不是「必须登录」），注入后请求直接送达。
//
// ⚠️ **api key 一个字节都不落盘** —— 代码里两层机制显式禁止把合成出来的 provider/model
//    写回 config.toml（保留键 `__kimi_env__` / `__kimi_env_model__`）。实测把 6 个隔离
//    HOME 连同全部 XDG 目录扫一遍：env 通道送的 key 零命中，而同一把 grep 找得到故意
//    写进 config.toml 的那把 key（阳性对照）⇒ 是真读数，不是仪器空转。
//
// ⚠️ ❌ 这一家**没有** `--config` 旗标（0.38.0 的根选项表里没有，报错与瞎编的 flag 逐字同形
//    ⇒ 真阴性）。那是旧产品 Python `kimi-cli` 才有的东西。
export const platformModel: IPlatformModelBehavior = {
  declare: (input) => {
    // composer 选的那一档优先;没选时留一个调试开关。
    const reasoningEffort = input.requestedEffort || input.envOverride('GUGU_ACP_KIMI_EFFORT');
    return {
      dialect: harnessPlatform.dialect,
      model: input.explicitModel ?? input.envOverride('GUGU_ACP_KIMI_MODEL'),
      ...(input.platformProvider ? { platformProvider: input.platformProvider } : {}),
      ...(input.contextWindow !== undefined ? { contextWindow: input.contextWindow } : {}),
      // 起始思考强度 —— 落成 `KIMI_MODEL_THINKING_EFFORT`(见 ./session-bundle 的
      // `applyModelEnv`)。调试开关与别家同形,方便不开 UI 也能钉一档。
      ...(reasoningEffort ? { reasoningEffort } : {}),
    };
  },
  // 与 qwen 同一条纪律：这次注入不成立就**一个键都别发**。
  // `KIMI_MODEL_NAME` 是这条通道的触发变量 —— 设了它才启用，而 `_API_KEY` 缺了会 fail loud。
  // 半套变量 = 会话起不来，而用户看到的只是「起不来」。
  load: (model) => {
    const selectedModel = trimmedValue(model.model);
    const platform = model.platformProvider;
    if (!platform) return {};
    if (!selectedModel) return {};
    return {
      spawnEnv: {
        KIMI_MODEL_NAME: selectedModel,
        KIMI_MODEL_API_KEY: platform.apiKey,
        KIMI_MODEL_BASE_URL: platform.baseUrl,
        // ❌ 别省：缺省按 type 取，而默认 type 是 `kimi`（打 Moonshot 官方端点），
        //    那样 base_url 会被无视，请求打去厂商那边而不是咕咕的网关。
        KIMI_MODEL_PROVIDER_TYPE: 'openai',
        // 网关别名不在它的内建表里，窗口不声明它就没有窗口（缺省 262144）。
        ...(positiveWindow(model.contextWindow)
          ? { KIMI_MODEL_MAX_CONTEXT_SIZE: String(model.contextWindow) }
          : {}),
      },
    };
  },
};
