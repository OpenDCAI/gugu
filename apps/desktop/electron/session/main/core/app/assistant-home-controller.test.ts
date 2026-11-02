import { afterEach, beforeEach, expect, it, vi } from 'vitest'

const owner = '11111111-1111-4111-8111-111111111111'
const device = '22222222-2222-4222-8222-222222222222'
const assistant = '33333333-3333-4333-8333-333333333333'
const operation = '44444444-4444-4444-8444-444444444444'
const mocks = vi.hoisted(() => ({
  owner: '', rows: [] as Array<Record<string, unknown>>, queryError: null as { message: string } | null,
  close: vi.fn(), assertProvision: vi.fn(), start: vi.fn(), wipe: vi.fn(),
  client: { from: vi.fn() },
}))
vi.mock('@gugu/core/cloud/runtimeAuthProvider', () => ({ userIdFromSupabaseAccessToken: () => mocks.owner }))
vi.mock('@gugu/core/cloud/supabase', () => ({ createGuguSupabaseClient: () => mocks.client }))
vi.mock('../extensions/account-token', () => ({ currentAccountAccessToken: async () => 'account-token' }))
vi.mock('../../../../lib/logger', () => ({ createLogger: () => ({ error: vi.fn() }) }))
vi.mock('../../../../assistant-home-prepare', () => ({ prepareLocalAssistantHome: vi.fn(), wipeLocalAssistantHome: mocks.wipe }))
vi.mock('../../../../assistant-server-preparation', () => ({ createAssistantServerPreparation: () => ({ start: mocks.start, assertProvision: mocks.assertProvision, closeHome: mocks.close }) }))
import { assistantHomeController as controller, setAssistantHomeDeviceResolver } from './assistant-home-controller'

const originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform')!
const originalArch = Object.getOwnPropertyDescriptor(process, 'arch')!
beforeEach(() => {
  vi.clearAllMocks()
  vi.stubEnv('GUGU_SERVER_MODE', '1')
  vi.stubEnv('GUGU_CLOUD_COMPUTER', '0')
  Object.defineProperty(process, 'platform', { value: 'linux' })
  Object.defineProperty(process, 'arch', { value: 'x64' })
  mocks.owner = owner; mocks.rows = []; mocks.queryError = null
  setAssistantHomeDeviceResolver(async () => device)
  mocks.client.from.mockImplementation(() => {
    const query = { select: () => query, eq: () => query,
      then: (resolve: (value: unknown) => unknown) => Promise.resolve({ data: mocks.rows, error: mocks.queryError }).then(resolve) }
    return query
  })
  mocks.assertProvision.mockResolvedValue(undefined)
  mocks.close.mockResolvedValue({ workdir: '/account/assistant', existed: true })
})
afterEach(() => {
  Object.defineProperty(process, 'platform', originalPlatform)
  Object.defineProperty(process, 'arch', originalArch)
  vi.unstubAllEnvs()
})
it('checks the account and exact account device before any setup or database work', async () => {
  expect(await controller.preflight({ ownerUserId: assistant, deviceId: device })).toMatchObject({ ok: false, error: { code: 'account_changed' } })
  expect(await controller.preflight({ ownerUserId: owner, deviceId: assistant })).toMatchObject({ ok: false, error: { code: 'target_not_owned' } })
  expect(mocks.client.from).not.toHaveBeenCalled()
})
it('rejects a desktop, a managed cloud host and an unsupported Linux architecture', async () => {
  vi.stubEnv('GUGU_SERVER_MODE', '0')
  expect(await controller.preflight({ ownerUserId: owner, deviceId: device })).toMatchObject({ ok: false, error: { code: 'unsupported_platform' } })
  vi.stubEnv('GUGU_SERVER_MODE', '1'); vi.stubEnv('GUGU_CLOUD_COMPUTER', '1')
  expect(await controller.preflight({ ownerUserId: owner, deviceId: device })).toMatchObject({ ok: false, error: { code: 'unsupported_platform' } })
  vi.stubEnv('GUGU_CLOUD_COMPUTER', '0'); Object.defineProperty(process, 'arch', { value: 'riscv64' })
  expect(await controller.preflight({ ownerUserId: owner, deviceId: device })).toMatchObject({ ok: false, error: { code: 'unsupported_arch' } })
  expect(mocks.start).not.toHaveBeenCalled()
})
it('refuses first setup when an assistant already exists and does not turn a query failure into absence', async () => {
  mocks.rows = [{ member_key: 'assistant', agent_user_id: assistant, agent: { removed_at: null }, device_id: device, phase: 'completed', created_at: '2026-11-01' }]
  expect(await controller.preflight({ ownerUserId: owner, deviceId: device })).toMatchObject({ ok: false, error: { code: 'assistant_exists' } })
  mocks.rows[0]!.agent = { removed_at: '2026-11-02T15:06:41Z' }
  expect(await controller.preflight({ ownerUserId: owner, deviceId: device })).toMatchObject({ ok: true })
  mocks.rows = []; mocks.queryError = { message: 'network unavailable' }
  expect(await controller.preflight({ ownerUserId: owner, deviceId: device })).toMatchObject({ ok: false })
})
it('preflights with the target build model source and never a controller-provided model', async () => {
  vi.stubEnv('GUGU_PLATFORM_MODELS_ENABLED', 'false')
  expect(await controller.preflight({ ownerUserId: owner, deviceId: device })).toEqual({ ok: true, value: { version: 1, deviceId: device, modelSource: 'target', defaultModel: null } })
  expect(await controller.preflight({ ownerUserId: owner, deviceId: device, workdir: '/arbitrary' } as never)).toMatchObject({ ok: false, error: { code: 'input_mismatch' } })
})
it('verifies a close before mutation and binds cleanup to the exact archived assistant provision', async () => {
  mocks.rows = [{ agent_user_id: assistant, agent: { removed_at: null }, provisioned_agent_user_id: assistant, operation_id: operation }]
  expect(await controller.checkClose({ ownerUserId: owner, deviceId: device, assistantId: assistant })).toEqual({ ok: true, value: { ready: true } })
  expect(await controller.wipe({ ownerUserId: owner, deviceId: device, assistantId: assistant })).toMatchObject({ ok: false, error: { code: 'preparation_busy' } })
  expect(mocks.close).not.toHaveBeenCalled()
  mocks.rows[0]!.agent = { removed_at: '2026-11-02T15:06:41Z' }
  expect(await controller.wipe({ ownerUserId: owner, deviceId: device, assistantId: assistant })).toMatchObject({ ok: true, value: { workdir: '/account/assistant' } })
  expect(mocks.assertProvision).toHaveBeenLastCalledWith(operation)
  expect(mocks.close).toHaveBeenCalledWith(operation)
  expect(mocks.wipe).not.toHaveBeenCalled()
})
it('does not clear another assistant or a newer home with a delayed close request', async () => {
  mocks.rows = [{ agent_user_id: null, provisioned_agent_user_id: assistant, operation_id: operation }, { agent_user_id: 'new-assistant' }]
  expect(await controller.wipe({ ownerUserId: owner, deviceId: device, assistantId: assistant })).toMatchObject({ ok: false })
  expect(mocks.close).not.toHaveBeenCalled()
  mocks.rows = []
  expect(await controller.checkClose({ ownerUserId: owner, deviceId: device, assistantId: assistant })).toMatchObject({ ok: false, error: { code: 'target_not_owned' } })
})
it('does not mistake a reserved identity before creation for a completed, hard-deleted identity', async () => {
  mocks.rows = [{ agent_user_id: null, agent: null, provisioned_agent_user_id: assistant, operation_id: operation, phase: 'awaiting_terminal' }]
  expect(await controller.wipe({ ownerUserId: owner, deviceId: device, assistantId: assistant })).toMatchObject({ ok: false, error: { code: 'preparation_busy' } })
  expect(mocks.close).not.toHaveBeenCalled()
  mocks.rows[0]!.phase = 'completed'
  expect(await controller.wipe({ ownerUserId: owner, deviceId: device, assistantId: assistant })).toMatchObject({ ok: true })
})
