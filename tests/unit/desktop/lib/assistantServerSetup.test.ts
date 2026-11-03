// @vitest-environment jsdom
import { beforeEach, expect, it, vi } from 'vitest'
import type { ProvisionResumeRecord } from '../../../../apps/desktop/src/lib/agentProvision'
import { REMOTE_PROTOCOL_VERSION } from '@gugu/core/cloud/serverMachineHealth'
import { createAssistantServerPreparation } from '../../../../apps/desktop/electron/assistant-server-preparation'
import type { AssistantServerPreparation } from '../../../../apps/desktop/src/lib/assistantServerSetupTypes'

const mocks = vi.hoisted(() => ({
  owner: 'owner', online: true, stored: [] as ProvisionResumeRecord[],
  start: vi.fn(), status: vi.fn(), cancel: vi.fn(), preflight: vi.fn(), provision: vi.fn(), resume: vi.fn(), models: vi.fn(), ipc: vi.fn(),
}))
vi.mock('../../../../apps/desktop/src/mobile/agent-watch/sessionpage-rpc', () => ({ machineRpc: (deviceId: string) => {
  if (deviceId !== 'server') throw new Error('wrong target')
  return { assistantHome: { start: mocks.start, status: mocks.status, cancel: mocks.cancel, preflight: mocks.preflight } }
} }))
vi.mock('../../../../apps/desktop/src/platform/desktopIpc', () => ({ desktopIpc: () => ({ invoke: mocks.ipc }) }))
vi.mock('../../../../apps/desktop/src/lib/supabase', () => ({ getCurrentAuthUserId: async () => mocks.owner }))
vi.mock('../../../../apps/desktop/src/lib/assistantSetup', () => ({
  cleanAssistantSetupDraft: (draft: { name: string }) => ({ name: draft.name, avatar: 'look', ownerProfile: 'Owner profile' }),
  completedAssistantSetup: (value: unknown) => value,
  assistantResumeStore: { list: () => mocks.stored },
}))
vi.mock('../../../../apps/desktop/src/lib/agentProvision', () => ({ provisionSingleAgent: mocks.provision, resumeSingleAgent: mocks.resume }))
vi.mock('../../../../apps/desktop/src/lib/agentModelSelection', () => ({ fetchAgentHarnessModels: mocks.models }))
vi.mock('../../../../apps/desktop/src/lib/listDevicesOnceIdentified', () => ({ listDevicesOnceIdentified: async () => [{ device_id: 'server', label: 'Linux', is_online: mocks.online, platform: 'linux',
  capabilities: { host_kind: 'server', arch: 'x64', remote_protocol: REMOTE_PROTOCOL_VERSION, assistant_home_setup: 1 } }] }))
import { setUpAssistantOnServer, pendingServerAssistant, resumeServerAssistant, resumeServerAssistantProvision } from '../../../../apps/desktop/src/lib/assistantServerSetup'

