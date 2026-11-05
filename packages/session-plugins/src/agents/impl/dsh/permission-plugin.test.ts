import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import { DSH_PERMISSION_PLUGIN_SOURCE } from './permission-plugin';

// The source runs inside dsh, loaded by its Cordis loader from the file the materializer writes; load it the same way.
const dir = mkdtempSync(join(tmpdir(), 'dsh-permission-plugin-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));
const file = join(dir, 'gugu-permission.mjs');
writeFileSync(file, DSH_PERMISSION_PLUGIN_SOURCE);
const plugin = await import(/* @vite-ignore */ pathToFileURL(file).href) as {
  name: string; inject: string[]; apply: (ctx: unknown, config: unknown) => void;
};

type Session = { id: string; preset: string };
function fakeDsh(options: { sessions?: Session[]; service?: 'ok' | 'missing' | 'ignores-set' } = {}) {
  const listeners: Array<(event: { agent: { session: Session } }) => void> = [];
  const calls: string[] = [];
  const service = options.service === 'missing' ? undefined : {
    current: (session: Session) => session.preset,
    set: (session: Session, preset: string) => {
      calls.push(`${session.id}:${preset}`);
      if (options.service !== 'ignores-set') session.preset = preset;
    },
  };
  const ctx = {
    get: (name: string) => (name === 'permissionPresets' ? service : undefined),
    on: (event: string, listener: (event: { agent: { session: Session } }) => void) => {
      expect(event).toBe('agent/created');
      listeners.push(listener);
    },
    agents: { list: () => (options.sessions ?? []).map((session) => ({ session })) },
  };
  return { ctx, calls, created: (session: Session) => listeners.forEach((listener) => listener({ agent: { session } })) };
}

describe('the permission plugin Gugu loads into DeepSeek Harness', () => {
  it('is a Cordis plugin that waits only for the agents service', () => {
    expect(plugin.name).toBe('gugu-permission');
    expect(plugin.inject).toEqual(['agents']);
  });

  it('sets the preset on the session of every created agent — fresh or resumed — through permissionPresets.set', () => {
    const dsh = fakeDsh();
    plugin.apply(dsh.ctx, { preset: 'danger-full-access' });
    const resumed = { id: 'resumed', preset: 'read-only' };
    dsh.created(resumed);
    expect(resumed.preset).toBe('danger-full-access');
    expect(dsh.calls).toEqual(['resumed:danger-full-access']);
  });

  it('also covers agents created before it loaded, and leaves a matching preset alone', () => {
    const early = { id: 'early', preset: 'workspace-write' };
    const same = { id: 'same', preset: 'read-only' };
    const dsh = fakeDsh({ sessions: [early, same] });
    plugin.apply(dsh.ctx, { preset: 'read-only' });
    expect(early.preset).toBe('read-only');
    expect(dsh.calls).toEqual(['early:read-only']);
  });

  it('fails the session loudly when this dsh build has no permissionPresets service', () => {
    const dsh = fakeDsh({ service: 'missing' });
    plugin.apply(dsh.ctx, { preset: 'read-only' });
    expect(() => dsh.created({ id: 's', preset: 'workspace-write' })).toThrow(/no permissionPresets\.set/);
  });

  it('fails loudly when the preset did not take effect', () => {
    const dsh = fakeDsh({ service: 'ignores-set' });
    plugin.apply(dsh.ctx, { preset: 'read-only' });
    expect(() => dsh.created({ id: 's', preset: 'workspace-write' })).toThrow(/did not take effect/);
  });

  it('refuses to load without a preset', () => {
    expect(() => plugin.apply(fakeDsh().ctx, {})).toThrow(/config\.preset is required/);
  });
});
