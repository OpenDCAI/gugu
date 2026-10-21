import {
  buildMinimalJsonHookConfig,
  makeStdinHookCommand,
} from '@gugu/session-core/agents/plugins/helpers';

export const KIRO_HOOKS_PATH = '.kiro/agents/gugu.json';
/** 改名前的路径,见 `removeLegacyGuguFiles`。 */
const LEGACY_KIRO_HOOKS_PATH = '.kiro/agents/emdash.json';

// `.kiro/agents/gugu.json` 是咕咕专有的 hook 文件 ⇒ 'gugu-managed':畸形自愈,不 throw+preserve。
export function buildKiroHookConfig() {
  return buildMinimalJsonHookConfig(
    KIRO_HOOKS_PATH,
    [
      { hookKey: 'agentSpawn', command: makeStdinHookCommand('session') },
      { hookKey: 'userPromptSubmit', command: makeStdinHookCommand('start') },
      { hookKey: 'preToolUse', command: makeStdinHookCommand('start') },
      { hookKey: 'postToolUse', command: makeStdinHookCommand('start') },
      { hookKey: 'stop', command: makeStdinHookCommand('stop') },
    ],
    'gugu-managed',
    {
      name: 'gugu',
      description: 'Gugu-managed Kiro agent configuration for lifecycle hooks.',
    },
    [LEGACY_KIRO_HOOKS_PATH]
  );
}
