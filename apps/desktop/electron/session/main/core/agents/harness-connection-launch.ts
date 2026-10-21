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
    unsetEnv: [
      'OPENAI_API_KEY',
      'CODEX_API_KEY',
      'OPENAI_BASE_URL',
      'OPENAI_ORG_ID',
      'OPENAI_ORGANIZATION',
      'OPENAI_PROJECT_ID',
    ],
    env: { [nativeHome.envVar]: configDir, ...(apiKey ? { OPENAI_API_KEY: apiKey } : {}) },
    config:
      'cli_auth_credentials_store = "file"\n' +
      (api
        ? `model_provider = "gugu_connection"\n[model_providers.gugu_connection]\nname = ${JSON.stringify(id)}\nbase_url = ${JSON.stringify(endpoint ?? 'https://api.openai.com/v1')}\nenv_key = "OPENAI_API_KEY"\nwire_api = "responses"\n`
        : ''),
  };
}
