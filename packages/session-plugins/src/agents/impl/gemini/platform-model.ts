import { trimmedValue, type IPlatformModelBehavior } from '@gugu/session-core/agents/plugins';
import { harnessPlatform } from './platform';

/**
 * gemini 的中转两键必须是协议表的原话(`protocolEnv`,core 的 `platformModelAccessEnv('gemini-generate-content', …)`),
 * 由 `declare` 写进 `platformSettingsEnv`。缺了就是有人绕开协议表另拼了一条路 —— 响亮拒绝,
 * ❌ 不回落到 `platformProvider.baseUrl`(那是带 /v1 的 OpenAI 面地址,拼上 gemini 自己的 /v1beta 就是 404)。
 */
function geminiRelayEnv(platformSettingsEnv: Readonly<Record<string, string>> | undefined): {
  GOOGLE_GEMINI_BASE_URL: string;
  GEMINI_API_KEY: string;
} {
  const baseUrl = platformSettingsEnv?.GOOGLE_GEMINI_BASE_URL?.trim();
  const apiKey = platformSettingsEnv?.GEMINI_API_KEY?.trim();
  if (!baseUrl || !apiKey) {
    throw new Error(
      'gemini platform relay env must come from the protocol table (platformSettingsEnv.GOOGLE_GEMINI_BASE_URL + '
      + 'GEMINI_API_KEY); refusing to derive it from platformProvider.baseUrl, which carries the OpenAI-surface /v1 suffix (#4700)',
    );
  }
  return { GOOGLE_GEMINI_BASE_URL: baseUrl, GEMINI_API_KEY: apiKey };
}

// Gemini CLI：三个纯环境变量 GOOGLE_GEMINI_BASE_URL / GEMINI_API_KEY / GEMINI_MODEL，
// 一次都不落配置文件（官方 docs/reference/configuration.md 在案；实测 0.57.0 隔离 cwd +
// 本地假 Gemini 线端点：请求打到注入端点、路径带注入模型名、x-goog-api-key 逐字等于注入的
// key，换 key/换 model 读数跟着变）。发行包源码另证：GOOGLE_GEMINI_BASE_URL 存在时 ACP 侧
// authType 自动选 GATEWAY。落键在 ./session-bundle.ts 的 applyModelEnv 与下面的 `load`。
// ⚠️ 中转地址**只从协议表拿**(同 claude 那一家的纪律):`platformProvider.baseUrl` 是
// OpenAI 面的 `/v1` 根,而 gemini-cli 自己拼 `/v1beta/...` —— 两者叠起来就是
// `POST /v1/v1beta/models/<alias>:streamGenerateContent`,网关 404「Invalid URL」
// (2026-09-01 共享测试真机,#4700 首次平台形态读数就红在这一格;BYOK 探针的 shim 地址是裸的,
// 所以那条腿永远照不出来)。落键处只认这里给出的 `platformSettingsEnv`,❌ 不从 baseUrl 反推、不剥后缀。
export const platformModel: IPlatformModelBehavior = {
  declare: (input) => ({
    dialect: harnessPlatform.dialect,
    model: input.explicitModel ?? input.envOverride('GUGU_ACP_GEMINI_MODEL'),
    ...(input.platformProvider ? { platformProvider: input.platformProvider } : {}),
    ...(input.platformAccess
      ? {
        // 裸根不带尾斜杠:gemini-cli 直接拼 `/v1beta/...`,带了就是 `//v1beta`。
        platformSettingsEnv: input.protocolEnv(input.platformAccess.relayUrl.replace(/\/$/, '')),
      }
      : {}),
    ...(input.contextWindow !== undefined ? { contextWindow: input.contextWindow } : {}),
  }),
  // Gemini CLI —— 同 qwen 的纪律：这次注入不成立就**一个键都别发**。
  // ⚠️ 尤其不能单发 GEMINI_API_KEY：gemini 缺 BASE_URL 时不是拒启动，而是打 Google 默认端点 ——
  //    半套变量的后果不是「起不来」，是**平台 key 被送去厂商端点**（计费打错人 + 凭据出域）。
  // 出处：实测 0.57.0（隔离 cwd + 本地假 Gemini 线端点，变异对照换 key/换 model 读数跟随）。
  load: (model) => {
    const selectedModel = trimmedValue(model.model);
    const platform = model.platformProvider;
    if (!platform) return {};
    if (!selectedModel) return {};
    // 中转两键来自协议表(上面 `declare` 写进 platformSettingsEnv);
    // ❌ 不用 platform.baseUrl —— 它带 OpenAI 面的 /v1,gemini-cli 会再拼 /v1beta(#4700)。
    return { spawnEnv: { ...geminiRelayEnv(model.platformSettingsEnv), GEMINI_MODEL: selectedModel } };
  },
};
