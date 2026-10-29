// @vitest-environment jsdom
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DevicesSection } from '@/components/settings/DevicesSection'
import { DevicesContext, type DevicesContextValue } from '@/store/devicesContext'
import type { Device } from '@gugu/core/shared/types/chat'
const retryMatch = vi.hoisted(() => vi.fn(async (_deviceId: string) => true))
vi.mock('@/lib/serverVersionRetry', () => ({ retryServerVersionMatch: retryMatch }))
function device(overrides: Partial<Device> = {}): Device {
  return {
    device_id: 'remote',
    label: 'Remote Mac',
    hostname: 'remote.local',
    platform: 'mac',
    status: 'online',
    last_seen_at: '2026-07-02T00:00:00.000Z',
    is_online: true,
    is_current_device: false,
    capabilities: { terminals: [], runtimes: [], host_runtime_capability: 0 },
    ...overrides,
  }
}
function store(overrides: Partial<DevicesContextValue> = {}): DevicesContextValue {
  return {
    devices: [device()],
    loading: false,
    error: null,
    refresh: vi.fn(async () => {}),
    rename: vi.fn(async () => {}),
    remove: vi.fn(async () => {}),
    listBoundAgents: vi.fn(async () => []),
    ...overrides,
  }
}
async function flush(): Promise<void> {
  await act(async () => {
    await Promise.resolve()
    await Promise.resolve()
  })
}
function buttonByText(root: ParentNode, text: string): HTMLButtonElement {
  const button = Array.from(root.querySelectorAll('button')).find((candidate) => candidate.textContent?.trim() === text)
  if (!button) throw new Error(`button not found: ${text}`)
  return button as HTMLButtonElement
}
async function openMenu(row = 0): Promise<void> {
  const trigger = container.querySelectorAll<HTMLElement>('[data-testid="settings-device-menu-button"]')[row]!
  await act(async () => {
    trigger.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }))
    trigger.click()
  })
  await flush()
}
async function openMenuItem(testId: string, row = 0): Promise<void> {
  await openMenu(row)
  const item = document.body.querySelector<HTMLElement>(`[data-testid="${testId}"]`)
  if (!item) throw new Error(`menu item not found: ${testId}`)
  await act(async () => {
    item.click()
  })
  await flush()
}
let container: HTMLDivElement
let root: Root
beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})
afterEach(() => {
  act(() => root.unmount())
  container.remove()
  vi.restoreAllMocks()
})
describe('DevicesSection interaction', () => {
  it('groups physical machines but retains both tier configurations in details', async () => {
    const value = store({ devices: [device({ device_id: 'old', machine_id: 'same-mac', tier: 'acceptance-tasks431', is_online: false }),
      device({ device_id: 'active', machine_id: 'same-mac', tier: 'beta' })] })
    await act(async () => { root.render(createElement(DevicesContext.Provider, { value }, createElement(DevicesSection))) })
    expect(container.querySelectorAll('[data-testid="settings-device-row"]')).toHaveLength(1)
    expect(container.querySelector('[data-testid="settings-device-version-count"]')?.textContent).toBe('2 个版本')
    await openMenuItem('settings-device-open-actions')
    const configurations = container.querySelector('[data-testid="device-machine-configurations"]')!
    expect(configurations.textContent).toContain('咕咕 Beta')
    expect(configurations.textContent).toContain('acceptance-tasks431')
    expect(configurations.querySelectorAll('.gg-settings-row[data-testid^="device-configuration-"]')).toHaveLength(2)
    expect(value.remove).not.toHaveBeenCalled()
    expect(value.rename).not.toHaveBeenCalled()
    const removeOld = configurations.querySelector<HTMLButtonElement>('[data-testid="device-configuration-remove-old"]')!
    expect(removeOld.textContent).toBe('移除这个版本')
    expect(configurations.textContent).not.toContain('移除这台机器')
    await act(async () => { removeOld.click() })
    await flush()
    expect(value.listBoundAgents).toHaveBeenCalledWith('old')
    const dialog = document.body.querySelector('[data-testid="settings-device-remove-dialog"]')!
    expect(dialog.textContent).toContain('移除「Remote Mac」的「acceptance-tasks431」？')
    expect(dialog.textContent).toContain('这个版本下次打开时会重新出现')
    expect(dialog.textContent).not.toContain('移除这台机器')
    expect(buttonByText(dialog, '移除这个版本')).not.toBeNull()
    expect(value.remove).not.toHaveBeenCalled()
  })

  it('opens the confirmation sheet above the settings layer and removes an unbound device', async () => {
    const value = store()
    await act(async () => {
      root.render(
        createElement(
          DevicesContext.Provider,
          { value },
          createElement(DevicesSection),
        ),
      )
    })
    await openMenuItem('settings-device-remove-button')
    const dialog = document.body.querySelector('[data-testid="settings-device-remove-dialog"]') as HTMLElement | null
    expect(dialog).not.toBeNull()
    expect(dialog?.closest('.gg-sheet-viewport')).not.toBeNull()
    expect((dialog?.closest('.gg-sheet-viewport') as HTMLElement).style.zIndex).toBe('var(--z-settings-modal)')
    await act(async () => {
      buttonByText(dialog!, '移除这台机器').click()
    })
    await flush()
    expect(value.remove).toHaveBeenCalledWith('remote', { cascade: false })
    expect(document.body.querySelector('[data-testid="settings-device-remove-dialog"]')).toBeNull()
  })
  // owner 10-28: a reinstall / a new data directory leaves the old row; it is said, with its removal (the usual confirmation).
  it('an old row an online one of the same host name may have replaced: said, why on hover and on a press, removed only when confirmed', async () => {
    const value = store({ devices: [
      device({ device_id: 'new', label: 'GF server', hostname: 'di-host', machine_id: 'm-new', created_at: '2026-10-28T10:00:00Z', last_seen_at: '2026-10-28T12:00:00Z',
        capabilities: { terminals: [], runtimes: [], host_runtime_capability: 0, host_kind: 'server' } }),
      device({ device_id: 'old', label: 'GF server (old)', hostname: 'di-host', machine_id: 'm-old', status: 'offline', is_online: false,
        created_at: '2026-09-01T00:00:00Z', last_seen_at: '2026-10-27T09:00:00Z', capabilities: { terminals: [], runtimes: [], host_runtime_capability: 0, host_kind: 'server' } }),
    ] })
    await act(async () => { root.render(createElement(DevicesContext.Provider, { value }, createElement(DevicesSection))) })
    const row = (id: string) => container.querySelector(`[data-device-id="${id}"]`) as HTMLElement
    expect(row('new').querySelector('[data-testid="settings-device-replaced"]'), 'the online one is not the one said of').toBeNull()
    const hint = row('old').querySelector<HTMLButtonElement>('[data-testid="settings-device-replaced-hint"]')!
    expect(hint.textContent).toBe('可能已被「GF server」顶替')
    expect(hint.title).toContain('两台机器也可能本来就同名')
    await act(async () => { hint.click() })
    expect(row('old').querySelector('[data-testid="settings-device-replaced-why"]')!.textContent).toBe(hint.title)
    await act(async () => { row('old').querySelector<HTMLElement>('[data-testid="settings-device-replaced-remove"]')!.click() })
    await flush()
    const dialog = document.body.querySelector('[data-testid="settings-device-remove-dialog"]') as HTMLElement
    expect(dialog.querySelector('[data-testid="settings-device-remove-replaced"]')!.textContent).toBe('这台可能已被「GF server」顶替。')
    expect(dialog.textContent).toContain('只存在它上面的文件记录')
    expect(value.remove, 'nothing removed until confirmed').not.toHaveBeenCalled()
    await act(async () => { buttonByText(dialog, '移除这台机器').click() })
    await flush()
    expect(value.remove).toHaveBeenCalledWith('old', { cascade: false })
  })

  it('requires explicit cascade confirmation before removing a device with bound agents', async () => {
    const value = store({
      listBoundAgents: vi.fn(async () => [
        { id: 'agent-1', display_name: 'Research Agent', avatar: null },
      ]),
    })
    await act(async () => {
      root.render(
        createElement(
          DevicesContext.Provider,
          { value },
          createElement(DevicesSection),
        ),
      )
    })
    await openMenuItem('settings-device-remove-button')
    const dialog = document.body.querySelector('[data-testid="settings-device-remove-dialog"]') as HTMLElement
    const confirmButton = buttonByText(dialog, '移除这台机器')
    expect(confirmButton.disabled).toBe(true)
    const checkbox = dialog.querySelector('input[type="checkbox"]') as HTMLInputElement
    await act(async () => {
      checkbox.click()
    })
    await flush()
    expect(confirmButton.disabled).toBe(false)
    await act(async () => {
      confirmButton.click()
    })
    await flush()
    expect(value.remove).toHaveBeenCalledWith('remote', { cascade: true })
  })

  it('#6264 每行写清是台什么机器:系统 · 架构、server 版本 + 升级状态、上次在线、经 SSH 的地址', async () => {
    const invoke = vi.fn(async (channel: string) => (channel === 'server-ssh-machines:describe' ? [{ deviceId: 'srv', display: 'alice@box:2222' }] : null))
    ;(window as unknown as { electronAPI: unknown }).electronAPI = { invoke, eventOn: () => () => undefined }
    try {
      const value = store({
        devices: [
          device({ device_id: 'me', label: 'MacBook', is_current_device: true, platform: 'darwin', capabilities: { terminals: [], runtimes: [], app_version: '0.2.99', os_name: 'macOS 26', arch: 'arm64', host_kind: 'desktop' } }),
          device({
            device_id: 'srv', label: 'Linux 1', platform: 'linux', status: 'offline', is_online: false,
            last_seen_at: new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString(),
            capabilities: { terminals: [], runtimes: [], app_version: '0.2.99', os_name: 'Ubuntu 22.04.5 LTS', arch: 'arm64', host_kind: 'server', server_update: { state: 'ready', version: '0.3.0' } },
          }),
        ],
      })
      await act(async () => {
        root.render(createElement(DevicesContext.Provider, { value }, createElement(DevicesSection)))
      })
      await flush()
      const rows = container.querySelectorAll<HTMLElement>('[data-testid="settings-device-row"]')
      const server = Array.from(rows).find((row) => row.dataset.deviceId === 'srv')!
      expect(server.dataset.kind).toBe('server')
      expect(server.textContent).toContain('Ubuntu 22.04.5 LTS · arm64')
      expect(server.textContent).toContain('咕咕 server 0.2.99')
      expect(server.textContent).toContain('有新版本')
      expect(server.textContent).toContain('上次在线 3 小时前')
      expect(server.textContent).toContain('远程 SSH：alice@box:2222')
      const me = Array.from(rows).find((row) => row.dataset.deviceId === 'me')!
      expect(me.textContent).toContain('本机')
      expect(me.textContent).not.toContain('远程')
      // 本机的菜单只有改名,没有移除
      await openMenu(0)
      expect(document.body.querySelector('[data-testid="settings-device-rename-button"]')).not.toBeNull()
      expect(document.body.querySelector('[data-testid="settings-device-remove-button"]')).toBeNull()
    } finally {
      delete (window as unknown as { electronAPI?: unknown }).electronAPI
    }
  })

  it('#6264 远程隧道的机器换成匹配版本没成:状态行「更新没成功 · 重试」,点了经设备 RPC 请它再试,先说「正在更新」', async () => {
    const value = store({
      devices: [
        device({
          device_id: 'srv', label: 'Linux 1', platform: 'linux',
          capabilities: { terminals: [], runtimes: [], app_version: '0.3.0', host_kind: 'server', server_update: { state: 'failed', version: '0.2.9' } },
        }),
      ],
    })
    await act(async () => {
      root.render(createElement(DevicesContext.Provider, { value }, createElement(DevicesSection)))
    })
    await flush()
    const row = container.querySelector<HTMLElement>('[data-testid="settings-device-match-failed"]')!
    expect(row.textContent).toContain('更新没成功')
    // 不再挂一颗「更新中 / 有新版本」的标签。
    expect(container.querySelector('[data-testid="settings-device-update"]')).toBeNull()
    await act(async () => {
      container.querySelector<HTMLElement>('[data-testid="settings-device-match-retry"]')!.click()
    })
    await flush()
    expect(retryMatch).toHaveBeenCalledWith('srv')
    expect(container.querySelector('[data-testid="settings-device-match-failed"]')!.textContent).toContain('正在更新')
  })

  it('#6264 连法只标在咕咕 server 上:SSH 装的「远程 SSH：地址」、只经云端的「远程隧道」;另一台咕咕桌面不标连法', async () => {
    const invoke = vi.fn(async (channel: string) => (channel === 'server-ssh-machines:describe' ? [{ deviceId: 'ssh-srv', display: 'alice@box' }] : null))
    ;(window as unknown as { electronAPI: unknown }).electronAPI = { invoke, eventOn: () => () => undefined }
    try {
      const server = (id: string) => device({ device_id: id, label: id, platform: 'linux', capabilities: { terminals: [], runtimes: [], host_kind: 'server' } })
      const value = store({
        devices: [
          server('ssh-srv'),
          server('tunnel-srv'),
          device({ device_id: 'other-mac', label: 'Other Mac', platform: 'darwin', capabilities: { terminals: [], runtimes: [], host_kind: 'desktop' } }),
        ],
      })
      await act(async () => {
        root.render(createElement(DevicesContext.Provider, { value }, createElement(DevicesSection)))
      })
      await flush()
      const row = (id: string) => container.querySelector<HTMLElement>(`[data-testid="settings-device-row"][data-device-id="${id}"]`)!
      expect(row('ssh-srv').textContent).toContain('远程 SSH：alice@box')
      expect(row('ssh-srv').textContent).not.toContain('远程隧道')
      expect(row('tunnel-srv').textContent).toContain('远程隧道')
      expect(row('other-mac').dataset.kind).toBe('desktop')
      expect(row('other-mac').textContent).not.toContain('远程')
      // 「是台什么机器」写成元信息里的一个词,❌ 只靠一枚带 aria-label 的图标(icon standing in for a label)。
      expect(row('other-mac').querySelector('[data-testid="settings-device-kind"]')?.textContent).toBe('电脑')
    } finally {
      delete (window as unknown as { electronAPI?: unknown }).electronAPI
    }
  })

  it('#6264 移除离线的 server:确认页说清会退出你的账号、别人不受影响、离线照样生效', async () => {
    const value = store({
      devices: [device({ device_id: 'srv', label: 'Linux 1', platform: 'linux', status: 'offline', is_online: false, capabilities: { terminals: [], runtimes: [], host_kind: 'server' } })],
    })
    await act(async () => {
      root.render(createElement(DevicesContext.Provider, { value }, createElement(DevicesSection)))
    })
    await openMenuItem('settings-device-remove-button')
    const dialog = document.body.querySelector('[data-testid="settings-device-remove-dialog"]') as HTMLElement
    expect(dialog.textContent).toContain('将在这台机器上退出你的账号')
    expect(dialog.textContent).toContain('下次联网时会退出你的账号')
  })

  it('#6264 只有本机 ⇒ 空状态说明添加机器带来什么;机器多了能搜', async () => {
    const only = store({ devices: [device({ device_id: 'me', is_current_device: true })] })
    await act(async () => {
      root.render(createElement(DevicesContext.Provider, { value: only }, createElement(DevicesSection)))
    })
    expect(container.querySelector('[data-testid="settings-devices-empty"]')?.textContent).toContain('目前只有这台电脑')
    expect(container.querySelector('[data-testid="settings-devices-search"]')).toBeNull()

    const many = store({
      devices: [
        device({ device_id: 'me', label: 'MacBook', is_current_device: true }),
        device({ device_id: 'gpu', label: 'Lab GPU' }),
        device({ device_id: 'nas', label: 'NAS' }),
      ],
    })
    await act(async () => {
      root.render(createElement(DevicesContext.Provider, { value: many }, createElement(DevicesSection)))
    })
    expect(container.querySelector('[data-testid="settings-devices-empty"]')).toBeNull()
    const input = container.querySelector<HTMLInputElement>('[data-testid="settings-devices-search"] input, input[data-testid="settings-devices-search"]')!
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
      setter.call(input, 'gpu')
      input.dispatchEvent(new Event('input', { bubbles: true }))
    })
    const ids = Array.from(container.querySelectorAll<HTMLElement>('[data-testid="settings-device-row"]')).map((row) => row.dataset.deviceId)
    expect(ids).toEqual(['gpu'])
  })

  it('#6264 SSH 装上的 server:菜单里有复制地址,与移除分开的「卸载」', async () => {
    const invoke = vi.fn(async (channel: string) => (channel === 'server-ssh-machines:describe' ? [{ deviceId: 'srv', display: 'alice@box' }] : null))
    ;(window as unknown as { electronAPI: unknown }).electronAPI = { invoke, eventOn: () => () => undefined }
    try {
      const value = store({ devices: [device({ device_id: 'srv', label: 'Linux 1', capabilities: { terminals: [], runtimes: [], host_kind: 'server' } })] })
      await act(async () => {
        root.render(createElement(DevicesContext.Provider, { value }, createElement(DevicesSection)))
      })
      await flush()
      await openMenu(0)
      expect(document.body.querySelector('[data-testid="settings-device-copy-address"]')).not.toBeNull()
      expect(document.body.querySelector('[data-testid="settings-device-remove-button"]')?.textContent).toContain('移除这台机器')
      expect(document.body.querySelector('[data-testid="settings-device-uninstall-button"]')?.textContent).toContain('卸载咕咕 server')
    } finally {
      delete (window as unknown as { electronAPI?: unknown }).electronAPI
    }
  })
  it('#6264 在线的别的机器:菜单里有「重新连接」(侧栏机器名不再有菜单,这是它唯一的入口),点了交给任务页那一半', async () => {
    const reconnect = vi.fn()
    const w = window as unknown as Record<string, unknown>
    w.__GUGU_SESSIONPAGE_RECONNECT_DEVICE__ = reconnect
    try {
      const value = store({ devices: [device({ device_id: 'srv', label: 'Linux 1', capabilities: { terminals: [], runtimes: [], host_kind: 'server' } })] })
      await act(async () => {
        root.render(createElement(DevicesContext.Provider, { value }, createElement(DevicesSection)))
      })
      await flush()
      await openMenuItem('settings-device-reconnect')
      expect(reconnect).toHaveBeenCalledWith('srv')
    } finally {
      delete w.__GUGU_SESSIONPAGE_RECONNECT_DEVICE__
    }
  })

  it('#6264 离线的机器、或这个装配里没有任务页:不出「重新连接」', async () => {
    const value = store({ devices: [device({ device_id: 'srv', is_online: false, status: 'offline' })] })
    await act(async () => {
      root.render(createElement(DevicesContext.Provider, { value }, createElement(DevicesSection)))
    })
    await flush()
    await openMenu(0)
    expect(document.body.querySelector('[data-testid="settings-device-reconnect"]')).toBeNull()
  })
})
