import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ActionFamily, FamilyDeps } from '../../../../apps/desktop/electron/device-actions/catalog'
import { createComputerFamily } from '../../../../apps/desktop/electron/device-actions/families/computer'
import { createDeviceActionGrantsStore } from '../../../../apps/desktop/electron/device-actions/grants-store'
import { createDeviceActionsProvider } from '../../../../apps/desktop/electron/device-actions/provider'
import { createDeviceActionsRuntime } from '../../../../apps/desktop/electron/device-actions/runtime'

/**
 * #7317 连「电脑控制」时两项系统授权一次都问(owner 10-16「这两个权限请求应该是一开始就弄好」):缺的一起说出来,
 * 带上第一项缺的那一页,替人把那一页打开(spec system-permissions「系统不再弹框 → 直接跳到对应的设置页」),
 * 缺屏幕录制时说明要重启咕咕。macOS 的回答是注入的假件:测的是问法、说法与去哪一页,❌ 测系统本身。
 */

const PANE = (name: string) => `x-apple.systempreferences:com.apple.preference.security?${name}`
let dir: string

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gugu-7317-connect-'))
  fs.writeFileSync(path.join(dir, 'cua-tools.json'), JSON.stringify({ tools: [], version: '0.35.4' }))
})
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }))

/** The provider with the real computer family; macOS answers each permission as `granted` says. */
function connectWith(granted: { accessibility: boolean; screen: boolean }) {
  const asked: string[] = []
  const stop = vi.fn()
  const deps = {
    platform: 'darwin',
    nativeDir: dir,
    now: () => new Date(),
    homedir: () => dir,
    macHelper: () => ({
      available: () => ({ ok: true as const }),
      call: async (_method: string, params?: unknown) => {
        const kind = (params as { kind: 'accessibility' | 'screen' }).kind
        asked.push(kind)
        return { status: granted[kind] ? 'granted' : 'denied', settingsUrl: PANE(kind === 'screen' ? 'Privacy_ScreenCapture' : 'Privacy_Accessibility') }
      },
      dispose: () => undefined,
    }),
    cua: () => ({ available: () => ({ ok: true as const }), callTool: vi.fn(), stop, dispose: () => undefined }),
  } as unknown as FamilyDeps
  const store = createDeviceActionGrantsStore(path.join(dir, `grants-${Math.random()}.json`))
  const { connect } = createDeviceActionsProvider({ store, families: [createComputerFamily(dir)], deps })
  return { result: connect('computer'), asked, stop }
}

describe('#7317 connecting computer control asks for both permissions at once', () => {
  it('asks for both even when the first is missing, says every one missing, and points at the first one\'s page', async () => {
    const both = connectWith({ accessibility: false, screen: false })
    const result = await both.result
    expect(both.asked).toEqual(['accessibility', 'screen'])
    expect(result).toMatchObject({ ok: false, code: 'os_permission', settingsUrl: PANE('Privacy_Accessibility'), restart: true })
    expect(!result.ok && result.message).toMatch(/辅助功能」和「屏幕录制/)
    expect(both.stop).toHaveBeenCalled()
  })

  it('a missing Screen Recording goes to its own page and asks for a restart; Accessibility alone needs none', async () => {
    const screen = await connectWith({ accessibility: true, screen: false }).result
    expect(screen).toMatchObject({ ok: false, settingsUrl: PANE('Privacy_ScreenCapture'), restart: true })
    expect(!screen.ok && screen.message).toMatch(/重启咕咕/)
    const ax = await connectWith({ accessibility: false, screen: true }).result
    expect(ax).toMatchObject({ ok: false, settingsUrl: PANE('Privacy_Accessibility') })
    expect('restart' in ax).toBe(false)
    // Control: both there, connected.
    expect(await connectWith({ accessibility: true, screen: true }).result).toEqual({ ok: true })
  })

  it('opens the missing permission\'s page for the person when connecting fails for it, and says it did', async () => {
    const opened: string[] = []
    let opens = true
    const family: ActionFamily = {
      groups: [
        { id: 'computer', platforms: ['darwin'], settingsUrl: PANE('Privacy_Accessibility'),
          probe: async () => Object.assign({ ok: false as const, code: 'os_permission' as const, message: 'no screen' }, { settingsUrl: PANE('Privacy_ScreenCapture'), restart: true }) },
        { id: 'clipboard', platforms: ['darwin'], probe: async () => ({ ok: false as const, code: 'execution_failed' as const, message: 'broken' }) },
      ],
      actions: [],
    }
    const runtime = createDeviceActionsRuntime({
      deviceId: async () => "local-test",
      userData: dir,
      deps: {} as never,
      nativeDir: null,
      isPackaged: false,
      appVersion: '0.0.0',
      serverMode: false,
      openSystemSettings: async (url) => {
        if (!opens) throw new Error('could not open')
        opened.push(url)
      },
      log: { info: () => undefined, warn: () => undefined },
      families: [family],
      platform: 'darwin',
    })
    const handlers = new Map<string, (event: unknown, ...args: unknown[]) => unknown>()
    runtime.registerIpc({ handle: (channel: string, handler: (event: unknown, ...args: unknown[]) => unknown) => { handlers.set(channel, handler) } } as never, () => [])
    const connect = handlers.get('device-actions:connect')!
    expect(await connect({}, 'computer')).toMatchObject({ ok: false, settingsUrl: PANE('Privacy_ScreenCapture'), restart: true, openedSettings: true, message: 'no screen(已打开系统设置里对应的那一页)' })
    expect(opened).toEqual([PANE('Privacy_ScreenCapture')])
    // The page could not be opened: it is not said to be, ❌ the person waiting for a window that never comes.
    opens = false
    const unopened = await connect({}, 'computer')
    expect(unopened).toMatchObject({ ok: false, message: 'no screen' })
    expect(unopened).not.toHaveProperty('openedSettings')
    opens = true
    // Control: a failure that is not a missing permission opens nothing.
    expect(await connect({}, 'clipboard')).not.toHaveProperty('openedSettings')
    expect(opened).toHaveLength(1)
    runtime.dispose()
  })
})
