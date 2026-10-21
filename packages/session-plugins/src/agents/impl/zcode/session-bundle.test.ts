import { describe, expect, it } from 'vitest';
import { ZCODE_PLATFORM_PROVIDER_ID, zcodePlatformEnv } from './session-bundle';

const platform = { baseUrl: 'https://relay.example/v1', apiKey: 'tok-123' };

describe('zcodePlatformEnv:平台会话交给桥的 ZCode provider 表', () => {
  it('非平台会话一个键都不发(用户自己的 provider 与套餐不被顶掉)', () => {
    expect(zcodePlatformEnv(null)).toEqual({});
    expect(zcodePlatformEnv({ dialect: 'zcode-provider-table', model: 'glm-5.3' })).toEqual({});
    expect(zcodePlatformEnv({ dialect: 'zcode-provider-table', platformProvider: platform })).toEqual({});
  });

  it('整份表进一个变量,菜单钉在咕咕那一家;选中的模型带推理档进默认选择', () => {
    const env = zcodePlatformEnv({
      dialect: 'zcode-provider-table',
      model: 'glm-5.3',
      platformProvider: platform,
      platformModels: [{ id: 'glm-5.3', displayName: 'GLM-5.3' }, { id: 'gpt-5.6', displayName: 'GPT-5.6' }],
    });
    expect(Object.keys(env).sort()).toEqual(['ZCODE_PERSONAL_PROVIDER_CONFIG_CONTENT', 'ZCODE_PROVIDER']);
    expect(env.ZCODE_PROVIDER).toBe(ZCODE_PLATFORM_PROVIDER_ID);
    const table = JSON.parse(env.ZCODE_PERSONAL_PROVIDER_CONFIG_CONTENT!);
    const rule = table.config.providerConfigRules.providerRules[0];
    expect(rule.providerId).toBe(ZCODE_PLATFORM_PROVIDER_ID);
    expect(rule.config.access).toEqual({ type: 'api-key', apiKey: 'tok-123' });
    expect(rule.config.api).toEqual({ type: 'openai-responses', baseUrl: 'https://relay.example/v1' });
    expect(rule.config.personalModelIds).toEqual(['glm-5.3', 'gpt-5.6']);
    expect(table.config.defaultModelSelection).toEqual({
      providerId: ZCODE_PLATFORM_PROVIDER_ID,
      modelId: 'glm-5.3',
      options: { reasoningLevel: 'disabled' },
    });
  });

  it('别家的方言响亮拒绝', () => {
    expect(() => zcodePlatformEnv({ dialect: 'hermes-serve-env', model: 'x', platformProvider: platform })).toThrow(
      /cannot materialize model dialect 'hermes-serve-env'/
    );
  });
});
