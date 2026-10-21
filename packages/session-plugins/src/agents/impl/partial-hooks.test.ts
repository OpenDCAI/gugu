import type { PluginFs } from '@gugu/session-core/agents/plugins';
import { buildNestedEntry, makeStdinHookCommand } from '@gugu/session-core/agents/plugins/helpers';
import { describe, expect, it } from 'vitest';
import { AUGGIE_HOOKS_PATH } from './auggie/hooks';
import { provider as auggie } from './auggie';
import { COMMANDCODE_SETTINGS_PATH } from './commandcode/hooks';
import { provider as commandcode } from './commandcode';

function createMemoryFs(files: Map<string, string>): PluginFs {
  return {
    read: async (path) => files.get(path) ?? null,
    write: async (path, content) => { files.set(path, content); },
    delete: async (path) => { files.delete(path); },
    exists: async (path) => files.has(path),
    list: async () => [],
  };
}

const partialHookCases = [
  {
    name: 'auggie',
    provider: auggie,
    path: AUGGIE_HOOKS_PATH,
    partial: { hooks: { SessionStart: [buildNestedEntry(makeStdinHookCommand('session'))] } },
  },
  {
    name: 'commandcode',
    provider: commandcode,
    path: COMMANDCODE_SETTINGS_PATH,
    partial: { hooks: { Stop: [{ hooks: [{ type: 'command', command: makeStdinHookCommand('session') }] }] } },
  },
] as const;

describe('provider hook completeness contracts', () => {
  it.each(partialHookCases)('$name reports a partial install as incomplete and a rewritten install as complete', async ({ provider, path, partial }) => {
    const files = new Map([[path, JSON.stringify(partial)]]);
    const fs = createMemoryFs(files);
    await expect(provider.behavior.hooks!.getHooksInstalled!(fs)).resolves.toBe(false);
    // 最新版本:有版本门的键(HookSpec.sinceVersion)也一并写出。
    await provider.behavior.hooks!.writeHooks!(fs, [], { harnessVersion: '999.0.0' });
    await expect(provider.behavior.hooks!.getHooksInstalled!(fs)).resolves.toBe(true);
  });
});
