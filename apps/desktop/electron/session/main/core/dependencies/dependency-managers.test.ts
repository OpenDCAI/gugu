import { afterEach, describe, expect, it, vi } from 'vitest';
import { ensureAgentDependenciesProbed, localDependencyManager } from './dependency-managers';

vi.mock('@main/core/sessions/impl/resolve-agent-executable', () => ({ clearResolvedPathCache: vi.fn() }));
vi.mock('@main/core/agents/session-runtime-compatibility', () => ({ clearRuntimeVersionProbeCache: vi.fn() }));
vi.mock('@main/core/agents/agent-run-context', () => ({ resolveLocalAgentSpawnEnv: vi.fn() }));
vi.mock('@main/core/execution-context/local-execution-context', () => ({ LocalExecutionContext: vi.fn() }));
vi.mock('@main/core/utils/exec', () => ({ setGitExecutableOverride: vi.fn() }));
vi.mock('@main/lib/logger', () => ({ log: {} }));
vi.mock('./agent-update-service', () => ({ agentUpdateService: { attach: vi.fn() } }));
vi.mock('./host-dependency-ledger', () => ({
  hostDependencyLedgerFor: vi.fn(),
  localManagedInstallDirs: () => ({}),
}));
vi.mock('./install-runner', () => ({ createLocalInstallCommandRunner: vi.fn() }));
vi.mock('./mise-installer', () => ({ readManagedLauncherRelease: vi.fn() }));
vi.mock('@main/utils/userEnv', () => ({ ensureUserBinDirsInPath: vi.fn() }));

afterEach(() => vi.restoreAllMocks());

describe('shared initial dependency inventory', () => {
  it('joins one core-inclusive inventory and releases it for subsequent discovery', async () => {
    const inventory = Promise.withResolvers<void>();
    const probeAll = vi.spyOn(localDependencyManager, 'probeAll').mockReturnValue(inventory.promise);
    const probeCategory = vi.spyOn(localDependencyManager, 'probeCategory');

    const startup = ensureAgentDependenciesProbed(localDependencyManager);
    const firstList = ensureAgentDependenciesProbed(localDependencyManager);
    expect(probeAll).toHaveBeenCalledTimes(1);
    expect(probeCategory).not.toHaveBeenCalled();

    inventory.resolve();
    await Promise.all([startup, firstList]);
    await ensureAgentDependenciesProbed(localDependencyManager);
    expect(probeAll).toHaveBeenCalledTimes(2);
  });

  it('releases a failed inventory so a later request can retry', async () => {
    const probeAll = vi.spyOn(localDependencyManager, 'probeAll')
      .mockRejectedValueOnce(new Error('inventory failed'))
      .mockResolvedValueOnce();

    await expect(ensureAgentDependenciesProbed(localDependencyManager)).rejects.toThrow('inventory failed');
    await ensureAgentDependenciesProbed(localDependencyManager);
    expect(probeAll).toHaveBeenCalledTimes(2);
  });
});
