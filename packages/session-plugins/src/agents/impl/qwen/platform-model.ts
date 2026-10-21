import { trimmedValue, type IPlatformModelBehavior } from '@gugu/session-core/agents/plugins';
import { harnessPlatform } from './platform';

// Qwen Code：三个 canonical 的 OpenAI 变量,一次都不落配置文件。
//
// 出处(官方用户文档 docs/users/configuration/auth.md 的鉴权矩阵那一行,逐字):
//   `OpenAI-compatible | openai | OPENAI_API_KEY, OPENAI_BASE_URL, OPENAI_MODEL
//    (alias: QWEN_MODEL) | OpenAI, Azure OpenAI, OpenRouter, ..., any OpenAI-compatible endpoint`
// ⇒ 「任意 OpenAI 兼容端点」是厂商自己写的,不是我们推断的。
//
// ⚠️ 与 codex / opencode 的差别在**落点**,不在协议:那两家的模型 id 要么走 `-c` 配置旗标、
//    要么走一份配置文档;qwen **选中的那一条**三样都吃环境变量。
//    ⚠️ 但「整组可切模型」不行 —— 环境变量表达不了一个列表,那一组走 qwen 自己的
//    `modelProviders`(终端腿的会话级 settings 副本,见 ./session-bundle.ts)。
//    ❌ 别因此以为「OpenAI 兼容 = 都能用 env」—— copilot 实测就只认自己的
//    `COPILOT_PROVIDER_*`,一个 canonical 名字都不读。逐家验。
export const platformModel: IPlatformModelBehavior = {
  declare: (input) => ({
    dialect: harnessPlatform.dialect,
    model: input.explicitModel ?? input.envOverride('GUGU_ACP_QWEN_MODEL'),
    ...(input.platformProvider ? { platformProvider: input.platformProvider } : {}),
    // ⚠️ **整组**可切模型也要带上 —— 三个环境变量只表达得了选中的那一条,
    //    而「这条会话还能换到哪几条」是 qwen 自己 `/model` 的输入(它读 settings 里的
    //    `modelProviders`,由本家物化器落盘)。
    //    这一格漏掉的后果是**静默**的:会话照跑、模型对,只是用户的 `/model` 里永远只有一行,
    //    而屏幕上没有任何东西说明为什么(2026-09-07 实撞,连撞三道闸门的第三道)。
    ...(input.platformProvider && input.platformModels ? { platformModels: input.platformModels } : {}),
    ...(input.contextWindow !== undefined ? { contextWindow: input.contextWindow } : {}),
  }),
  // Qwen Code —— 全部走进程环境。
  //
  // ⚠️ 三个键**缺一不可**，缺 `OPENAI_MODEL` 时 qwen 不是「退回它自己的默认模型」，而是**拒绝启动**：
  //    `No auth type is selected. Please configure an auth type ... before running in
  //     non-interactive mode.` —— 它是靠这组变量是否齐全来自动选中 `openai` 那种鉴权类型的。
  //    实测 qwen-code 0.22.0，隔离 HOME + 本地假 OpenAI 端点：
  //      · 三个都给      → 打到假端点，`Authorization: Bearer <给的 key>`、body `model` = 给的 id；
  //      · 去掉 MODEL    → 上面那句话，一个请求都不发；
  //      · 同一个 HOME 再把 MODEL 补回去 → 又通（变量隔离，排除缓存配置的干扰）。
  //    另有变异对照：换 key 换 model id，两个读数都跟着变 ⇒ 这个探针判得了假。
  //    ⇒ 所以下面两个 early-return 不是「少注一点」,是「这次注入不成立就一个键都别发」。
  //    ❌ 别改成「有几个发几个」:半套变量会让 qwen 以那句话退出,而用户看到的是会话起不来。
  // ❌ 非平台会话(BYOK / 用户自己的 key)这里一个键都不发 —— 那会把用户自己选的模型和端点顶掉。
  load: (model) => {
    const selectedModel = trimmedValue(model.model);
    const platform = model.platformProvider;
    if (!platform) return {};
    if (!selectedModel) return {};
    return {
      spawnEnv: {
        OPENAI_BASE_URL: platform.baseUrl,
        OPENAI_API_KEY: platform.apiKey,
        OPENAI_MODEL: selectedModel,
      },
    };
  },
};
