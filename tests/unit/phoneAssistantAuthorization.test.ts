import { afterEach, expect, it, vi } from 'vitest'
import { i18n } from '../../apps/desktop/src/i18n/runtime'
import '../../apps/desktop/src/i18n/registerAssistantCatalog'
const world = vi.hoisted(() => ({ owner: 'owner', online: false, wake: vi.fn(), authorize: vi.fn(), ready: vi.fn() }))
vi.mock('../../apps/desktop/src/lib/cloudComputerStore', () => ({ wakeCloudComputer: world.wake }))
vi.mock('../../apps/desktop/src/store/devicesCache', () => ({ readCachedDevices: () => world.online ? [{ device_id: 'home', is_online: true }] : [] }))
vi.mock('../../apps/desktop/src/lib/sessionPublication', () => ({ getRendererSession: () => ({ user: { id: world.owner } }) }))
vi.mock('../../apps/desktop/src/mobile/agent-watch/sessionpage-rpc', () => ({ machineRpc: () => ({ integrations: { authorize: world.authorize,checkConfiguredConnections: world.ready }, github: {} }) }))
import { phoneAssistantAuthorization } from '../../apps/desktop/src/mobile/assistant/phoneAssistantAuthorization'
afterEach(() => { vi.useRealTimers(); world.owner = 'owner'; world.online = false; world.wake.mockReset(); world.authorize.mockReset(); world.ready.mockReset() })
it.each(['zh-CN', 'en-US'])('localizes unavailable authorization without raw diagnostics or asking the owner to retry (%s)', async locale => {
  await i18n.changeLanguage(locale)
  world.wake.mockRejectedValue(new Error('raw provider transport secret'))
  const api = phoneAssistantAuthorization('home', { kind: 'cloud', deviceId: 'home' })
  await expect(api.integrations.authorize('github')).rejects.toThrow(i18n.t('assistant:machine.authorizationUnavailable'))
  expect(world.authorize).not.toHaveBeenCalled()
})
it('ends a host availability wait with a localized cause and refuses a changed owner', async () => {
  await i18n.changeLanguage('zh-CN'); vi.useFakeTimers()
  world.ready.mockRejectedValue(new Error('unreachable'))
  const api = phoneAssistantAuthorization('home', null)
  const waiting = expect(api.integrations.authorize('github')).rejects.toThrow('执行环境暂时不可用')
  await vi.advanceTimersByTimeAsync(60_500); await waiting
  world.owner = 'other'
  await expect(api.integrations.authorize('github')).rejects.toThrow(i18n.t('assistant:machine.accessFailed'))
  expect(world.authorize).not.toHaveBeenCalled()
})
it('does not trust online presence before a control acknowledgement', async () => {
  world.online = true
  let release!: () => void
  world.ready.mockImplementation(() => new Promise(resolve => { release = () => resolve({}) }))
  const api = phoneAssistantAuthorization('home', { kind: 'cloud', deviceId: 'home' })
  const login = api.integrations.authorize('github')
  await vi.waitFor(() => expect(world.ready).toHaveBeenCalledOnce())
  expect(world.authorize).not.toHaveBeenCalled()
  release()
  await login
  expect(world.authorize).toHaveBeenCalledOnce()
})
it('checks control readiness again on a later explicit authorization', async () => {
  world.ready.mockResolvedValue({})
  const api = phoneAssistantAuthorization('home', { kind: 'cloud', deviceId: 'home' })
  await api.integrations.authorize('github')
  await api.integrations.authorize('github')
  expect(world.ready).toHaveBeenCalledTimes(2)
  expect(world.wake).toHaveBeenCalledTimes(2)
})
