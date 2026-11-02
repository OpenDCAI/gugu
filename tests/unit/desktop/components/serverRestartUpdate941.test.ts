// @vitest-environment jsdom
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DevicesSection } from '@/components/settings/DevicesSection'
import { ToastContext } from '@/components/toastContext'
import { DevicesContext, type DevicesContextValue } from '@/store/devicesContext'
import type { Device } from '@gugu/core/shared/types/chat'

const readings = vi.hoisted(() => ({ value: new Map<string, import('@/lib/serverUpdateReadings').ServerUpdateView>() }))
vi.mock('@/lib/serverUpdateReadings', () => ({ useServerUpdateReadings: () => readings.value, readServerUpdate: vi.fn(async () => undefined) }))

const retry = vi.hoisted(() => vi.fn(async (_deviceId: string) => true))
const restart = vi.hoisted(() => vi.fn(async (_deviceId: string, _version: string, _confirmedRpc: boolean) => true))
vi.mock('@/lib/serverVersionRetry', () => ({ retryServerVersionMatch: retry, restartServerVersionNow: restart }))

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
  readings.value = new Map()
  ;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true
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
    expect(node('update')!.textContent).toBe('新版本已就绪')
  })

  it('offers Update now on an older account process too, through the RPC it understands', async () => {
    const legacy = server({ state: 'ready', version: target }, '0.2.58')
    delete legacy.capabilities.server_confirmed_restart
    delete legacy.capabilities.server_update!.scope // Old account processes report neither capability nor scope.
    await render(legacy)
    await click('update-now')
    await click('update-now-yes')
    expect(restart).toHaveBeenCalledExactlyOnceWith('remote', target, false)
    expect(retry).not.toHaveBeenCalled()
  })

  it('never offers an account restart for a supervisor update or an unknown update owner', async () => {
    await render(server({ state: 'ready', version: target, scope: 'supervisor' }))
    expect(node('update-now')).toBeNull()
    await render(server({ state: 'ready', version: target, scope: undefined }))
    expect(node('update-now')).toBeNull()
    expect(restart).not.toHaveBeenCalled()
  })

  it('confirms once and displays the durable operation; a matching heartbeat alone cannot claim a connection', async () => {
    await render(); await click('update-now'); await click('update-now-yes')
    expect(restart).toHaveBeenCalledExactlyOnceWith('remote', target, true)
    readings.value.set('remote', { reachable: true, pending: false, transition: { request: 7, target, phase: 'migrating', at: Date.now(), pid: 22, done: 2, total: 3 } })
    await render()
    expect(node('restarting')!.textContent).toBe('升级数据 2/3')
    expect(node('update-now')).toBeNull()
    await render(server(undefined, target))
    expect(node('restarting')!.textContent).toBe('升级数据 2/3')
    readings.value.set('remote', { reachable: true, pending: false, connected: false, transition: { request: 7, target, phase: 'ready', at: Date.now(), pid: 22 } })
    await render(server(undefined, target))
    expect(node('restarting')!.textContent).toBe('连接中')
    readings.value.set('remote', { ...readings.value.get('remote')!, connected: true })
    await render(server(undefined, target))
    expect(node('restarting')!.textContent).toBe('已连上')
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

  it('keeps an active operation through the old timeout and a settings remount without offering another restart', async () => {
    readings.value.set('remote', { reachable: false, pending: false, transition: { request: 7, target, phase: 'stopping', at: Date.now() } })
    await render(); vi.useFakeTimers()
    await act(async () => { await vi.advanceTimersByTimeAsync(120_000) })
    expect(node('restarting')!.textContent).toBe('停止旧版本')
    await act(async () => root.unmount()); root = createRoot(container); await render()
    expect(node('restarting')!.textContent).toBe('停止旧版本')
    expect(node('update-now')).toBeNull()
    expect(toast).not.toHaveBeenCalled()
    expect(restart).not.toHaveBeenCalled()
  })
  it('shows true search progress beside the restored connection and removes it when complete', async () => {
    const transition = { request: 7, target, phase: 'ready' as const, at: Date.now(), pid: 22, search: { state: 'running' as const, done: 42, total: 100 } }
    readings.value.set('remote', { reachable: true, pending: false, connected: true, transition })
    await render()
    expect(node('restarting')!.textContent).toBe('已连上')
    expect(node('search-preparing')!.textContent).toBe('准备搜索 42%')
    readings.value.set('remote', { reachable: true, pending: false, connected: true, transition: { ...transition, search: { state: 'complete', done: 100, total: 100 } } })
    await render()
    expect(node('search-preparing')).toBeNull()
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
