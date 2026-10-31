import { dirname, join } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { locateSessionRecord } from '../session-timeline/locate';

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
describe('harness config roots learned from what the harness reports', () => {
  beforeEach(() => {
    saved.all = {};
    roots.resetHarnessConfigRootsForTests();
  });

  const report = (root: string) => ({ transcript_path: `${root}/projects/-work/abc.jsonl` });

  it('a session knows the root its harness reported; the provider keeps it, newest first, and on disk', () => {
    expect(roots.harnessConfigRootOf('s1')).toBeUndefined();
    roots.learnHarnessConfigRoot({ sessionId: 's1', providerId: 'claude', report: report('/a') });
    roots.learnHarnessConfigRoot({ sessionId: 's2', providerId: 'claude', report: report('/b') });
    expect(roots.harnessConfigRootOf('s1')).toBe('/a');
    expect(roots.knownHarnessConfigRoots('claude')).toEqual(['/b', '/a']);
    expect(saved.all.claude).toEqual(['/b', '/a']);
    expect(roots.knownHarnessConfigRoots('codex')).toEqual([]);
  });

  it('a report that names no config root, or a harness that reports none, learns nothing', () => {
    roots.learnHarnessConfigRoot({ sessionId: 's1', providerId: 'claude', report: { transcript_path: '/a/not-a-record.txt' } });
    roots.learnHarnessConfigRoot({ sessionId: 's1', providerId: 'claude', report: {} });
    expect(roots.harnessConfigRootOf('s1')).toBeUndefined();
    expect(roots.knownHarnessConfigRoots('claude')).toEqual([]);
  });

  // Terminal hooks and the chat-panel bridge hand in the same `transcript_path`; either way the record resolves under it.
  it('a record under a wrapper-set config dir is located once its transcript path was reported', () => {
    const transcriptPath = '/home/u/wrapped-claude-config/projects/-work/0b6f-session.jsonl';
    const locate = () => {
      const location = locateSessionRecord({
        provider: 'claude',
        providerSessionId: '0b6f-session',
        env: {},
        homeDir: '/home/u',
        fallbackConfigRoots: roots.knownHarnessConfigRoots('claude'),
      });
      if (!location.supported) throw new Error(location.reason);
      return location.locator.roots;
    };
    expect(locate()).not.toContain(dirname(dirname(transcriptPath)));
    roots.learnHarnessConfigRoot({ sessionId: 's1', providerId: 'claude', report: { transcript_path: transcriptPath } });
    expect(roots.harnessConfigRootOf('s1')).toBe('/home/u/wrapped-claude-config');
    expect(locate().map((root) => join(root, '-work', '0b6f-session.jsonl'))).toContain(transcriptPath);
  });

  it('roots remembered before a restart are known again once loaded', async () => {
    saved.all = { claude: ['/old'] };
    await roots.loadHarnessConfigRoots();
    expect(roots.knownHarnessConfigRoots('claude')).toEqual(['/old']);
  });
});
