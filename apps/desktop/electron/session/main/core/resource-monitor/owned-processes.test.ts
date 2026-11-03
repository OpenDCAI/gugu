import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { collectLedgerResourceRoots } from './owned-processes';

afterEach(() => vi.unstubAllEnvs());
describe('resource ownership ledger', () => {
  it('counts an owned reparented engine but rejects foreign owners, reused PIDs and exited engines', async () => {
    const home = mkdtempSync(join(tmpdir(), 'resource-ownership-'));
    vi.stubEnv('GUGU_HOME', home);
    mkdirSync(join(home, 'engine-pids'));
    try {
      const record = { ownerMainPid: process.pid, engineId: 'codex-app-server', agentUserId: 'agent', conversationId: 'session', args: ['app-server', '--listen', 'unix:///owned-endpoint'] };
      for (const [name, fields] of Object.entries({
        owned: { pgid: 10 }, foreign: { pgid: 11, ownerMainPid: process.pid + 1 },
        reused: { pgid: 12 }, exited: { pgid: 13 },
      })) writeFileSync(join(home, 'engine-pids', name + '.json'), JSON.stringify({ ...record, ...fields }));
      const roots = await collectLedgerResourceRoots([
        { pid: 10, ppid: 1, name: 'codex', command: 'codex app-server --listen unix:///owned-endpoint' },
        { pid: 11, ppid: 1, name: 'codex', command: 'codex app-server --listen unix:///owned-endpoint' },
        { pid: 12, ppid: 1, name: 'other', command: 'codex app-server --listen unix:///different-endpoint' },
      ]);
      expect(roots.map(r => [r.pid, r.sessionId])).toEqual([[10, 'session']]);
    } finally { rmSync(home, { recursive: true, force: true }); }
  });
});
