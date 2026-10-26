// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { ConnectMoreDevices } from '../../../../apps/desktop/src/components/devices/ConnectMoreDevices'
import { GUGU_DOWNLOAD_URLS } from '../../../../apps/desktop/src/lib/appLinks'
import { createReactHarness, clickElement, renderWithAppProviders } from '../../../support/testHarness'

const state = vi.hoisted(() => ({ kind: 'capacitor', ipc: false }))
vi.mock('../../../../apps/desktop/src/platform', () => ({ platform: { get kind() { return state.kind } } }))
vi.mock('../../../../apps/desktop/src/platform/desktopIpc', () => ({ desktopIpc: () => state.ipc ? {} : null }))

let harness: ReturnType<typeof createReactHarness>
beforeEach(() => { harness = createReactHarness(); state.kind = 'capacitor'; state.ipc = false })
afterEach(() => harness.cleanup())
const find = (id: string) => harness.container.querySelector<HTMLElement>(`[data-testid="${id}"]`)

it.each(['capacitor', 'electron', 'web'])('offers only working connection guides on %s', async kind => {
  state.kind = kind
  state.ipc = kind === 'electron'
  await renderWithAppProviders(harness, <ConnectMoreDevices />)
  const group = find('assistant-devices-connect-more')!
  const rows = [...group.querySelectorAll('[role="button"]')]
  expect(rows.map(row => row.querySelector('.gg-settings-row-title')?.textContent)).toEqual([
    '连接你的 Mac', '连接 Windows 电脑', '连接 Linux 电脑', '连接你的安卓手机',
    ...(state.ipc ? ['添加一台服务器'] : []),
  ])
  expect(group.textContent).not.toMatch(/iPhone|浏览器插件|即将推出|暂未开放/)
  expect(group.querySelector('[aria-disabled="true"]')).toBeNull()
})

it('expands every supported guide and opens its real download without losing the signed-in account', async () => {
  const open = vi.spyOn(window, 'open').mockImplementation(() => null)
  await renderWithAppProviders(harness, <ConnectMoreDevices />, { auth: { email: 'test@example.com' } })
  const downloads = {
    mac: [GUGU_DOWNLOAD_URLS.macArm64, GUGU_DOWNLOAD_URLS.macX64],
    windows: [GUGU_DOWNLOAD_URLS.windowsX64],
    linux: [GUGU_DOWNLOAD_URLS.linuxX64],
    android: [GUGU_DOWNLOAD_URLS.android],
  }
  for (const [key, urls] of Object.entries(downloads)) {
    const row = find(`assistant-connect-${key}`)!.querySelector<HTMLElement>('[role="button"]')!
    await clickElement(row)
    expect(row.getAttribute('aria-expanded')).toBe('true')
    const guide = find(`assistant-connect-guide-${key}`)!
    expect(guide.textContent).toContain('test@example.com')
    const buttons = [...guide.querySelectorAll<HTMLElement>(`[data-testid="assistant-connect-download-${key}"]`)]
    expect(buttons).toHaveLength(urls.length)
    for (const [index, button] of buttons.entries()) {
      await clickElement(button)
      expect(open).toHaveBeenLastCalledWith(urls[index], '_blank', 'noopener,noreferrer')
    }
    await clickElement(row)
    expect(find(`assistant-connect-guide-${key}`)).toBeNull()
  }
})
