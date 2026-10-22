import { beforeEach, describe, expect, it, vi } from 'vitest';
import { awaitPending } from '../../../../../../../../tests/support/awaitFact';
import { cachedBridgeEntry, resolveClaudeBridgeEntry, type ClaudeBridgeDeps } from './claude-bridge';
import type { CompatCheck, VersionedCompat } from './pairing';

vi.mock('../../../../../lib/logger', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

const PKG = '@gugu-acp/claude-agent-acp';
// Downloads and table checks are shared per cache directory, module-wide. A fresh directory per case keeps
// one case's unfinished download (a failing case never releases it) from being joined by the next case.
let CACHE = '';
let caseNo = 0;
beforeEach(() => {
  caseNo += 1;
  CACHE = `/cache/${caseNo}/acp-bridges`;
});

function table(releases: Array<{ version: string; cliFrom: string; verified?: string[] }>, compatVersion: string): VersionedCompat {
  return {
    compatVersion,
    table: {
      schema: 1,
      bridges: {
        'claude-agent-acp-v2': {
          package: PKG,
          cli: 'claude',
          releases: releases.map((r) => ({ version: r.version, protocolVersion: 2, cliFrom: r.cliFrom, verified: (r.verified ?? [r.cliFrom]).map((cli) => ({ cli })) })),
        },
      },
    },
  };
}

// What an installer built today carries: bridge 1.0.0 and compat 1.0.2 (1.0.0 from 2.1.278, 1.1.0 from 2.1.282).
const BUNDLED = table([
  { version: '1.0.0', cliFrom: '2.1.278', verified: ['2.1.278', '2.1.281'] },
  { version: '1.1.0', cliFrom: '2.1.282' },
], '1.0.2');

function fakeDeps(over: Partial<ClaudeBridgeDeps> & { cli?: string | null; cache?: { compat: VersionedCompat | null; lastCheck: CompatCheck | null }; files?: Set<string> } = {}) {
  const files = over.files ?? new Set<string>();
  const writes: Array<{ compat: VersionedCompat | null; lastCheck: CompatCheck | null }> = [];
  const deps: ClaudeBridgeDeps = {
    probeCliVersion: over.probeCliVersion ?? (async () => (over.cli === undefined ? '2.1.281' : over.cli)),
    readBundled: over.readBundled ?? (() => ({ bridgeVersion: '1.0.0', protocolVersion: 2, compat: BUNDLED })),
    fetchLatestCompat: over.fetchLatestCompat ?? vi.fn(async () => { throw new Error('offline'); }),
    readCache: over.readCache ?? (() => over.cache ?? { compat: null, lastCheck: null }),
    writeCache: over.writeCache ?? ((_dir, data) => { writes.push(data); }),
    installBridge: over.installBridge ?? vi.fn(async (_spec: string, dest: string) => {
      files.add(`${dest}/node_modules/@gugu-acp/claude-agent-acp/dist/index.js`.replace(/\\/g, '/'));
    }),
    exists: over.exists ?? ((p) => files.has(p.replace(/\\/g, '/'))),
    now: over.now ?? (() => 1_000),
  };
  return { deps, writes, files };
}

/** fakeDeps whose cache write — the background compat check's last step — is also a promise the case can await. */
function recordingDeps(over: Parameters<typeof fakeDeps>[0]) {
  const written = Promise.withResolvers<void>();
  const writes: Array<{ compat: VersionedCompat | null; lastCheck: CompatCheck | null }> = [];
  const fake = fakeDeps({
    ...over,
    writeCache: (_dir, data) => {
      writes.push(data);
      written.resolve();
    },
  });
  return { ...fake, writes, recorded: written.promise };
}

const waiter = () => ({ onWaiting: vi.fn<(bridge: string) => void>(), onSettled: vi.fn<() => void>() });
type Wait = ReturnType<typeof waiter>;
/** A real session start: waits for a paired bridge that is still downloading. */
const resolve = (deps: ClaudeBridgeDeps, wait: Wait = waiter()) =>
  resolveClaudeBridgeEntry({ cliPath: '/usr/local/bin/claude', env: {}, cacheDir: CACHE, deps, wait });
/** A model-catalog probe uses the same protocol-strict selection. */
const probe = (deps: ClaudeBridgeDeps) => resolveClaudeBridgeEntry({ cliPath: '/usr/local/bin/claude', env: {}, cacheDir: CACHE, deps });
const entryOf = (version: string) => cachedBridgeEntry(CACHE, PKG, version);

describe('claude bridge pairing at session start (#6394)', () => {
  it('uses the bundled bridge when the table puts the CLI in its range, without going online or reporting a wait', async () => {
    const { deps } = fakeDeps({ cli: '2.1.281' });
    const wait = waiter();
    await expect(resolve(deps, wait)).resolves.toBeUndefined();
    expect(deps.fetchLatestCompat).not.toHaveBeenCalled();
    expect(deps.installBridge).not.toHaveBeenCalled();
    expect(wait.onWaiting).not.toHaveBeenCalled();
  });

  it('a session downloads the release that serves a newer CLI, reporting the wait while it does', async () => {
    const { deps } = fakeDeps({ cli: '2.1.282' });
    const wait = waiter();
    await expect(resolve(deps, wait)).resolves.toBe(entryOf('1.1.0'));
    expect(deps.installBridge).toHaveBeenCalledWith(`${PKG}@1.1.0`, expect.stringContaining('claude-agent-acp-v2@1.1.0'), {});
    expect(wait.onWaiting).toHaveBeenCalledWith(`${PKG}@1.1.0`);
    expect(wait.onSettled).toHaveBeenCalledTimes(1);
    expect(deps.fetchLatestCompat).not.toHaveBeenCalled(); // 2.1.282 is already in the bundled table
  });

  it('reuses a cached download instead of installing again, with no wait step', async () => {
    const files = new Set([entryOf('1.1.0').replace(/\\/g, '/')]);
    const { deps } = fakeDeps({ cli: '2.1.290', files, cache: { compat: null, lastCheck: { cli: '2.1.290', at: 1_000 } } });
    const wait = waiter();
    await expect(resolve(deps, wait)).resolves.toBe(entryOf('1.1.0'));
    expect(deps.installBridge).not.toHaveBeenCalled();
    expect(wait.onWaiting).not.toHaveBeenCalled();
  });

  it('a probe and a session await the same selected v2 bridge installation', async () => {
    let release!: () => void;
    const files = new Set<string>();
    const installBridge = vi.fn((_spec: string, dest: string) => new Promise<void>((done) => {
      release = () => { files.add(`${dest}/node_modules/@gugu-acp/claude-agent-acp/dist/index.js`.replace(/\\/g, '/')); done(); };
    }));
    const { deps } = fakeDeps({ cli: '2.1.283', installBridge, files, cache: { compat: null, lastCheck: { cli: '2.1.283', at: 1_000 } } });
    const probing = probe(deps);
    await vi.waitFor(() => expect(installBridge).toHaveBeenCalledTimes(1));
    const wait = waiter();
    const waiting = Promise.withResolvers<void>();
    wait.onWaiting.mockImplementationOnce(() => waiting.resolve());
    const session = resolve(deps, wait);
    await waiting.promise;
    expect(wait.onWaiting).toHaveBeenCalledWith(`${PKG}@1.1.0`);
    expect(wait.onSettled).not.toHaveBeenCalled();
    release();
    await expect(Promise.all([probing, session])).resolves.toEqual([entryOf('1.1.0'), entryOf('1.1.0')]);
    expect(wait.onSettled).toHaveBeenCalledTimes(1);
    expect(installBridge).toHaveBeenCalledTimes(1);
  });

  it('never waits on the table: a CLI newer than everything known runs on the newest release while npm is asked in the background', async () => {
    let answer!: (compat: VersionedCompat) => void;
    const fetchLatestCompat = vi.fn(() => new Promise<VersionedCompat>((done) => { answer = done; }));
    const { deps, writes, recorded } = recordingDeps({ cli: '2.1.291', fetchLatestCompat });
    // The table is never answered before the session resolves. A resolver that waits on it hangs right here —
    // no wall-clock cap (a cap only turns a slow machine red); the heartbeat names this step while it hangs.
    await expect(awaitPending('session resolves while the compat check is still in flight', resolve(deps)))
      .resolves.toBe(entryOf('1.1.0')); // newest known release, open-ended
    expect(fetchLatestCompat).toHaveBeenCalledTimes(1);
    expect(writes).toEqual([]);
    const latest = table([
      { version: '1.0.0', cliFrom: '2.1.278' },
      { version: '1.1.0', cliFrom: '2.1.282' },
      { version: '1.2.0', cliFrom: '2.1.290' },
    ], '1.0.5');
    answer(latest);
    await recorded;
    expect(writes).toEqual([{ compat: latest, lastCheck: { cli: '2.1.291', at: 1_000 } }]);
  });

  it('the next session picks up a newer release that the background check found', async () => {
    const cached = table([
      { version: '1.0.0', cliFrom: '2.1.278' },
      { version: '1.2.0', cliFrom: '2.1.290' },
    ], '1.0.5');
    const fetchLatestCompat = vi.fn(async () => cached);
    const { deps } = fakeDeps({ cli: '2.1.291', fetchLatestCompat, cache: { compat: cached, lastCheck: { cli: '2.1.291', at: 900 } } });
    await expect(resolve(deps)).resolves.toBe(entryOf('1.2.0'));
    expect(fetchLatestCompat).not.toHaveBeenCalled(); // checked for this version already
  });

  it('fails loudly when the selected v2 bridge cannot be downloaded and ends the wait', async () => {
    const installBridge = vi.fn(async () => { throw new Error('ENOTFOUND registry.npmjs.org'); });
    const { deps } = fakeDeps({ cli: '2.1.282', installBridge });
    const wait = waiter();
    await expect(resolve(deps, wait)).rejects.toThrow('ENOTFOUND');
    expect(installBridge).toHaveBeenCalledTimes(1);
    expect(wait.onSettled).toHaveBeenCalledTimes(1);
  });

  it('still records the check when going online fails, so it does not retry every session', async () => {
    const { deps, writes, recorded } = recordingDeps({ cli: '2.1.300' }); // default fetch throws "offline"
    await expect(resolve(deps)).resolves.toBe(entryOf('1.1.0'));
    await recorded;
    expect(writes).toEqual([{ compat: null, lastCheck: { cli: '2.1.300', at: 1_000 } }]);
  });

  it('fails loudly when the CLI version cannot be read', async () => {
    const { deps } = fakeDeps({ cli: null });
    await expect(resolve(deps)).rejects.toThrow('Could not read');
    expect(deps.installBridge).not.toHaveBeenCalled();
  });

  it('shares one download between sessions that start at the same time', async () => {
    let release!: () => void;
    const installing = Promise.withResolvers<void>();
    const files = new Set<string>();
    const installBridge = vi.fn((_spec: string, dest: string) => new Promise<void>((done) => {
      release = () => { files.add(`${dest}/node_modules/@gugu-acp/claude-agent-acp/dist/index.js`.replace(/\\/g, '/')); done(); };
      installing.resolve();
    }));
    const { deps } = fakeDeps({ cli: '2.1.282', installBridge, files });
    const a = resolve(deps);
    const b = resolve(deps);
    await installing.promise;
    expect(installBridge).toHaveBeenCalledTimes(1);
    release();
    await expect(Promise.all([a, b])).resolves.toEqual([entryOf('1.1.0'), entryOf('1.1.0')]);
    expect(installBridge).toHaveBeenCalledTimes(1);
  });
});

it('fails instead of choosing a v1 bridge when the new key contains no v2 releases', async () => {
  const legacy = structuredClone(BUNDLED);
  for (const release of legacy.table.bridges['claude-agent-acp-v2'].releases) release.protocolVersion = 1;
  const { deps } = fakeDeps({
    cli: '2.1.282',
    readBundled: () => ({ bridgeVersion: '2.0.0', protocolVersion: 2, compat: legacy }),
    files: new Set([entryOf('1.1.0')]),
  });
  await expect(resolve(deps)).rejects.toThrow('no ACP v2');
  expect(deps.installBridge).not.toHaveBeenCalled();
});

it('pairs only releases with the same protocol even when the CLI falls in a newer v1 range', async () => {
  const compat = table([{ version: '2.0.0', cliFrom: '2.1.278' }, { version: '3.0.0', cliFrom: '2.1.282' }], '1.0.99');
  compat.table.bridges['claude-agent-acp-v2'].releases[0].protocolVersion = 2;
  compat.table.bridges['claude-agent-acp-v2'].releases[1].protocolVersion = 1;
  const { deps } = fakeDeps({ cli: '2.1.282', readBundled: () => ({ bridgeVersion: '2.0.0', protocolVersion: 2, compat }) });
  await expect(resolve(deps)).resolves.toBeUndefined();
  expect(deps.installBridge).not.toHaveBeenCalled();
});

it('rejects a legacy-only compatibility table even when bundled and cached bridges exist', async () => {
  const legacy = structuredClone(BUNDLED);
  legacy.table.bridges['claude-agent-acp'] = legacy.table.bridges['claude-agent-acp-v2'];
  delete legacy.table.bridges['claude-agent-acp-v2'];
  const { deps } = fakeDeps({
    readBundled: () => ({ bridgeVersion: '2.0.0', protocolVersion: 2, compat: legacy }),
    files: new Set([entryOf('1.1.0')]),
  });
  await expect(resolve(deps)).rejects.toThrow('compatibility table has no Claude bridge');
  expect(deps.installBridge).not.toHaveBeenCalled();
});

it('rejects a bundled bridge without its explicit v2 declaration', async () => {
  const { deps } = fakeDeps({ readBundled: () => ({ bridgeVersion: '1.0.0', compat: BUNDLED }) });
  await expect(resolve(deps)).rejects.toThrow('does not declare ACP v2');
  expect(deps.installBridge).not.toHaveBeenCalled();
});
