import { positiveWindow, trimmedValue, type IPlatformModelBehavior } from '@gugu/session-core/agents/plugins';
import { harnessPlatform } from './platform';
import { QODER_PLATFORM_PROVIDER, qoderPlatformModelKey } from './session-bundle';

// Qoder CLI 的注入面 —— **一份 0600 settings 文档 + 一个环境变量**，两样都不是内联 argv。
//
// 形状取自它自己发行的字节（@qoder-ai/qodercli@1.1.30，`bundle/qodercli.js`），
// settings schema 里 `modelConfigs.customModels` 的描述逐字：
//   「Bring-your-own-key (BYOK) models declared locally. Each item requires `provider`,
//    `apiKey` and `model`; optional `type` …, `baseURL`, `key` (used with `-m`, defaults to
//    "<provider>/<model>"), `displayName`, `format` (API format/style metadata, allowed
//    values: "openai" or "anthropic"), `isReasoning`, `isVl`, `maxInputTokens`.
//    These are merged into the model catalog and selectable via `qodercli -m <key>`.」
// 归一化函数（同一份字节里的 BYOK 规整器）确认了默认值：`key` 缺省 `<provider>/<model>`、
// `maxInputTokens` 缺省 128000、`baseURL` 缺省空串。
//
// ⚠️ **缺必填字段是 fail-open**：它只打一行
//    `[settings-byok] Skipping modelConfigs.customModels[i]: missing required field(s): …`
//    然后**照常起会话**，用的是用户自己的模型。所以物化层与别家同一条纪律：
//    这次注入不成立就一个字段都别发，❌ 别发半套。
//
// ⚠️ 模型选择用 `QODER_MODEL` 而不是 `-m`：它自己的选项回填器在**对应旗标缺席时**把
//    `QODER_MODEL` / `QODER_PERMISSION_MODE` 等六个变量填进同一个已解析选项对象
//    ⇒ 与旗标等价，且 env 两条腿都到得了（session-ACP 由可信 adapter argv 接收物化 args）。
//
// ⚠️ 令牌走**文档**不走 argv：与 claude 那条同一个理由 —— argv 在进程表里人人可读。
export const platformModel: IPlatformModelBehavior = {
  declare: (input) => ({
    dialect: harnessPlatform.dialect,
    model: input.explicitModel ?? input.envOverride('GUGU_ACP_QODER_MODEL'),
    ...(input.platformProvider ? { platformProvider: input.platformProvider } : {}),
    ...(input.contextWindow !== undefined ? { contextWindow: input.contextWindow } : {}),
  }),
  // 文档承载凭据，环境变量承载选择。
  // ⚠️ 这里返回 `settingsOverride` 而不是内联 JSON 的 argv —— 写文件是 IO，属于持有会话生命期
  //    的那一层（它得在会话结束时删掉），所以本层只到值为止。
  load: (model) => {
    const selectedModel = trimmedValue(model.model);
    const platform = model.platformProvider;
    if (!platform) return {};
    if (!selectedModel) return {};
    return {
      settingsOverride: {
        modelConfigs: {
          customModels: [{
            key: qoderPlatformModelKey(selectedModel),
            displayName: selectedModel,
            provider: QODER_PLATFORM_PROVIDER,
            model: selectedModel,
            apiKey: platform.apiKey,
            baseURL: platform.baseUrl,
            // 允许值只有 "openai" / "anthropic"（厂商 schema 原文）。咕咕网关是 OpenAI 兼容面。
            format: 'openai',
            // 网关别名不在它的内建表里；不声明就落到缺省的 128000。
            ...(positiveWindow(model.contextWindow)
              ? { maxInputTokens: model.contextWindow }
              : {}),
          }],
        },
      },
      spawnEnv: { QODER_MODEL: qoderPlatformModelKey(selectedModel) },
    };
  },
};
