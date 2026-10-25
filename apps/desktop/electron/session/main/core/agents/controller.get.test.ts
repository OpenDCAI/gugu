import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  manager: { platform: 'macos', probe: vi.fn(), isPathResolutionConsistent: vi.fn() },
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
vi.mock('../dependencies/agent-update-service', () => ({ agentUpdateService: {} }));
vi.mock('../dependencies/host-dependency-store', () => ({ hostDependencyStore: {} }));
vi.mock('../settings/provider-settings-service', () => ({ providerOverrideSettings: {} }));
vi.mock('./harness-model-catalog', () => ({ lookupHarnessModelCatalog: vi.fn() }));
vi.mock('./harness-model-catalog-wiring', () => ({ wireHarnessModelCatalog: vi.fn() }));

import { agentsController } from './controller';

beforeEach(() => {
  vi.resetAllMocks();
  mocks.manager.isPathResolutionConsistent.mockResolvedValue(false);
});

describe('single registered harness queries', () => {
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
