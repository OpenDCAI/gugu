import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  manager: { platform: 'macos', probe: vi.fn(), isPathResolutionConsistent: vi.fn(), getHostDependency: vi.fn(), install: vi.fn() },
  ensureProbed: vi.fn(),
  buildPayload: vi.fn(),
}));

vi.mock('../dependencies/dependency-managers', () => ({
  getDependencyManager: async () => mocks.manager,
  ensureAgentDependenciesProbed: mocks.ensureProbed,
}));
vi.mock('./agent-payload-builder', () => ({
  buildAgentPayload: mocks.buildPayload,
  buildAgentIconMap: vi.fn(),
  buildAgentMetadataList: vi.fn(),
  buildManagementAgentPayloads: vi.fn(),
  buildAgentPayloads: vi.fn(),
  pluginInstallationStatus: vi.fn(),
  toAgentInstallationStatus: vi.fn(),
}));
vi.mock('@main/lib/events', () => ({ events: { emit: vi.fn() } }));
vi.mock('@main/core/sessions/impl/resolve-agent-executable', () => ({ clearResolvedPathCache: vi.fn() }));
vi.mock('./session-runtime-compatibility', () => ({ clearRuntimeVersionProbeCache: vi.fn() }));
vi.mock('../dependencies/agent-update-service', () => ({ agentUpdateService: { installSourceOrder: () => [] } }));
vi.mock('../dependencies/host-dependency-store', () => ({ hostDependencyStore: { setSelection: vi.fn() } }));
vi.mock('../settings/provider-settings-service', () => ({ providerOverrideSettings: {} }));
vi.mock('./harness-model-catalog', () => ({ lookupHarnessModelCatalog: vi.fn() }));
vi.mock('./harness-model-catalog-wiring', () => ({ wireHarnessModelCatalog: vi.fn() }));

import { agentsController } from './controller';
import { hasAgentInstallsInProgress } from './install-progress-ledger';

beforeEach(() => {
  vi.resetAllMocks();
  mocks.manager.isPathResolutionConsistent.mockResolvedValue(false);
});

describe('single registered harness queries', () => {
  it.each(['success', 'failure', 'throw', 'cancel'] as const)('releases installation activity on %s', async outcome => {
    const pending = Promise.withResolvers<{ success: boolean; error?: { type: 'cancelled' } }>();
    mocks.manager.install.mockReturnValue(pending.promise);
    const installing = agentsController.install('claude');
    const settled = installing.catch(error => error);
    await vi.waitFor(() => expect(mocks.manager.install).toHaveBeenCalled());
    expect(hasAgentInstallsInProgress()).toBe(true);
    if (outcome === 'throw') pending.reject(new Error('download failed'));
    else {
      if (outcome === 'cancel') await agentsController.cancelInstall('claude');
      pending.resolve(outcome === 'success' ? { success: true } : { success: false, error: { type: 'cancelled' } });
    }
    await settled;
    expect(hasAgentInstallsInProgress()).toBe(false);
  });
  it('waits for a withheld harness probe before building its installation payload', async () => {
    const probe = Promise.withResolvers<void>();
    mocks.manager.probe.mockReturnValue(probe.promise);
    mocks.buildPayload.mockResolvedValue({ id: 'gemini', status: 'available' });

    const result = agentsController.get('gemini');
    await vi.waitFor(() => expect(mocks.manager.probe).toHaveBeenCalledWith(
      'gemini', { waitForInstallations: true },
    ));
    expect(mocks.buildPayload).not.toHaveBeenCalled();
    probe.resolve();
    await expect(result).resolves.toMatchObject({ id: 'gemini', status: 'available' });
  });

  it('reuses the shared inventory for an offered harness', async () => {
    await agentsController.get('claude');
    expect(mocks.ensureProbed).toHaveBeenCalledWith(mocks.manager);
    expect(mocks.manager.probe).not.toHaveBeenCalled();
    expect(mocks.buildPayload).toHaveBeenCalledWith('claude', 'macos', mocks.manager, expect.any(Function));
  });

  it('does not repeat a consistent withheld probe when status events refetch the row', async () => {
    mocks.manager.isPathResolutionConsistent.mockResolvedValueOnce(false).mockResolvedValue(true);
    await agentsController.get('gemini');
    await agentsController.get('gemini');
    expect(mocks.manager.probe).toHaveBeenCalledTimes(1);
  });
});
