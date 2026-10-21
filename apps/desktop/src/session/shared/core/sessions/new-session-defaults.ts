import type { AgentProviderId } from '@gugu/session-plugins/agents';
import type { SessionView } from './sessions';

/** 首次使用的组合；用户自己的选择始终优先。 */
export const DEFAULT_SESSION_VIEW: SessionView = 'general';
export const PREFERRED_SESSION_PROVIDERS = ['codex', 'claude'] as const satisfies readonly AgentProviderId[];
export const DEFAULT_FREE_PLATFORM_MODEL = 'gpt-6-luna';
export const DEFAULT_PLATFORM_MODEL_BY_PROVIDER: Readonly<Record<string, string>> = {
  claude: 'deepseek-v4.1-flash',
  codex: 'gpt-6-luna',
};
