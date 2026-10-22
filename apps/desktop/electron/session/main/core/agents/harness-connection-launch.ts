import { join } from 'node:path';
import { requireNativeHome } from '@gugu/session-plugins/agents';

/** No global config writes and no credentials in the generated config file. */
export function connectionLaunchConfig(
  providerId: 'claude' | 'codex',
  id: string,
  kind: 'account' | 'api-key',
  home: string,
  apiKey?: string,
  endpoint?: string
): { configDir: string; env: Record<string, string>; unsetEnv: string[]; config?: string } {
  // 每条连接一份独立配置根:布局与本机原生那份相同(`<连接 home>/<userPath>`),由同一个环境变量指过去。
  const nativeHome = requireNativeHome(providerId);
  const configDir = join(home, nativeHome.userPath);
  if (providerId === 'claude') {
    return {
      configDir,
      unsetEnv: [
        'ANTHROPIC_API_KEY',
        'ANTHROPIC_AUTH_TOKEN',
        'ANTHROPIC_BASE_URL',
        'CLAUDE_CODE_OAUTH_TOKEN',
        'CLAUDE_CODE_USE_BEDROCK',
        'CLAUDE_CODE_USE_VERTEX',
        'CLAUDE_CODE_USE_FOUNDRY',
      ],
      env: {
        [nativeHome.envVar]: configDir,
        ...(apiKey ? { [endpoint && new URL(endpoint).hostname !== 'api.anthropic.com' ? 'ANTHROPIC_AUTH_TOKEN' : 'ANTHROPIC_API_KEY']: apiKey } : {}),
        ...(endpoint ? { ANTHROPIC_BASE_URL: endpoint } : {}),
      },
    };
  }
  const api = kind === 'api-key';
  return {
    configDir,
    unsetEnv: [...CODEX_CONNECTION_UNSET_ENV],
    env: { [nativeHome.envVar]: configDir, ...(apiKey ? { OPENAI_API_KEY: apiKey } : {}) },
    config:
      'cli_auth_credentials_store = "file"\n' +
      (api
        ? `model_provider = "gugu_connection"\n[model_providers.gugu_connection]\nname = ${JSON.stringify(id)}\nbase_url = ${JSON.stringify(endpoint ?? 'https://api.openai.com/v1')}\nenv_key = "OPENAI_API_KEY"\nwire_api = "responses"\n`
        : ''),
  };
}

/** 选了 Codex 账号 / API 连接时,用户 shell 里继承来的这些认证变量不能顶掉所选的那个。 */
export const CODEX_CONNECTION_UNSET_ENV = [
  'OPENAI_API_KEY',
  'CODEX_API_KEY',
  'OPENAI_BASE_URL',
  'OPENAI_ORG_ID',
  'OPENAI_ORGANIZATION',
  'OPENAI_PROJECT_ID',
] as const;

/**
 * Codex API 连接跑在用户自己的根上(#26):provider 用 `-c` 现给,key 走 `OPENAI_API_KEY`,
 * ❌ 不再写进某个独立根的 config.toml —— 那样会话就得换根,对话历史跟着丢。
 * 与旧版 config.toml 里那段逐项相同(provider id、Responses 线协议、官方端点缺省)。
 */
export function codexApiKeyConnectionArgs(id: string, endpoint?: string): string[] {
  const provider = 'gugu_connection';
  return [
    '-c', `model_provider=${JSON.stringify(provider)}`,
    '-c', `model_providers.${provider}.name=${JSON.stringify(id)}`,
    '-c', `model_providers.${provider}.base_url=${JSON.stringify(endpoint ?? 'https://api.openai.com/v1')}`,
    '-c', `model_providers.${provider}.env_key="OPENAI_API_KEY"`,
    '-c', `model_providers.${provider}.wire_api="responses"`,
  ];
}
