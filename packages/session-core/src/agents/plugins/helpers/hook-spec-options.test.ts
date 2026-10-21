import { describe, expect, it } from 'vitest';
import type { PluginFs } from '../../runtime/fs';
import {
  buildFlatJsonHookConfig,
  buildMinimalJsonHookConfig,
  buildNestedEntry,
  buildNestedJsonHookConfig,
  nestedHooksObject,
  type HookSpec,
} from './hook-config';
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
const WAIT = makeStdinHookCommand('wait');
const RESOLVED = makeStdinHookCommand('wait_resolved');
const SPECS: HookSpec[] = [
  { hookKey: 'Stop', command: makeStdinHookCommand('stop') },
  { hookKey: 'PreToolUse', command: WAIT, matcher: 'AskUserQuestion|ExitPlanMode' },
  { hookKey: 'PostToolUse', command: RESOLVED, async: true },
];
const config = () => buildNestedJsonHookConfig(PATH, SPECS, 'user');
const hooksIn = (fs: ReturnType<typeof memoryFs>) => (fs.json(PATH) as { hooks: Record<string, unknown[]> }).hooks;
const USER_PRE_TOOL = { matcher: 'Bash', hooks: [{ type: 'command', command: 'lint-bash' }] };

// #6448:HookSpec 的 matcher / async 进嵌套格式(Claude / qwen),托管条目照样认得出、换得掉、摘得干净。
describe('HookSpec matcher / async (nested format)', () => {
  it('writes the matcher on the group and async on the handler', async () => {
    const fs = memoryFs();
    await config().writeHooks(fs, [], { harnessVersion: null });
    expect(hooksIn(fs).PreToolUse).toEqual([
      { matcher: 'AskUserQuestion|ExitPlanMode', hooks: [{ type: 'command', command: WAIT }] },
    ]);
    expect(hooksIn(fs).PostToolUse).toEqual([{ hooks: [{ type: 'command', command: RESOLVED, async: true }] }]);
    expect(hooksIn(fs).Stop).toEqual([buildNestedEntry(makeStdinHookCommand('stop'))]);
  });

  it('recognises its own entries in their full shape', async () => {
    const fs = memoryFs();
    await config().writeHooks(fs, [], { harnessVersion: null });
    expect(await config().getHooksInstalled(fs)).toBe(true);
    expect(await config().readHooks(fs)).toHaveLength(1);
  });

  it('an older managed entry without the matcher is not "installed", and a rewrite replaces it (no duplicate)', async () => {
    const fs = memoryFs({
      [PATH]: JSON.stringify({
        hooks: {
          Stop: [buildNestedEntry(makeStdinHookCommand('stop'))],
          PreToolUse: [buildNestedEntry(WAIT), USER_PRE_TOOL],
          PostToolUse: [buildNestedEntry(RESOLVED)],
        },
      }),
    });
    expect(await config().getHooksInstalled(fs)).toBe(false);
    await config().writeHooks(fs, [], { harnessVersion: null });
    expect(hooksIn(fs).PreToolUse).toEqual([
      USER_PRE_TOOL,
      { matcher: 'AskUserQuestion|ExitPlanMode', hooks: [{ type: 'command', command: WAIT }] },
    ]);
    expect(hooksIn(fs).PostToolUse).toEqual([{ hooks: [{ type: 'command', command: RESOLVED, async: true }] }]);
    expect(await config().getHooksInstalled(fs)).toBe(true);
  });

  it('rewriting is idempotent', async () => {
    const fs = memoryFs();
    await config().writeHooks(fs, [], { harnessVersion: null });
    const first = JSON.stringify(fs.json(PATH));
    await config().writeHooks(fs, [], { harnessVersion: null });
    expect(JSON.stringify(fs.json(PATH))).toBe(first);
  });

  it('uninstall strips the matcher / async entries and keeps the user\'s', async () => {
    const fs = memoryFs({ [PATH]: JSON.stringify({ hooks: { PreToolUse: [USER_PRE_TOOL] } }) });
    await config().writeHooks(fs, [], { harnessVersion: null });
    await config().deleteHooks(fs);
    expect(hooksIn(fs).PreToolUse).toEqual([USER_PRE_TOOL]);
    expect(hooksIn(fs).PostToolUse).toEqual([]);
  });

  it('the session channel object carries the same shape', () => {
    expect(nestedHooksObject(SPECS).PreToolUse).toEqual([
      { matcher: 'AskUserQuestion|ExitPlanMode', hooks: [{ type: 'command', command: WAIT }] },
    ]);
    expect(nestedHooksObject(SPECS).PostToolUse).toEqual([
      { hooks: [{ type: 'command', command: RESOLVED, async: true }] },
    ]);
  });

  it('flat and minimal formats refuse the nested-only options instead of dropping the filter', () => {
    expect(() => buildFlatJsonHookConfig('x.json', SPECS, 'gugu-managed')).toThrow(/matcher\/async on PreToolUse, PostToolUse/);
    expect(() => buildMinimalJsonHookConfig('x.json', SPECS, 'gugu-managed')).toThrow(/only the nested hook format/);
    expect(() => buildFlatJsonHookConfig('x.json', [SPECS[0]!], 'gugu-managed')).not.toThrow();
  });
});
