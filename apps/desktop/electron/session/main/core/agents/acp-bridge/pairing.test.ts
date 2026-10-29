import { describe, expect, it } from 'vitest';
import {
  COMPAT_RECHECK_MS,
  compareVersions,
  highestKnownCli,
  newerCompat,
  parseCliVersion,
  parseCompat,
  pickRelease,
  shouldRefreshCompat,
  type CompatBridge,
} from './pairing';

// The table as @gugu-acp/compat 1.0.2 published it (gugu-acp compat.json after the first follow run).
const bridge: CompatBridge = {
  package: '@gugu-acp/claude-agent-acp',
  cli: 'claude',
  releases: [
    { version: '1.0.0', upstreamTag: 'v0.81.1', cliFrom: '2.1.278', verified: [{ cli: '2.1.278' }, { cli: '2.1.281' }] },
    { version: '1.1.0', upstreamTag: 'v0.81.2', cliFrom: '2.1.282', verified: [{ cli: '2.1.282' }] },
  ],
};

describe('bridge pairing (#6394)', () => {
  it('reads the version out of `claude --version`', () => {
    expect(parseCliVersion('2.1.282 (Claude Code)\n')).toBe('2.1.282');
    expect(parseCliVersion('command not found')).toBeNull();
  });

  it('a wrapper (wcc) prints a banner with a version of its own first: the version is read off claude\'s own line', () => {
    const wrapped = 'wcc: independent env -> /tmp/wcc-env\n启动中：网络通过座位转发 1.2.74\n2.1.212 (Claude Code)\n';
    expect(parseCliVersion(wrapped, /\(Claude Code\)\s*$/)).toBe('2.1.212');
    // [control] without its line declared, the first version as before.
    expect(parseCliVersion(wrapped)).toBe('1.2.74');
  });

  it('compares versions numerically, not as strings', () => {
    expect(compareVersions('2.1.282', '2.1.99')).toBeGreaterThan(0);
    expect(compareVersions('2.10.0', '2.9.9')).toBeGreaterThan(0);
    expect(compareVersions('2.1.281', '2.1.281')).toBe(0);
  });

  it('picks the one release whose range holds the CLI version (ranges do not overlap)', () => {
    expect(pickRelease(bridge, '2.1.278').release.version).toBe('1.0.0');
    expect(pickRelease(bridge, '2.1.281').release.version).toBe('1.0.0');
    expect(pickRelease(bridge, '2.1.282').release.version).toBe('1.1.0');
    // The newest release has no upper bound.
    expect(pickRelease(bridge, '2.1.400')).toEqual({ release: bridge.releases[1], reason: 'in-range' });
  });

  it('says so when the CLI is older than every release', () => {
    expect(pickRelease(bridge, '2.1.257')).toEqual({ release: bridge.releases[0], reason: 'below-lowest' });
  });

  it('does not depend on the order releases are listed in', () => {
    const reversed = { ...bridge, releases: [...bridge.releases].reverse() };
    expect(pickRelease(reversed, '2.1.279').release.version).toBe('1.0.0');
    expect(pickRelease(reversed, '2.1.300').release.version).toBe('1.1.0');
  });

  it('knows up to the highest cliFrom or verified version in the table', () => {
    expect(highestKnownCli(bridge)).toBe('2.1.282');
  });

  it('only goes online when the CLI is newer than anything the table knows', () => {
    const now = 1_000_000;
    // Inside what the table already covers: no network, even with no previous check.
    expect(shouldRefreshCompat({ bridge, cliVersion: '2.1.281', lastCheck: null, now })).toBe(false);
    expect(shouldRefreshCompat({ bridge, cliVersion: '2.1.282', lastCheck: null, now })).toBe(false);
    // Newer than the table: check once...
    expect(shouldRefreshCompat({ bridge, cliVersion: '2.1.283', lastCheck: null, now })).toBe(true);
    // ...and not again for the same version within the window...
    expect(shouldRefreshCompat({ bridge, cliVersion: '2.1.283', lastCheck: { cli: '2.1.283', at: now }, now: now + 1 })).toBe(false);
    // ...but again after it, or for a different version.
    expect(shouldRefreshCompat({ bridge, cliVersion: '2.1.283', lastCheck: { cli: '2.1.283', at: now }, now: now + COMPAT_RECHECK_MS })).toBe(true);
    expect(shouldRefreshCompat({ bridge, cliVersion: '2.1.284', lastCheck: { cli: '2.1.283', at: now }, now: now + 1 })).toBe(true);
  });

  it('keeps the newer of two tables by compat package version', () => {
    const table = parseCompat({ schema: 1, bridges: { 'claude-agent-acp': bridge } });
    const a = { compatVersion: '1.0.2', table };
    const b = { compatVersion: '1.0.10', table };
    expect(newerCompat(a, b)).toBe(b);
    expect(newerCompat(b, a)).toBe(b);
    expect(newerCompat(null, a)).toBe(a);
  });

  it('rejects a table it cannot read instead of treating it as empty', () => {
    expect(() => parseCompat({ schema: 2, bridges: {} })).toThrow();
    expect(() => parseCompat({ schema: 1, bridges: { 'claude-agent-acp': { ...bridge, releases: [] } } })).toThrow();
  });
});
