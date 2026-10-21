// @vitest-environment jsdom
// #7403 读咕咕家里东西没读成:那台的咕咕比这台桌面旧(不认这一问)时,当场请它换成匹配的版本、说「正在更新」,
// ❌ 红字、❌ `Error:` 前缀、❌ 点了也一样的「重试」;换好了(心跳报的版本变了)自己重读;那台报没换成才给「重试」。
import { act, createElement } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { RemoteHostDevice } from '../../../../apps/desktop/src/session/shared/remote-hosts'
import { createReactHarness } from '../../../support/testHarness'

const store = vi.hoisted(() => ({
  devices: new Map<string, Partial<RemoteHostDevice>>(),
  matchServerVersion: vi.fn<(deviceId: string, options?: { retry?: boolean }) => Promise<boolean>>(),
}))
vi.mock('../../../../apps/desktop/src/session/renderer/features/remote-hosts/remote-hosts-store', () => ({
  remoteHostsStore: {
    device: (id: string) => store.devices.get(id) ?? null,
    matchServerVersion: store.matchServerVersion,
  },
}))
vi.mock('../../../../apps/desktop/src/session/renderer/features/library/library-host', async () => {
  const { TOO_OLD_CODES } = await import('../../../../apps/desktop/src/session/renderer/features/remote-hosts/connection-status')
  return { isTooOld: (error: unknown) => TOO_OLD_CODES.has(String((error as { code?: unknown } | null)?.code)) }
})
vi.mock('react-i18next', async (importOriginal) => ({
  ...(await importOriginal<typeof import('react-i18next')>()),
  useTranslation: () => ({ t: (key: string, values?: Record<string, string>) => `${key}|${JSON.stringify(values ?? {})}` }),
}))

const { useReadFailure } = await import('../../../../apps/desktop/src/session/renderer/features/assistant/assistant-read-failure')

type Failure = ReturnType<typeof useReadFailure>
let shown: Failure = null
const reload = vi.fn()
function Probe({ error, deviceId }: { error: unknown; deviceId: string | null }) {
  shown = useReadFailure(error, deviceId, '云端', reload)
  return null
}
const tooOld = Object.assign(new Error('「咕咕」上的咕咕版本太旧,暂不支持此页'), { code: 'unknown_method' })

let harness: ReturnType<typeof createReactHarness>
beforeEach(() => {
  harness = createReactHarness()
  shown = null
  reload.mockReset()
  store.devices.clear()
  store.matchServerVersion.mockReset().mockResolvedValue(true)
})
afterEach(() => harness.cleanup())
const show = (error: unknown, deviceId: string | null) => harness.render(createElement(Probe, { error, deviceId }))
const settle = () => act(async () => {})

describe('useReadFailure', () => {
  it('那台的咕咕太旧:请它换成匹配的版本,说「正在更新」,不标红、没有按钮', async () => {
    store.devices.set('cloud', { id: 'cloud', version: '0.2.55' })
    await show(tooOld, 'cloud')
    await settle()
    expect(store.matchServerVersion).toHaveBeenCalledWith('cloud')
    expect(shown).toEqual({ text: 'machine.updating|{"where":"云端"}', tone: 'quiet', retry: null })
  })

  it('换好了(心跳报的版本变了):自己重读这一块', async () => {
    store.devices.set('cloud', { id: 'cloud', version: '0.2.55' })
    await show(tooOld, 'cloud')
    await settle()
    expect(reload).not.toHaveBeenCalled()
    store.devices.set('cloud', { id: 'cloud', version: '0.2.57' })
    await show(tooOld, 'cloud')
    await settle()
    expect(reload).toHaveBeenCalledTimes(1)
  })

  it('那台报换版本没成:说没更新成功,「重试」= 再请它换一次', async () => {
    store.devices.set('cloud', { id: 'cloud', version: '0.2.55', serverUpdate: 'failed' })
    await show(tooOld, 'cloud')
    await settle()
    expect(shown?.text).toBe('machine.updateFailed|{"where":"云端"}')
    expect(shown?.tone).toBe('quiet')
    store.matchServerVersion.mockClear()
    shown?.retry?.()
    expect(store.matchServerVersion).toHaveBeenCalledWith('cloud', { retry: true })
    expect(reload).not.toHaveBeenCalled()
  })

  it('请它换版本没请到(太老不认这一请 / 连不上):❌ 一直「正在更新」,说没能更新 + 重试;重试请到了回到「正在更新」', async () => {
    store.devices.set('cloud', { id: 'cloud', version: '0.2.55' })
    store.matchServerVersion.mockResolvedValue(false)
    await show(tooOld, 'cloud')
    await settle()
    expect(shown?.text).toBe('machine.updateFailed|{"where":"云端"}')
    store.matchServerVersion.mockResolvedValue(true)
    await act(async () => { shown?.retry?.() })
    await settle()
    expect(store.matchServerVersion).toHaveBeenLastCalledWith('cloud', { retry: true })
    expect(shown?.text).toBe('machine.updating|{"where":"云端"}')
    expect(shown?.retry).toBeNull()
  })

  it('别的读失败:照实说原因(❌ `Error:` 前缀),「重试」= 重读;❌ 请它换版本', async () => {
    store.devices.set('cloud', { id: 'cloud', version: '0.2.57' })
    await show(new Error('permission denied'), 'cloud')
    await settle()
    expect(shown).toEqual({ text: 'machine.readFailed|{"message":"permission denied"}', tone: 'danger', retry: reload })
    expect(store.matchServerVersion).not.toHaveBeenCalled()
  })

  it('这台电脑自己(不是别的机器):❌ 请换版本,照实说原因', async () => {
    await show(tooOld, null)
    await settle()
    expect(store.matchServerVersion).not.toHaveBeenCalled()
    expect(shown?.tone).toBe('danger')
  })

  it('没出错:什么都不说', async () => {
    await show(null, 'cloud')
    expect(shown).toBeNull()
  })
})
