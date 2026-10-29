// @vitest-environment jsdom
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DevicesSection } from '@/components/settings/DevicesSection'
import { ToastContext } from '@/components/toastContext'
import { DevicesContext, type DevicesContextValue } from '@/store/devicesContext'
import type { Device } from '@gugu/core/shared/types/chat'

const retry = vi.hoisted(() => vi.fn(async (_deviceId: string) => true))
const restart = vi.hoisted(() => vi.fn(async (_deviceId: string, _version: string) => true))
vi.mock('@/lib/serverVersionRetry', () => ({ retryServerVersionMatch: retry, restartServerVersionNow: restart }))

const current = '0.2.58-beta.1056.1'
const target = '0.2.58-beta.1057.1'
function server(update: Device['capabilities']['server_update'] = { state: 'ready', version: target }, version = current): Device {
  return { device_id: 'remote', label: 'Remote', hostname: 'remote', platform: 'linux', status: 'online', is_online: true,
    last_seen_at: '2026-10-29T00:00:00Z', capabilities: { terminals: [], runtimes: [], host_kind: 'server', server_confirmed_restart: true, app_version: version, server_update: update } }
}
let container: HTMLDivElement
let root: Root
const toast = vi.fn()
async function render(device = server()) {
  const value: DevicesContextValue = { devices: [device], loading: false, error: null, refresh: vi.fn(async () => {}),
    rename: vi.fn(async () => {}), remove: vi.fn(async () => {}), listBoundAgents: vi.fn(async () => []) }
  await act(async () => { root.render(createElement(ToastContext.Provider, { value: { toast } },
    createElement(DevicesContext.Provider, { value }, createElement(DevicesSection)))) })
}
function node(id: string) { return container.querySelector<HTMLElement>(`[data-testid="settings-device-${id}"]`) }
async function click(id: string) {
  expect(node(id)).not.toBeNull()
  await act(async () => { node(id)!.click() })
}
beforeEach(() => {
  restart.mockReset().mockResolvedValue(true)
  retry.mockReset().mockResolvedValue(true)
  toast.mockReset()
  container = document.createElement('div'); document.body.appendChild(container); root = createRoot(container)
})
afterEach(() => {
  act(() => root.unmount()); container.remove(); vi.useRealTimers()
})

describe('confirmed server update feedback', () => {
  it('shows the actual download target and a known waiting count, leaving an unknown count unspecified', async () => {
    await render(server({ state: 'downloading', version: target }))
    expect(node('update')!.textContent).toContain(target)
    await render(server({ state: 'ready', version: target, busy_agents: 2 }))
    expect(node('update')!.textContent).toContain('2 个任务')
    await render()
    expect(node('update')!.textContent).toBe('新版本已就绪，等待空闲')
  })

  it('does not offer confirmed restart to an older server', async () => {
    const legacy = server({ state: 'ready', version: target }, '0.2.58')
    delete legacy.capabilities.server_confirmed_restart
    await render(legacy)
    expect(node('update-now')).toBeNull()
    expect(retry).not.toHaveBeenCalled()
  })

  it('confirms once, keeps Restarting after the RPC ack, and finishes on the new version heartbeat', async () => {
    await render()
    await click('update-now')
    expect(retry).not.toHaveBeenCalled()
    await click('update-now-yes')
    expect(restart).toHaveBeenCalledExactlyOnceWith('remote', target)
    expect(retry).not.toHaveBeenCalled()
    expect(node('restarting')!.textContent).toBe('正在重启…')
    expect(node('update-now')).toBeNull()
    await render(server(undefined, target))
    expect(node('restarting')).toBeNull()
    expect(toast).not.toHaveBeenCalled()
  })

  it.each(['refused', 'rejected'])('reports a %s restart request instead of leaving a sent state', async (failure) => {
    if (failure === 'refused') restart.mockResolvedValue(false)
    else restart.mockRejectedValue(new Error('remote disconnected'))
    await render(); await click('update-now'); await click('update-now-yes')
    expect(node('restarting')).toBeNull()
    expect(node('update-now')).not.toBeNull()
    expect(toast).toHaveBeenCalledWith(expect.stringContaining('未能确认'), 'error', failure === 'rejected' ? expect.any(String) : undefined)
  })

  it('bounds the wait for a confirming heartbeat and allows an explicit retry', async () => {
    await render()
    vi.useFakeTimers()
    await click('update-now'); await click('update-now-yes')
    await act(async () => { await vi.advanceTimersByTimeAsync(120_000) })
    expect(node('restarting')).toBeNull()
    expect(node('update-now')).not.toBeNull()
    expect(toast).toHaveBeenCalledWith(expect.stringContaining(target), 'error')
    expect(restart).toHaveBeenCalledTimes(1)
  })
  it('shows a task boot failure while keeping the online device usable', async () => {
    const device = server()
    device.capabilities.server_boot_failures = [{ operation: 'outbox-drain', taskId: 'task-bad', message: 'router refused' }]
    await render(device)
    expect(node('boot-failure')?.textContent).toContain('router refused')
    expect(node('update-now')).not.toBeNull()
  })

  it('plain Retry never invokes the confirmed restart and shows the original transport error', async () => {
    retry.mockRejectedValueOnce(new Error('idle retry transport refused'))
    await render(server({ state: 'failed', version: target }))
    await click('match-retry')
    expect(retry).toHaveBeenCalledExactlyOnceWith('remote')
    expect(restart).not.toHaveBeenCalled()
    expect(toast).toHaveBeenCalledWith(expect.any(String), 'error', expect.stringContaining('idle retry transport refused'))
  })

})
