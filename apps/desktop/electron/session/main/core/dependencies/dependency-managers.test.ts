import { afterEach, describe, expect, it, vi } from 'vitest';
import { agentProgramsOf, CORE_DEPENDENCIES, type DependencyState } from '@gugu/session-core/deps/runtime';
import { listPlugins } from '../agents/plugin-registry';
import { getDependencyDescriptor } from './registry';
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

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

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

describe('offered dependency inventory', () => {
  it.each(['0', '1'])('uses the same offer gate as the list (unsupported=%s)', async (unsupported) => {
    vi.stubEnv('GUGU_SHOW_UNSUPPORTED_AGENTS', unsupported);
    vi.resetModules();
    const { localDependencyManager: manager, ensureAgentDependenciesProbed: ensureProbed } =
      await import('./dependency-managers');
    const states = new Map<string, DependencyState>();
    vi.spyOn(manager, 'get').mockImplementation((id) => states.get(id));
    const probe = vi.spyOn(manager, 'probe').mockImplementation(async (id, options) => {
      expect(options?.waitForInstallations).toBe(true);
      const state: DependencyState = {
        id, category: getDependencyDescriptor(id)!.category, status: 'missing',
        version: null, path: null, checkedAt: Date.now(),
      };
      states.set(id, state);
      return state;
    });
    const expected = [
      ...CORE_DEPENDENCIES.map((dependency) => dependency.id),
      ...listPlugins().flatMap((provider) => agentProgramsOf(provider).map((program) => program.dependencyId)),
    ];

    await ensureProbed(manager);
    expect(probe.mock.calls.map(([id]) => id)).toEqual(expected);
    expect(expected).toContain('antigravity-cli');
    expect(expected.includes('gemini')).toBe(unsupported === '1');
    expect(getDependencyDescriptor('gemini')).toBeDefined();
    expect(manager.getInstallOptions('gemini').length).toBeGreaterThan(0);

    await ensureProbed(manager);
    expect(probe).toHaveBeenCalledTimes(expected.length);
  });
});
