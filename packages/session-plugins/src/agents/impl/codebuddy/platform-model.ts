import { trimmedValue, type IPlatformModelBehavior } from '@gugu/session-core/agents/plugins';
import { harnessPlatform } from './platform';

/** 会话里这几个槽位全钉到同一个模型:平台令牌在网关上只白名单一个。 */
const MODEL_SLOT_ENVS = [
  'CODEBUDDY_MODEL',
  'CODEBUDDY_SMALL_FAST_MODEL',
  'CODEBUDDY_BIG_SLOW_MODEL',
  'CODEBUDDY_CODE_SUBAGENT_MODEL',
] as const;

/**
 * 这一家方言的唯一一份映射:平台模型 → CodeBuddy 认的那组环境变量。
 *
 * 真会话里这份 `env` 由会话包物化器写进 0600 的 `--settings` 文档(`units.model` = `config-file`;
 * 宿主不发键 —— 用户 settings.json 的 `env` 块压得住进程环境,只有 `--settings` 那一层压得住它);
 * 模型目录探针拿同一份去起占位进程(`harness-catalog-probe-env.ts`)。两处 ❌ 各写一份。
 */
export const platformModel: IPlatformModelBehavior = {
  declare: (input) => ({
    dialect: harnessPlatform.dialect,
    model: input.explicitModel ?? input.envOverride('GUGU_ACP_CODEBUDDY_MODEL'),
    ...(input.platformProvider ? { platformProvider: input.platformProvider } : {}),
    ...(input.contextWindow !== undefined ? { contextWindow: input.contextWindow } : {}),
    ...(input.requestedEffort ? { reasoningEffort: input.requestedEffort } : {}),
  }),
  load: (model) => {
    const selected = trimmedValue(model.model);
    const platform = model.platformProvider;
    // 这次注入不成立就一个键都不发:半套会让它照常起会话、用的却是用户自己的账号。
    if (!platform || !selected) return {};
    return {
      spawnEnv: {
        // OpenAI 面的中转根(`<relay>/v1`):CodeBuddy 在它后面拼 `/chat/completions`(实测 B)。
        CODEBUDDY_BASE_URL: platform.baseUrl,
        CODEBUDDY_API_KEY: platform.apiKey,
        ...Object.fromEntries(MODEL_SLOT_ENVS.map((name) => [name, selected])),
      },
    };
  },
};
