import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createDeviceActionCaller } from '@gugu/core/cloud/deviceActionCaller'
import { ok, type ActionDef, type ActionFamily } from '../../../../apps/desktop/electron/device-actions/catalog'
import { createDeviceActionsRuntime } from '../../../../apps/desktop/electron/device-actions/runtime'
import type { DeviceActionsState } from '../../../../apps/desktop/src/lib/deviceActionsIpc'

/**
 * #7317 behavior tab-extensions「Computer Use 是电脑控制的开关」(owner 10-16「我要求的是这个功能(或者说这个 App)是可插拔的」):
 * Computer Use 装着、启用着,这台电脑才有电脑控制 —— 关着就不登记(agent 看不到、不占 token)、点名调用如实说没装;
 * 开着就是连上了,❌ 设置里另有一个「连接」(那一组不在设置页的列表里,由 App 的页面办系统授权)。
 */

let dir: string
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gugu-7317-switch-'))
})
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }))

const action = (name: string, group: string): ActionDef => ({
  name, group, title: name, titleEn: name, description: `${name}.`, risk: 'low', confirm: 'never', input_schema: { type: 'object' },
  run: async () => ok({ done: name }),
})

function setup() {
  let on = false
  const probed: string[] = []
  const family: ActionFamily = {
    groups: [
      { id: 'computer', platforms: ['darwin'], probe: async () => { probed.push('computer'); return ok(null) } },
      { id: 'clipboard', platforms: ['darwin'] },
    ],
    actions: [action('computer.click', 'computer'), action('clipboard.read', 'clipboard')],
  }
  const runtime = createDeviceActionsRuntime({
    userData: dir,
    deps: {} as never,
    nativeDir: null,
    isPackaged: false,
    appVersion: '0.0.0',
    serverMode: false,
    openSystemSettings: async () => undefined,
    log: { info: () => undefined, warn: () => undefined },
    families: [family],
    platform: 'darwin',
    appSwitch: { group: 'computer', app: 'Computer Use', on: () => on },
  })
  const handlers = new Map<string, (event: unknown, ...args: unknown[]) => unknown>()
  const sent: string[] = []
  const window = { isDestroyed: () => false, webContents: { send: (channel: string) => sent.push(channel) } }
  runtime.registerIpc({ handle: (channel: string, handler: (event: unknown, ...args: unknown[]) => unknown) => { handlers.set(channel, handler) } } as never, () => [window])
  const call = (channel: string, ...args: unknown[]) => handlers.get(`device-actions:${channel}`)!({}, ...args)
  const listed = () => (runtime.capability()?.actions ?? []).map((entry) => entry.name)
  return { runtime, call, listed, probed, sent, turn: (next: boolean) => { on = next } }
}

describe('#7317 Computer Use is the switch of computer control', () => {
  it('off: this computer has no computer control — not listed, refused by name, asked for no permission', async () => {
    const { runtime, call, listed, probed } = setup()
    // Not listed, so no agent reads it; the control: a group not switched by an App is listed as before.
    expect(listed()).toEqual(['clipboard.read'])
    const refused = await runtime.readLocal('computer.click', {})
    expect(refused).toMatchObject({ ok: false, code: 'not_granted' })
    expect(!refused.ok && refused.message).toMatch(/Computer Use is not installed or is switched off/)
    expect(await call('connect', 'computer')).toMatchObject({ ok: false, code: 'unsupported' })
    expect(probed).toEqual([])
    runtime.dispose()
  })

  it('off, called the way an agent calls it (through the caller, from what this computer published): says Computer Use is off', async () => {
    const { runtime, turn } = setup()
    // What the heartbeat row carries: the published capability, through JSON.
    const published = () => JSON.parse(JSON.stringify(runtime.capability())) as unknown
    const caller = createDeviceActionCaller({
      listDevices: async () => [{ device_id: 'mac', label: 'MacBook', online: true, last_seen_at: new Date().toISOString(), actions: published() }],
      rpc: async () => { throw new Error('nothing may be sent for an action this computer does not have') },
    })
    const refused = await caller.call({ deviceId: 'mac', action: 'computer.click' })
    expect(refused).toMatchObject({ ok: false, code: 'not_granted' })
    expect(!refused.ok && refused.message).toMatch(/Computer Use is not installed or is switched off/)
    await expect(caller.describe('mac', { name: 'computer.click' })).rejects.toThrow(/Computer Use is not installed or is switched off/)
    // Still not listed: its actions cost no agent a token.
    expect(JSON.stringify(await caller.describe('mac'))).not.toMatch(/computer\./)
    // Control: a name in no switched-off group is still "no such action".
    expect(await caller.call({ deviceId: 'mac', action: 'computr.click' })).toMatchObject({ ok: false, code: 'unknown_action' })
    // Switched on, nothing is published as off.
    turn(true)
    expect(runtime.capability()?.switched_off).toBeUndefined()
    runtime.dispose()
  })

  it('on: connected by the App alone — no second 「连接」, and asking for the permissions records no grant of its own', async () => {
    const { runtime, call, listed, probed, turn } = setup()
    turn(true)
    expect(listed()).toEqual(['computer.click', 'clipboard.read'])
    expect(runtime.capability()?.actions.find((entry) => entry.name === 'computer.click')).toMatchObject({ available: true })
    expect(await runtime.readLocal('computer.click', {})).toEqual({ ok: true, data: { done: 'computer.click' } })
    // The App's page asks the system for what it needs: that is all connecting does here.
    expect(await call('connect', 'computer')).toEqual({ ok: true })
    expect(probed).toEqual(['computer'])
    // Settings lists it no more: the App's page has it.
    const state = (await call('state')) as DeviceActionsState
    expect(state.groups.map((group) => group.id)).toEqual(['clipboard'])
    expect(state.managed).toMatchObject([{ id: 'computer', app: 'Computer Use', connected: true }])
    // Switched off again: nothing kept it on (no grant was written by that connect).
    turn(false)
    expect(listed()).toEqual(['clipboard.read'])
    expect(await runtime.readLocal('computer.click', {})).toMatchObject({ ok: false, code: 'not_granted' })
    expect(((await call('state')) as DeviceActionsState).managed).toMatchObject([{ id: 'computer', connected: false }])
    // Control: a group not switched by an App still needs its own 「连接」.
    expect(await runtime.readLocal('clipboard.read', {})).toMatchObject({ ok: false, code: 'not_granted' })
    expect(await call('connect', 'clipboard')).toEqual({ ok: true })
    expect(await runtime.readLocal('clipboard.read', {})).toEqual({ ok: true, data: { done: 'clipboard.read' } })
    runtime.dispose()
  })

  it('a flip tells whoever re-registers this computer\'s actions and the open settings pages, at once', () => {
    const { runtime, sent, turn } = setup()
    const heard: string[] = []
    const off = runtime.onGrantsChanged(() => heard.push('re-register'))
    turn(true)
    runtime.switchChanged()
    expect(heard).toEqual(['re-register'])
    expect(sent).toEqual(['device-actions:changed'])
    // Control: a listener gone hears no more.
    off()
    turn(false)
    runtime.switchChanged()
    expect(heard).toEqual(['re-register'])
    runtime.dispose()
  })
})
