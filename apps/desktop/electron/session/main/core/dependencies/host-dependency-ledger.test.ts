import { beforeEach, expect, it, vi } from 'vitest';
import { createReplicaLedger } from '@gugu/session-core/deps/runtime';

const mocks = vi.hoisted(() => ({ env: vi.fn(), selection: vi.fn(async () => ({ kind: 'auto' })) }));
vi.mock('@main/core/agents/agent-run-context', () => ({ resolveLocalAgentSpawnEnv: mocks.env }));
vi.mock('./host-dependency-store', () => ({ hostDependencyStore: {
  getSelection: mocks.selection, getInstallRecord: async () => null, getLastCustom: async () => null,
} }));
vi.mock('./managed-agent-home', () => ({ managedAgentBinDir: () => '/bin', managedAgentNpmRoot: () => '/npm', managedMiseBinDir: () => '/mise' }));
vi.mock('./registry', () => ({ AGENT_DEPENDENCIES: [{ id: 'antigravity' }, { id: 'claude' }, { id: 'antigravity-cli', ownerId: 'antigravity' }] }));
beforeEach(() => { mocks.env.mockReset(); });

it('keeps healthy entries readable, reports only the failed provider and its companion, then recovers on refresh', async () => {
  let broken = true;
  mocks.env.mockImplementation(async (id: string) => {
    if (id === 'antigravity' && broken) throw new Error('copy EACCES');
    return { CONFIG_HOME: '/managed/' + id };
  });
  const { buildHostDependencyLedgerSnapshot } = await import('./host-dependency-ledger');
  const snapshot = await buildHostDependencyLedgerSnapshot('macos');
  expect(snapshot.entries).toHaveLength(3);
  expect(snapshot.entries[0]?.probeError).toBe('antigravity: copy EACCES');
  expect(snapshot.entries[2]?.probeError).toBe('antigravity: copy EACCES');
  const replica = createReplicaLedger(); replica.apply(snapshot);
  expect(replica.probeEnvFor('claude')).toEqual({ CONFIG_HOME: '/managed/claude' });
  expect(() => replica.probeEnvFor('antigravity')).toThrow('antigravity: copy EACCES');
  expect(await replica.getSelection('claude')).toEqual({ kind: 'auto' });
  broken = false; replica.apply(await buildHostDependencyLedgerSnapshot('macos'));
  expect(replica.probeEnvFor('antigravity')).toEqual({ CONFIG_HOME: '/managed/antigravity' });
});
