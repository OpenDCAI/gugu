/**
 * #7199 个人助理住的那台自己随心跳报「我是它的家」(capabilities.assistant_home):各端设备行一出现就认得它,
 * ❌ 等问到云电脑管家才知道 —— 那之前聊天头会把那台的机器名露给人(统筹 10-15「聊天头任何时候都不读机器名」)。
 */
import { afterEach, describe, expect, it } from 'vitest'
import { resetDeviceHostInfoCacheForTest, resolveDeviceHostInfo } from '../../../../packages/core/src/cloud/deviceHostInfo'
import { normalizeDeviceCapabilities } from '../../../../packages/core/src/cloud/devices'

afterEach(() => resetDeviceHostInfoCacheForTest())

const deps = { platform: () => 'linux', release: () => '6.1', arch: () => 'x64', readText: () => null, uid: () => 1000, tunnelRelayUp: () => false, tunnelActiveAt: () => null }

describe('个人助理的家随心跳报自己', () => {
  it('管家起的 server(GUGU_CLOUD_COMPUTER=1)报 assistant_home;别的 server、桌面不报', () => {
    expect(resolveDeviceHostInfo({ GUGU_SERVER_MODE: '1', GUGU_CLOUD_COMPUTER: '1' }, deps).assistant_home).toBe(true)
    expect(resolveDeviceHostInfo({ GUGU_SERVER_MODE: '1' }, deps).assistant_home).toBeUndefined()
    expect(resolveDeviceHostInfo({ GUGU_CLOUD_COMPUTER: '1' }, deps).assistant_home).toBeUndefined()
  })

  it('设备行只收 true;别的值当没报', () => {
    expect(normalizeDeviceCapabilities({ assistant_home: true }).assistant_home).toBe(true)
    expect(normalizeDeviceCapabilities({ assistant_home: 'yes' }).assistant_home).toBeUndefined()
    expect(normalizeDeviceCapabilities({}).assistant_home).toBeUndefined()
  })
})
