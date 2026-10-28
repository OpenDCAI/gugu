import { beforeEach, describe, expect, it, vi } from 'vitest';

const saved = vi.hoisted(() => ({ all: {} as Record<string, string[]> }));
vi.mock('@main/db/kv', () => ({
  KV: class {
    async getAll() { return saved.all; }
    async set(key: string, value: string[]) { saved.all[key] = value; }
  },
}));
vi.mock('@main/lib/logger', () => ({ log: { warn: vi.fn() } }));

const roots = await import('./harness-config-roots');

// 10-28 Linux 2: `claude` was a wrapper that sets CLAUDE_CONFIG_DIR in-process; the harness's own hook report is what counts.
describe('harness config roots learned from hooks', () => {
  beforeEach(() => {
    saved.all = {};
    roots.resetHarnessConfigRootsForTests();
  });

  it('a session knows the root its harness reported; the provider keeps it, newest first, and on disk', () => {
    expect(roots.harnessConfigRootOf('s1')).toBeUndefined();
    roots.learnHarnessConfigRoot({ sessionId: 's1', providerId: 'claude', root: '/a' });
    roots.learnHarnessConfigRoot({ sessionId: 's2', providerId: 'claude', root: '/b' });
    expect(roots.harnessConfigRootOf('s1')).toBe('/a');
    expect(roots.knownHarnessConfigRoots('claude')).toEqual(['/b', '/a']);
    expect(saved.all.claude).toEqual(['/b', '/a']);
    expect(roots.knownHarnessConfigRoots('codex')).toEqual([]);
  });

  it('roots remembered before a restart are known again once loaded', async () => {
    saved.all = { claude: ['/old'] };
    await roots.loadHarnessConfigRoots();
    expect(roots.knownHarnessConfigRoots('claude')).toEqual(['/old']);
  });
});
