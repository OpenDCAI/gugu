// @vitest-environment jsdom
import { act } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DevicesProvider } from '../../../../apps/desktop/src/store/devices'
import { createNode, createReactHarness } from '../../../support/testHarness'

const mocks = vi.hoisted(() => ({
  authUser: { id: 'account-a' },
  listDevices: vi.fn(),
  listProjects: vi.fn(),
  subscribeAccountRevision: vi.fn(),
  revisionListener: null as null | ((operations: readonly unknown[]) => void | Promise<void>),
}))

vi.mock('../../../../apps/desktop/src/store/auth', () => ({
  useAuth: () => ({ user: mocks.authUser }),
}))
vi.mock('../../../../apps/desktop/src/lib/chat', () => ({
  chatService: {
    listDevices: mocks.listDevices,
  },
}))
vi.mock('../../../../apps/desktop/src/lib/deviceProjects', () => ({ listMyDeviceProjects: mocks.listProjects }))
vi.mock('../../../../apps/desktop/src/store/chatContext', () => ({
  useChatStore: () => ({ subscribeAccountRevision: mocks.subscribeAccountRevision }),
}))

const rowChanged = (deviceId: string) => ({ revision: '1', event: 'device_changed', payload: { device_id: deviceId, tombstone: false } })

/**
 * #4891 的另一半判据。用户那句话不许带下层原文(判据在
 * `tests/unit/desktop/hooks/useAgentCreateContextBridge.test.ts`),但原因**必须**落在日志里 ——
 * ❌ 只钉「不外泄」的话,把 store 里那行 logger 删掉也能绿,那时两边都看不到原因,比原样外泄更糟。
 *
 * (rendererLogger 拿不到 electron 桥时退化成 console.*,所以这里 spy 得到;
 * 仓里 chatSeqJumpRepair.test.ts 已经是这个做法。)
 */
describe('DevicesProvider list failure disclosure', () => {
  let harness: ReturnType<typeof createReactHarness>
  let consoleError: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    mocks.authUser = { id: 'account-a' }
    harness = createReactHarness()
    mocks.listDevices.mockReset().mockResolvedValue([])
    mocks.listProjects.mockReset().mockResolvedValue([])
    mocks.revisionListener = null
    mocks.subscribeAccountRevision.mockReset().mockImplementation((_event: string, listener: (operations: readonly unknown[]) => void | Promise<void>) => {
      mocks.revisionListener = listener
      return () => undefined
    })
    consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})
  })

  afterEach(() => {
    harness.cleanup()
    consoleError.mockRestore()
  })

  it('keeps device reads and the revision listener stable across same-account hydration', async () => {
    await harness.render(createNode(DevicesProvider, {}, createNode('div')))
    const listener = mocks.revisionListener
    const subscriptions = mocks.subscribeAccountRevision.mock.calls.length
    mocks.authUser = { id: 'account-a' }
    await harness.render(createNode(DevicesProvider, {}, createNode('div')))

    expect(mocks.listDevices).toHaveBeenCalledTimes(1)
    expect(mocks.listProjects).toHaveBeenCalledTimes(1)
    expect(mocks.revisionListener).toBe(listener)
    expect(mocks.subscribeAccountRevision).toHaveBeenCalledTimes(subscriptions)
    if (!listener) throw new Error('missing device revision listener')
    await act(async () => { await listener([rowChanged('device-1')]) })
    expect(mocks.listDevices).toHaveBeenCalledTimes(2)
    expect(mocks.listProjects).toHaveBeenCalledTimes(1)
  })

  it('initializes the new account and refreshes after shell reactivation', async () => {
    await harness.render(createNode(DevicesProvider, {}, createNode('div')))
    mocks.authUser = { id: 'account-b' }
    await harness.render(createNode(DevicesProvider, {}, createNode('div')))
    expect(mocks.listDevices).toHaveBeenCalledTimes(2)
    await harness.render(createNode(DevicesProvider, { active: false }, createNode('div')))
    expect(mocks.listDevices).toHaveBeenCalledTimes(2)
    await harness.render(createNode(DevicesProvider, { active: true }, createNode('div')))
    expect(mocks.listDevices).toHaveBeenCalledTimes(3)
  })

  it('writes the raw list failure reason to the log', async () => {
    await harness.render(createNode(DevicesProvider, {}, createNode('div')))
    await act(async () => { await Promise.resolve() })
    mocks.listDevices.mockRejectedValueOnce(new Error('supabase: relation "devices" does not exist'))
    if (!mocks.revisionListener) throw new Error('missing device revision listener')

    // 这条路径按约定重抛给调用方(durable 操作要能感知刷新失败);这里只关心它**先**写没写日志。
    await act(async () => { await Promise.resolve(mocks.revisionListener?.([rowChanged('device-1')])).catch(() => undefined) })

    expect(consoleError).toHaveBeenCalledWith(
      expect.stringContaining('[devices]'),
      expect.objectContaining({ err: expect.stringContaining('relation "devices" does not exist') }),
    )
  })
})
