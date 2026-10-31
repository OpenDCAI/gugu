// @vitest-environment jsdom
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DevicesSection } from '@/components/settings/DevicesSection'
import { ToastContext } from '@/components/toastContext'
import { DevicesContext, type DevicesContextValue } from '@/store/devicesContext'
import type { Device } from '@gugu/core/shared/types/chat'

const rpc = vi.hoisted(() => vi.fn())
vi.mock('@/lib/deviceRpc', async (importOriginal) => ({
  ...await importOriginal<typeof import('@/lib/deviceRpc')>(), callDeviceRpc: rpc,
}))

const current = '0.2.58-beta.1056.1'
const target = '0.2.58-beta.1057.1'
function server(update: Device['capabilities']['server_update'] = { state: 'ready', version: target }, version = current): Device {
  return { device_id: 'remote', label: 'Remote', hostname: 'remote', platform: 'linux', status: 'online', is_online: true,
    last_seen_at: '2026-10-29T00:00:00Z', capabilities: { terminals: [], runtimes: [], host_kind: 'server', server_confirmed_restart: true, app_version: version, server_update: { scope: 'account', ...update } } }
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
  rpc.mockReset().mockResolvedValue({ result: { requested: true } })
  toast.mockReset()
  container = document.createElement('div'); document.body.appendChild(container); root = createRoot(container)
})
afterEach(() => {
  act(() => root.unmount()); container.remove(); vi.useRealTimers()
})

describe('server update confirmation and feedback', () => {
  it('shows the actual download target and a known waiting count, leaving an unknown count unspecified', async () => {
    await render(server({ state: 'downloading', version: target }))
    expect(node('update')!.textContent).toContain(target)
    await render(server({ state: 'ready', version: target, busy_agents: 2 }))
    expect(node('update')!.textContent).toContain('2 个任务')
    await render()
    expect(node('update')!.textContent).toBe('新版本已就绪，等待空闲')
  })

  it.each([true, false, undefined])('confirms before choosing the existing update RPC (capability: %s)', async (capability) => {
    const device = server()
    if (capability === undefined) delete device.capabilities.server_confirmed_restart
    else device.capabilities.server_confirmed_restart = capability
    await render(device)
    await click('update-now')
    expect(node('update-now-confirm')!.textContent).toContain('Remote')
    expect(rpc).not.toHaveBeenCalled()
    await click('update-now-no')
    expect(node('update-now-confirm')).toBeNull()
    expect(rpc).not.toHaveBeenCalled()
    await click('update-now'); await click('update-now-yes')
    expect(rpc).toHaveBeenCalledExactlyOnceWith('remote',
      capability === true ? 'server.versionMatch.restartConfirmed' : 'server.versionMatch.retry',
      capability === true ? { version: target, confirmed: true } : {}, { timeoutMs: 15_000 })
    expect(node('restarting')!.textContent).toBe('正在重启…')
    expect(node('update-now')).toBeNull()
    await render(server(undefined, target))
    expect(node('restarting')).toBeNull()
    expect(toast).not.toHaveBeenCalled()
  })

  it.each([true, false])('preserves scope and readiness restrictions (capability: %s)', async (capability) => {
    for (const update of [
      { state: 'ready', version: target, scope: 'supervisor' },
      { state: 'ready', version: target, scope: undefined },
      { state: 'downloading', version: target },
      { state: 'failed', version: target },
    ] as const) {
      const device = server(update)
      device.capabilities.server_confirmed_restart = capability
      await render(device)
      expect(node('update-now')).toBeNull()
      expect(node('update-now-confirm')).toBeNull()
    }
    expect(rpc).not.toHaveBeenCalled()
  })

  it.each([true, false])('names the device and distinguishes a known busy count from unknown (capability: %s)', async (capability) => {
    for (const count of [0, 1, 3, undefined]) {
      const device = server({ state: 'ready', version: target, busy_agents: count })
      device.capabilities.server_confirmed_restart = capability
      await render(device); await click('update-now')
      const confirmation = node('update-now-confirm')!.textContent!
      expect(confirmation).toContain('「Remote」')
      expect(confirmation).toContain(count === undefined ? '这一轮可能被中断' : `${count} 个正在运行的任务这一轮会被中断`)
      await click('update-now-no')
    }
    expect(rpc).not.toHaveBeenCalled()
  })

  it('withdraws confirmation when the update is no longer account-scoped or ready', async () => {
    await render()
    await click('update-now')
    await render(server({ state: 'ready', version: target, scope: 'supervisor' }))
    expect(node('update-now-confirm')).toBeNull()
    expect(node('update-now')).toBeNull()
    await render(); await click('update-now')
    await render(server({ state: 'downloading', version: target }))
    expect(node('update-now-confirm')).toBeNull()
    expect(rpc).not.toHaveBeenCalled()
  })

  it.each([true, false])('reports failed update requests and allows another attempt (capability: %s)', async (capability) => {
    const device = server()
    device.capabilities.server_confirmed_restart = capability
    for (const failure of ['refused', 'rejected', 'transport']) {
      if (failure === 'refused') rpc.mockResolvedValueOnce({ result: { requested: false } })
      else if (failure === 'rejected') rpc.mockRejectedValueOnce(new Error('remote disconnected'))
      else rpc.mockResolvedValueOnce({ error: { message: 'remote disconnected' } })
      await render(device); await click('update-now'); await click('update-now-yes')
      expect(node('restarting')).toBeNull()
      expect(node('update-now')).not.toBeNull()
      expect(toast).toHaveBeenLastCalledWith(expect.stringContaining('未能确认'), 'error', failure === 'refused' ? undefined : expect.stringContaining('remote disconnected'))
    }
  })

  it('bounds the wait for a confirming heartbeat and allows an explicit retry', async () => {
    await render()
    vi.useFakeTimers()
    await click('update-now'); await click('update-now-yes')
    await act(async () => { await vi.advanceTimersByTimeAsync(120_000) })
    expect(node('restarting')).toBeNull()
    expect(node('update-now')).not.toBeNull()
    expect(toast).toHaveBeenCalledWith(expect.stringContaining(target), 'error')
    expect(rpc).toHaveBeenCalledTimes(1)
  })
  it('shows a task boot failure while keeping the online device usable', async () => {
    const device = server()
    device.capabilities.server_boot_failures = [{ operation: 'outbox-drain', taskId: 'task-bad', message: 'router refused' }]
    await render(device)
    expect(node('boot-failure')?.textContent).toContain('router refused')
    expect(node('update-now')).not.toBeNull()
  })

  it('plain Retry never invokes the confirmed restart and shows the original transport error', async () => {
    rpc.mockRejectedValueOnce(new Error('idle retry transport refused'))
    await render(server({ state: 'failed', version: target }))
    await click('match-retry')
    expect(rpc).toHaveBeenCalledExactlyOnceWith('remote', 'server.versionMatch.retryWhenIdle', {}, { timeoutMs: 15_000 })
    expect(toast).toHaveBeenCalledWith(expect.any(String), 'error', expect.stringContaining('idle retry transport refused'))
  })

})
