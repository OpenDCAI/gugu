import { describe, expect, it } from 'vitest';
import type { PluginFs } from '../../runtime/fs';
import { buildNestedJsonHookConfig, HookRuntimeVersionRequiredError } from './hook-config';
import { makeStdinHookCommand } from './hooks';

function memoryFs(initial: Record<string, string> = {}): PluginFs & { json(path: string): unknown } {
  const store = new Map<string, string>(Object.entries(initial));
  return {
    async read(path) { return store.get(path) ?? null; },
    async write(path, content) { store.set(path, content); },
    async delete(path) { store.delete(path); },
    async exists(path) { return store.has(path); },
    async list() { return []; },
    json(path) { const s = store.get(path); return s === undefined ? undefined : JSON.parse(s); },
  };
}

const PATH = '.claude/settings.local.json';
const config = () => buildNestedJsonHookConfig(PATH, [
  { hookKey: 'Stop', command: makeStdinHookCommand('stop') },
  { hookKey: 'StopFailure', command: makeStdinHookCommand('error'), sinceVersion: '2.1.78' },
], 'user');
const hookKeys = (fs: ReturnType<typeof memoryFs>) =>
  Object.keys((fs.json(PATH) as { hooks: Record<string, unknown> }).hooks).sort();

// spec hook-status-derivation:HookSpec.sinceVersion —— 旧 harness 见到不认识的 hook 键会丢掉整份 hooks
// (Claude Code 2.1.77 实测),所以版本不够的键不写。
describe('HookSpec.sinceVersion', () => {
  it('omits a key the probed harness version does not know, and writes it once the version does', async () => {
    const old = memoryFs();
    await config().writeHooks(old, [], { harnessVersion: '2.1.77' });
    expect(hookKeys(old)).toEqual(['Stop']);

    const current = memoryFs();
    await config().writeHooks(current, [], { harnessVersion: '2.1.78' });
    expect(hookKeys(current)).toEqual(['Stop', 'StopFailure']);
  });

  it('strips its own entry after a downgrade but keeps the user\'s entry under the same key', async () => {
    const fs = memoryFs();
    await config().writeHooks(fs, [], { harnessVersion: '2.1.280' });
    expect(hookKeys(fs)).toContain('StopFailure');

    await config().writeHooks(fs, [], { harnessVersion: '2.1.77' });
    expect(hookKeys(fs), 'an empty StopFailure array is still an unknown key to 2.1.77').toEqual(['Stop']);

    const withUserHook = memoryFs({
      [PATH]: JSON.stringify({ hooks: { StopFailure: [{ hooks: [{ type: 'command', command: 'say failed' }] }] } }),
    });
    await config().writeHooks(withUserHook, [], { harnessVersion: '2.1.77' });
    expect((withUserHook.json(PATH) as { hooks: Record<string, unknown> }).hooks.StopFailure)
      .toEqual([{ hooks: [{ type: 'command', command: 'say failed' }] }]);
  });

  it('fails loud when a gated key exists but the version of this spawn is unknown', async () => {
    await expect(config().writeHooks(memoryFs(), [], { harnessVersion: null }))
      .rejects.toBeInstanceOf(HookRuntimeVersionRequiredError);
  });

  it('needs no version when nothing is gated', async () => {
    const plain = buildNestedJsonHookConfig(PATH, [{ hookKey: 'Stop', command: makeStdinHookCommand('stop') }], 'user');
    const fs = memoryFs();
    await plain.writeHooks(fs, [], { harnessVersion: null });
    expect(hookKeys(fs)).toEqual(['Stop']);
    expect(await plain.getHooksInstalled(fs)).toBe(true);
  });

  it('counts hooks as installed from the ungated baseline, so an old harness is not "missing hooks"', async () => {
    const fs = memoryFs();
    await config().writeHooks(fs, [], { harnessVersion: '2.1.77' });
    expect(await config().getHooksInstalled(fs)).toBe(true);
  });
});
