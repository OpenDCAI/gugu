import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { createLocalDeviceIdResolver } from '@gugu/core/cloud/deviceRuntime'
import { isolatedGuguEnv, MemoryHeartbeatClient } from '../../../support/deviceRuntimeHarness'

/**
 * #7317 真机(e99c04f2):开机后第一次 device_actions 读到完整的动作清单,紧接着的 device_call 却报「版本太旧」。
 * 这台机器那一行有不止一个心跳在写,行是整块覆盖的;`liveResolveLocalDeviceId` 那一次登记心跳没带动作清单,
 * 就把常规心跳刚登记的抹掉了,直到下一次心跳。判据:main.ts 里每一个写这一行的心跳都带齐 `heartbeatRowSources`。
 */
const main = fs.readFileSync(path.join(__dirname, '../../../../apps/desktop/electron/main.ts'), 'utf8')

/** The options each heartbeat writer of this machine's row is given: a direct call, or the device runtime host's. */
function writers(source: string): string[] {
  const calls = source.split('createLocalDeviceIdResolver({').slice(1).map((rest) => rest.slice(0, rest.indexOf('\n})')))
  const host = source.slice(source.indexOf('function startDeviceRuntimeWhenRendererReady'))
  return [...calls, host.slice(0, host.indexOf('\n}\n'))]
}

describe('#7317 every heartbeat that writes this machine\'s row carries the same row sources', () => {
  it('the device runtime\'s heartbeat and the one-time registration both carry them', () => {
    const found = writers(main)
    expect(found).toHaveLength(2)
    for (const options of found) expect(options).toContain('...heartbeatRowSources')
    // The sources are said once, so a writer cannot carry a different list.
    expect(main.match(/deviceActions: \(\) =>/g)).toHaveLength(1)
    expect(main.match(/sessionDigest: \(\) =>/g)).toHaveLength(1)
  })

  it('goes red on a writer that leaves them out', () => {
    const broken = main.replace("  ...heartbeatRowSources,\n  ...deviceLabelOption,", '  ...deviceLabelOption,')
    expect(broken).not.toBe(main)
    expect(writers(broken).every((options) => options.includes('...heartbeatRowSources'))).toBe(false)
  })

  it('the shared identity resolver publishes current actions on its first registration without overwriting them', async () => {
    const env = await isolatedGuguEnv('gugu-7317-first-registration-')
    env.GUGU_SERVER_MODE = '1'
    env.GUGU_SERVER_HOME = env.GUGU_HOME
    const client = new MemoryHeartbeatClient()
    const actions = { v: 1, updated_at: '', actions: [], switched_off: [{ group: 'computer', detail: 'Computer Use is off' }] }
    const resolve = createLocalDeviceIdResolver({
      env,
      getAuth: async () => ({ accessToken: 'test', userId: 'user-7317' }),
      heartbeatClient: () => client,
      capabilities: async () => ({ terminals: [], runtimes: [] }),
      deviceActions: () => actions,
      sessionDigest: () => [],
      warn: (message) => { throw new Error(message) },
    })
    const id = await resolve()
    expect(id).toBeTruthy()
    expect(client.upserts).toHaveLength(1)
    expect(client.upserts[0].row.capabilities).toMatchObject({ actions })
    expect(await resolve()).toBe(id)
    expect(client.upserts).toHaveLength(1)
  })
})
