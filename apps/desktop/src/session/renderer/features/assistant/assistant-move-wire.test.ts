import { beforeEach, describe, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ setStatus: vi.fn(), identities: vi.fn(), openMachine: vi.fn(), rpc: vi.fn() }));
vi.mock('@/lib/contacts', () => ({ contactsService: { setAgentDesiredStatus: mocks.setStatus } }));
vi.mock('@/lib/identityReadAdapter', () => ({ readDisplayIdentities: mocks.identities }));
vi.mock('@/lib/assistantSetup', () => ({ assistantResumeStore: {} }));
vi.mock('@/lib/agentProvision', () => ({ completedSingleProvisionSession: vi.fn(), provisionSingleAgent: vi.fn() }));
vi.mock('@/lib/agentModelSelection', () => ({ readAgentModelSelection: vi.fn(), setAgentModelSelection: vi.fn(), platformProtocolForAgentType: vi.fn() }));
vi.mock('@/lib/cloudComputerStore', () => ({ getCloudComputerState: vi.fn(), provisionCloudComputer: vi.fn(), refreshCloudComputer: vi.fn(), wakeCloudComputer: vi.fn() }));
vi.mock('@/lib/myAssistant', () => ({ reloadMyAssistant: vi.fn() }));
vi.mock('@renderer/features/remote-hosts/remote-hosts-store', () => ({ remoteHostsStore: { connectionState: () => 'connected' } }));
vi.mock('@renderer/lib/ipc', () => ({ rpcOn: mocks.rpc }));
vi.mock('@renderer/lib/stores/app-state', () => ({ appState: {} }));
vi.mock('./assistant-machine', () => ({ openAssistantMachine: mocks.openMachine }));
import { machineFs, openSource, restartAssistant } from './assistant-move-wire';
import type { AssistantMachine } from './assistant-machine-core';
beforeEach(() => { vi.resetAllMocks(); });

describe('move restart desired status handoff', () => {
  it('rejects when offline commits and the online request fails', async () => {
    let desired = 'online';
    mocks.setStatus.mockImplementation(async (_id, status) => {
      if (status === 'online') throw new Error('network lost');
      desired = status;
    });
    await expect(restartAssistant('agent')).rejects.toThrow('network lost');
    expect(desired).toBe('offline');
    expect(mocks.setStatus.mock.calls.map(args => args[1])).toEqual(['offline', 'online']);
  });
  it('attempts online restoration even if the offline response was lost', async () => {
    mocks.setStatus.mockRejectedValueOnce(new Error('offline response lost')).mockResolvedValueOnce({});
    await expect(restartAssistant('agent')).rejects.toThrow('offline response lost');
    expect(mocks.setStatus.mock.calls.map(args => args[1])).toEqual(['offline', 'online']);
  });
  it('requires a readback confirming online intent', async () => {
    mocks.setStatus.mockResolvedValue({});
    mocks.identities.mockResolvedValueOnce([{ desired_status: 'offline' }]).mockResolvedValueOnce([{ desired_status: 'online' }]);
    await expect(restartAssistant('agent')).rejects.toThrow('not been confirmed');
    await expect(restartAssistant('agent')).resolves.toBeUndefined();
  });
});

describe('native move file writes', () => {
  it('reopens the retired cloud source using the recorded workdir without finding its old session', async () => {
    mocks.rpc.mockReturnValue({ sessionTimeline: { sessionsList: async () => { throw new Error('source session retired'); } } });
    mocks.openMachine.mockResolvedValue({ home: '/remote', paths: {}, rpc: { workspace: { files: {} } } });
    const source = await openSource({ ownerUserId: 'owner', assistantId: 'agent', assistantName: 'Assistant', localDeviceId: 'local',
      home: { kind: 'computer', deviceId: 'local', thisDevice: true, known: true, online: true, label: null } },
      'to-computer', { kind: 'cloud', deviceId: 'cloud' }, '/remote/original-assistant');
    expect(mocks.openMachine).toHaveBeenCalledWith({ kind: 'cloud', deviceId: 'cloud' }, '/remote/original-assistant');
    expect(source.workdir).toBe('/remote/original-assistant');
    expect(mocks.rpc).not.toHaveBeenCalled();
  });
  it('passes the target revision for both binary files and user instructions, never force', async () => {
    const writeChunk = vi.fn(async (_project, _workspace, request) => ({ success: true, data: { committed: { size: request.total } } }));
    const fs = machineFs({ projectId: 'project', workspaceId: 'workspace', rpc: { workspace: { files: {
      readChunk: async () => ({ success: true, data: { etag: 'target-v1' } }), writeChunk,
    } } } } as unknown as AssistantMachine);
    expect(await fs.revision!('/file')).toBe('target-v1');
    await fs.writeChunk({ path: '/file', uploadId: 'upload', offset: 0, data: new Uint8Array([1]), total: 1, final: true, expectedRevision: 'target-v1' });
    await fs.writeText('/instructions', 'new instructions', 'target-v2');
    expect(writeChunk.mock.calls.map(args => args[2].expectedEtag)).toEqual(['target-v1', 'target-v2']);
  });
});
