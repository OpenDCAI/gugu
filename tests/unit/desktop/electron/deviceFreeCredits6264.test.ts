// 免费额度跟设备走(官方会员口径):设备哈希、各平台取硬件标识、认领只做一次、失败不抛。
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, test, vi } from 'vitest'
import { machineHardwareIdentifier, type MachineIdIo } from '../../../../packages/core/src/cloud/deviceRuntime'
import {
  claimDeviceFreeCredits,
  deviceClaimHash,
  readDeviceClaimStatus,
  type DeviceClaimDeps,
} from '../../../../apps/desktop/electron/device-free-credits'

const UUID = '12345678-ABCD-EF00-1122-334455667788'
const signal = new AbortController().signal

function io(over: Partial<MachineIdIo>): MachineIdIo {
  return {
    platform: 'linux',
    exec: async () => { throw new Error('exec not expected') },
    readText: async () => { throw new Error('ENOENT') },
    fallback: async () => 'persisted-random',
    ...over,
  }
}

test('设备哈希 = sha256("gugu-device-v1:" + 标识) 小写 hex', () => {
  expect(deviceClaimHash(UUID)).toBe('380e86296c664c7915af3da4744fa93fe04689096c532e602193e45fc975d216')
})

describe('各平台取硬件标识', () => {
  test('macOS 读 ioreg 的 IOPlatformUUID', async () => {
    const exec = vi.fn(async () => `  "IOPlatformSerialNumber" = "X"\n  "IOPlatformUUID" = "${UUID}"\n`)
    await expect(machineHardwareIdentifier(signal, io({ platform: 'darwin', exec }))).resolves.toBe(UUID)
    expect(exec).toHaveBeenCalledWith('/usr/sbin/ioreg', ['-rd1', '-c', 'IOPlatformExpertDevice'], signal)
  })

  test('Windows 读注册表 MachineGuid', async () => {
    const out = `\r\nHKEY_LOCAL_MACHINE\\SOFTWARE\\Microsoft\\Cryptography\r\n    MachineGuid    REG_SZ    ${UUID.toLowerCase()}\r\n`
    await expect(machineHardwareIdentifier(signal, io({ platform: 'win32', exec: async () => out }))).resolves.toBe(UUID.toLowerCase())
  })

  test('Linux 先 /etc/machine-id,缺了退 dbus,都缺退本地随机', async () => {
    const files: Record<string, string> = { '/etc/machine-id': 'etc-id\n', '/var/lib/dbus/machine-id': 'dbus-id\n' }
    const readText = async (path: string) => { if (path in files) return files[path]; throw new Error('ENOENT') }
    await expect(machineHardwareIdentifier(signal, io({ readText }))).resolves.toBe('etc-id')
    delete files['/etc/machine-id']
    await expect(machineHardwareIdentifier(signal, io({ readText }))).resolves.toBe('dbus-id')
    delete files['/var/lib/dbus/machine-id']
    await expect(machineHardwareIdentifier(signal, io({ readText }))).resolves.toBe('persisted-random')
  })

  test('解析不到就报错,不编一个', async () => {
    await expect(machineHardwareIdentifier(signal, io({ platform: 'darwin', exec: async () => '' }))).rejects.toThrow('IOPlatformUUID')
  })
})

describe('认领', () => {
  const auth = { userId: 'user-1', accessToken: 'token-1' }
  async function deps(claim: DeviceClaimDeps['claim']): Promise<DeviceClaimDeps & { warn: ReturnType<typeof vi.fn<(message: string) => void>> }> {
    const dir = await mkdtemp(join(tmpdir(), 'device-claim-'))
    return { machineId: async () => UUID, claim, storePath: join(dir, 'claims.json'), warn: vi.fn<(message: string) => void>() }
  }

  test('带设备哈希调一次;已认领过的账号不再调', async () => {
    const claim = vi.fn(async () => ({ status: 'granted', device_accounts: 1 }))
    const d = await deps(claim)
    await expect(claimDeviceFreeCredits(d, auth)).resolves.toBe('granted')
    await expect(claimDeviceFreeCredits(d, auth)).resolves.toBe('granted')
    expect(claim).toHaveBeenCalledTimes(1)
    expect(claim).toHaveBeenCalledWith('token-1', deviceClaimHash(UUID))
  })

  test('device_full 记下供界面读,下次启动还会再问', async () => {
    const claim = vi.fn(async () => ({ status: 'device_full', device_accounts: 5 }))
    const d = await deps(claim)
    await claimDeviceFreeCredits(d, auth)
    await expect(readDeviceClaimStatus(d.storePath, 'user-1')).resolves.toBe('device_full')
    await expect(readDeviceClaimStatus(d.storePath, 'user-2')).resolves.toBeNull()
    await claimDeviceFreeCredits(d, auth)
    expect(claim).toHaveBeenCalledTimes(2)
  })

  test('RPC 失败 / 旧库没有函数 / 结果不认识:不抛、不记,下次再试', async () => {
    const claim = vi.fn()
      .mockRejectedValueOnce(new Error('Could not find the function billing.claim_device_free_credits'))
      .mockResolvedValueOnce({ status: 'weird' })
      .mockResolvedValueOnce({ status: 'already_claimed', device_accounts: 2 })
    const d = await deps(claim)
    await expect(claimDeviceFreeCredits(d, auth)).resolves.toBeNull()
    await expect(claimDeviceFreeCredits(d, auth)).resolves.toBeNull()
    expect(d.warn).toHaveBeenCalledTimes(2)
    await expect(readDeviceClaimStatus(d.storePath, 'user-1')).resolves.toBeNull()
    await expect(claimDeviceFreeCredits(d, auth)).resolves.toBe('already_claimed')
  })

  test('取不到机器标识也不抛', async () => {
    const d = await deps(vi.fn())
    d.machineId = async () => { throw new Error('IOPlatformUUID not found') }
    await expect(claimDeviceFreeCredits(d, auth)).resolves.toBeNull()
    expect(d.claim).not.toHaveBeenCalled()
  })
})