const draft = { name: 'Name', color: 0, rest: 'calm', owner: { preferredName: 'Owner', about: '' } } as never
const prepared = { operationId: 'prep', phase: 'prepared', cancellable: false, installationStarted: true, home: { home: '/remote', workdir: '/remote/assistant' } }
const ok = <T>(value: T) => ({ ok: true, value })
beforeEach(() => {
  vi.clearAllMocks()
  localStorage.clear()
  mocks.owner = 'owner'; mocks.online = true; mocks.stored = []
  mocks.preflight.mockResolvedValue(ok({ version: 1, deviceId: 'server', modelSource: 'platform', defaultModel: 'platform:glm-5.3-flash' }))
  mocks.start.mockResolvedValue(ok(prepared))
  mocks.models.mockResolvedValue({ models: [{ id: 'platform:glm-5.3-flash', source: 'gugu' }], selected: 'local-subscription', selectedCredential: 'credentialed' })
  mocks.provision.mockImplementation(async (deviceId, _member, deps) => {
    const record = { ownerUserId: 'owner', deviceId, operationId: deps.newId() } as ProvisionResumeRecord
    mocks.stored = [record]
    deps.onAttemptRecorded(record)
    return { agentUserId: 'assistant', sessionId: 'session' }
  })
  mocks.resume.mockResolvedValue({ agentUserId: 'assistant', sessionId: 'session' })
})
it('prepares and creates only on the chosen target, retaining draft/model and server-authoritative completion', async () => {
  const progress = vi.fn()
  await expect(setUpAssistantOnServer(draft, 'server', { onProgress: progress })).resolves.toMatchObject({ agentUserId: 'assistant' })
  const operationId = mocks.start.mock.calls[0]?.[0].operationId
  expect(mocks.start).toHaveBeenCalledWith({ ownerUserId: 'owner', deviceId: 'server', operationId, ownerProfile: 'Owner profile' })
  expect(mocks.provision).toHaveBeenCalledWith('server', expect.objectContaining({ displayName: 'Name', avatar: 'look', projectPath: '/remote/assistant' }), expect.objectContaining({ model: 'platform:glm-5.3-flash' }))
  expect(mocks.stored[0]?.operationId).toBe(operationId)
  expect(mocks.models).toHaveBeenCalledWith('server', 'claude', false)
  expect(mocks.ipc).not.toHaveBeenCalled()
  expect(pendingServerAssistant('owner')).toBeNull()
  expect(progress.mock.calls.at(-1)?.[0].phase).toBe('ready')
})
it('fast-fails an offline target before saving a record or sending any mutation', async () => {
  mocks.online = false
  await expect(setUpAssistantOnServer(draft, 'server')).rejects.toMatchObject({ code: 'target_offline' })
  expect(pendingServerAssistant('owner')).toBeNull()
  expect(mocks.start).not.toHaveBeenCalled()
  expect(mocks.provision).not.toHaveBeenCalled()
})
it('resumes a failed preparation on the same operation and keeps the original draft', async () => {
  mocks.start.mockResolvedValueOnce(ok({ phase: 'failed', cancellable: true, installationStarted: false, error: { code: 'runtime_failed', next: 'retry', retryable: true } }))
  await expect(setUpAssistantOnServer(draft, 'server')).rejects.toMatchObject({ code: 'runtime_failed' })
  const record = pendingServerAssistant('owner')!
  await resumeServerAssistant()
  expect(mocks.start.mock.calls[1]?.[0]).toMatchObject({ operationId: record.operationId, deviceId: 'server', ownerProfile: 'Owner profile' })
  expect(mocks.provision).toHaveBeenCalledOnce()
})
it('waits for confirmed cancellation before releasing the target record', async () => {
  const abort = new AbortController()
  mocks.start.mockImplementationOnce(async () => { abort.abort(); return ok({ phase: 'runtime', installationStarted: false, cancellable: true }) })
  mocks.cancel.mockResolvedValueOnce(ok({ cancelled: true, state: { phase: 'cancelled' } }))
  await expect(setUpAssistantOnServer(draft, 'server', { signal: abort.signal })).rejects.toMatchObject({ name: 'AbortError' })
  expect(mocks.cancel).toHaveBeenCalledOnce()
  expect(pendingServerAssistant('owner')).toBeNull()
  expect(mocks.provision).not.toHaveBeenCalled()
})
it('cancels a failed preparation on back without restarting the installer', async () => {
  mocks.start.mockResolvedValueOnce(ok({ phase: 'failed', cancellable: true, installationStarted: false, error: { code: 'runtime_failed', next: 'retry', retryable: true } }))
  await expect(setUpAssistantOnServer(draft, 'server')).rejects.toMatchObject({ code: 'runtime_failed' })
  const abort = new AbortController(); abort.abort()
  mocks.cancel.mockResolvedValueOnce(ok({ cancelled: true, state: { phase: 'cancelled' } }))
  await expect(resumeServerAssistant({ signal: abort.signal })).rejects.toMatchObject({ name: 'AbortError' })
  expect(mocks.start).toHaveBeenCalledOnce()
  expect(mocks.cancel).toHaveBeenCalledOnce()
  expect(pendingServerAssistant('owner')).toBeNull()
})
it('releases the renderer record after cancelling a start that never reached the target, and fences its late arrival', async () => {
  const cancellations = new Map<string, AssistantServerPreparation>()
  const prepare = vi.fn()
  const service = createAssistantServerPreparation({
    read: async () => null, write: vi.fn(), validate: vi.fn(), retired: async () => false,
    readCancellation: async input => cancellations.get(input.operationId) ?? null,
    writeCancellation: async (input, state) => { cancellations.set(input.operationId, state) },
    prepare, cleanup: vi.fn(), wipe: vi.fn(), install: vi.fn(), log: vi.fn(),
  })
  mocks.start.mockRejectedValueOnce(new Error('transport closed before delivery'))
  mocks.cancel.mockImplementation(async input => ok(await service.cancel(input)))
  await expect(setUpAssistantOnServer(draft, 'server')).rejects.toMatchObject({ code: 'target_unreachable' })
  const delayed = mocks.start.mock.calls[0]![0]
  expect(pendingServerAssistant('owner')?.preparationStarted).toBe(true)
  const abort = new AbortController(); abort.abort()
  await expect(resumeServerAssistant({ signal: abort.signal })).rejects.toMatchObject({ name: 'AbortError' })
  expect(pendingServerAssistant('owner')).toBeNull()
  expect(await service.start(delayed)).toMatchObject({ phase: 'cancelled' })
  expect(prepare).not.toHaveBeenCalled()
})
it('does not silently replace a missing platform model with the target subscription', async () => {
  mocks.models.mockResolvedValueOnce({ models: [{ id: 'subscription', source: 'harness' }], selected: 'subscription', selectedCredential: 'credentialed' })
  await expect(setUpAssistantOnServer(draft, 'server')).rejects.toMatchObject({ code: 'model_unavailable' })
  expect(mocks.provision).not.toHaveBeenCalled()
  expect(pendingServerAssistant('owner')?.installationStarted).toBe(true)
})
it('uses only the target default for a community build with verified target credentials', async () => {
  mocks.preflight.mockResolvedValueOnce(ok({ version: 1, deviceId: 'server', modelSource: 'target', defaultModel: null }))
  await setUpAssistantOnServer(draft, 'server')
  expect(mocks.provision.mock.calls[0]?.[2].model).toBe('local-subscription')
})
it('resumes the already recorded provision instead of preparing again or creating another identity', async () => {
  mocks.provision.mockRejectedValueOnce(new Error('lost acknowledgement'))
  // Preserve the provisioning record through a lost start acknowledgement.
  mocks.provision.mockImplementationOnce(async (deviceId, _member, deps) => {
    const record = { ownerUserId: 'owner', deviceId, operationId: deps.newId() } as ProvisionResumeRecord
    mocks.stored = [record]; deps.onAttemptRecorded(record)
    throw new Error('lost acknowledgement')
  })
  await expect(setUpAssistantOnServer(draft, 'server')).rejects.toMatchObject({ code: 'provision_failed' })
  // First rejection precedes remember; retry uses the original preparation.
  await expect(resumeServerAssistant()).rejects.toMatchObject({ code: 'provision_failed' })
  const stored = pendingServerAssistant('owner')!
  expect(stored.provisionOperationId).toBe(stored.operationId)
  await resumeServerAssistant()
  expect(mocks.resume).toHaveBeenCalledWith(expect.objectContaining({ deviceId: 'server', operationId: stored.operationId }), expect.objectContaining({ model: 'platform:glm-5.3-flash' }))
  expect(mocks.provision).toHaveBeenCalledTimes(2)
})
it('never resumes another account or a provisioning target that disagrees with the journal', async () => {
  await expect(resumeServerAssistantProvision({ ownerUserId: 'another', deviceId: 'server' } as ProvisionResumeRecord)).rejects.toMatchObject({ code: 'account_changed' })
  await expect(resumeServerAssistantProvision({ ownerUserId: 'owner', deviceId: 'server', operationId: 'unknown' } as ProvisionResumeRecord)).rejects.toMatchObject({ code: 'input_mismatch' })
  expect(mocks.resume).not.toHaveBeenCalled()
  expect(mocks.ipc).not.toHaveBeenCalled()
})
it('joins the existing server setup when the assistant shell tries to recover its new identity', async () => {
  let finish!: (value: unknown) => void
  mocks.provision.mockImplementationOnce(async (deviceId, _member, deps) => {
    const record = { ownerUserId: 'owner', deviceId, operationId: deps.newId() } as ProvisionResumeRecord
    mocks.stored = [record]; deps.onAttemptRecorded(record)
    return new Promise(resolve => { finish = resolve })
  })
  const started = setUpAssistantOnServer(draft, 'server')
  await vi.waitFor(() => expect(finish).toBeTypeOf('function'))
  const shell = resumeServerAssistantProvision(mocks.stored[0]!)
  expect(shell).toBe(started)
  expect(mocks.resume).not.toHaveBeenCalled()
  finish({ agentUserId: 'assistant', sessionId: 'session' })
  await expect(shell).resolves.toMatchObject({ agentUserId: 'assistant' })
})
