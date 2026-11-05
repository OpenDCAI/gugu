import { positiveWindow, trimmedValue, type IPlatformModelBehavior } from '@gugu/session-core/agents/plugins';
import { harnessPlatform } from './platform';

/**
 * 平台令牌的变量名。❌ 不用 dsh 默认的 `DEEPSEEK_API_KEY`:dsh 的凭据库(`$DSH_HOME/.credentials.yaml`)
 * 先于进程环境,用户在 dsh 里存过同名 key 时那一份会被送去咕咕中转(见 ./platform.ts)。
 * 物化器把 `llm-deepseek.apiKeyEnv` 指到这里。
 */
export const DSH_PLATFORM_KEY_ENV = 'GUGU_DSH_PLATFORM_KEY';

/**
 * 这一家方言的唯一一份映射:平台模型 → dsh 吃的那几样。
 *
 * 地址取协议表(`protocolEnv`)给 anthropic-messages 的原话 `ANTHROPIC_BASE_URL`(裸根):dsh 在 baseURL
 * 后面拼 `/v1/messages`,与 Claude Code 同一个约定。❌ 不用 `platformProvider.baseUrl`:那是 OpenAI 面的
 * `<relay>/v1`,拼出来是 `/v1/v1/messages`。
 *
 * `load` 只交两样事实 —— 中转根与令牌;会话包物化器据此写 `--patch` 文档、把令牌放进进程环境。
 */
export const platformModel: IPlatformModelBehavior = {
  declare: (input) => ({
    dialect: harnessPlatform.dialect,
    model: input.explicitModel ?? input.envOverride('GUGU_ACP_DSH_MODEL'),
    ...(input.platformProvider ? { platformProvider: input.platformProvider } : {}),
    ...(input.platformAccess
      ? { platformSettingsEnv: input.protocolEnv(input.platformAccess.relayUrl.replace(/\/$/, '')) }
      : {}),
    ...(input.platformProvider && input.platformModels ? { platformModels: input.platformModels } : {}),
    ...(input.contextWindow !== undefined ? { contextWindow: input.contextWindow } : {}),
  }),
  load: (model) => {
    const selected = trimmedValue(model.model);
    const relay = model.platformSettingsEnv?.ANTHROPIC_BASE_URL?.trim();
    const token = model.platformSettingsEnv?.ANTHROPIC_AUTH_TOKEN?.trim();
    // 这次注入不成立就一个键都不发:半套会让它照常起会话、用的却是用户自己的账号。
    if (!model.platformProvider || !selected || !relay || !token) return {};
    return { spawnEnv: { DEEPSEEK_BASE_URL: relay, [DSH_PLATFORM_KEY_ENV]: token } };
  },
};

/** 平台模型在 dsh 自己模型表里的一行(`llm-deepseek.models[]`,字段见 `dsh-llm-deepseek` 的 `catalogModel`)。 */
export function dshCatalogRow(model: { id: string; displayName?: string; contextWindow?: number | null }): Record<string, unknown> {
  return {
    id: model.id,
    ...(model.displayName ? { name: model.displayName } : {}),
    ...(positiveWindow(model.contextWindow) ? { contextWindow: model.contextWindow } : {}),
  };
}
