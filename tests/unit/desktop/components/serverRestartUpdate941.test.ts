// @vitest-environment jsdom
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DevicesSection } from '@/components/settings/DevicesSection'
import { ToastContext } from '@/components/toastContext'
import { DevicesContext, type DevicesContextValue } from '@/store/devicesContext'
import type { Device } from '@gugu/core/shared/types/chat'
import { setLocalePreference } from '@/i18n'

const retry = vi.hoisted(() => vi.fn(async (_deviceId: string) => true))
const restart = vi.hoisted(() => vi.fn(async (_deviceId: string, _version: string, _confirmedRpc: boolean): Promise<{ requested: boolean; at?: number }> => ({ requested: true })))
const busyAgents = vi.hoisted(() => vi.fn(async (_deviceId: string): Promise<number | undefined> => undefined))
vi.mock('@/lib/serverVersionRetry', () => ({ retryServerVersionMatch: retry, restartServerVersionNow: restart, readServerVersionSwitchBusyAgents: busyAgents }))

const current = '0.2.58-beta.1056.1'
const target = '0.2.58-beta.1057.1'
function server(update: Device['capabilities']['server_update'] = { state: 'ready', version: target }, version = current): Device {
  return { device_id: 'remote', label: 'Remote', hostname: 'remote', platform: 'linux', status: 'online', is_online: true,
    last_seen_at: new Date().toISOString(), capabilities: { terminals: [], runtimes: [], host_kind: 'server', server_confirmed_restart: true, app_version: version, server_update: { scope: 'account', ...update } } }
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
  restart.mockReset().mockResolvedValue({ requested: true })
  busyAgents.mockReset().mockResolvedValue(undefined)
  retry.mockReset().mockResolvedValue(true)
  toast.mockReset()
  container = document.createElement('div'); document.body.appendChild(container); root = createRoot(container)
})
afterEach(() => {
  act(() => root.unmount()); container.remove(); vi.useRealTimers()
})

describe('confirmed server update feedback', () => {
  it('shows a rollback outcome without offering another restart into the failed release', async () => {
    const device = server()
    delete device.capabilities.server_update
    device.capabilities.server_update_outcome = { kind: 'rolledBack', request: 42 }
    device.capabilities.server_rollback = { version: target, restored: current }
    await render(device)
    expect(node('notice')!.textContent).toContain('更新失败')
    expect(node('update-now')).toBeNull()
    expect(node('match-restart-now')).toBeNull()
    expect(restart).not.toHaveBeenCalled()
  })
  it.each(['zh-CN', 'en-US'] as const)('renders the counted confirmation in %s for zero and multiple running tasks', async locale => {
    setLocalePreference(locale)
    for (const count of [0, 2]) {
      busyAgents.mockResolvedValue(count)
      await render(server({ state: 'ready', version: target, busy_agents: 99 }))
      await click('update-now')
      const text = node('update-now-confirm')!.textContent!
      expect(text).not.toContain('devices.update.updateNowConfirmCount')
      expect(text).toContain(locale === 'zh-CN'
        ? `${count} 个正在运行的任务会被中断，更新完成后自动继续。`
        : `${count} running tasks will be interrupted and will automatically continue after the update.`)
      await click('update-now-no')
    }
    expect(busyAgents.mock.calls).toEqual([['remote'], ['remote']])
  })

  it('uses the uncounted confirmation when the current busy count cannot be read', async () => {
    await render(server({ state: 'ready', version: target, busy_agents: 99 }))
    await click('update-now')
    expect((node('update-now-yes') as HTMLButtonElement).disabled).toBe(false)
    const text = node('update-now-confirm')!.textContent!
    expect(text).toContain('正在运行的任务会被中断。')
    expect(text).not.toContain('99')
    expect(restart).not.toHaveBeenCalled()
  })

  it('does not apply a cancelled confirmation reading to a later confirmation', async () => {
    let first!: (value: number) => void
    let second!: (value: number) => void
    busyAgents.mockImplementationOnce(() => new Promise(resolve => { first = resolve }))
      .mockImplementationOnce(() => new Promise(resolve => { second = resolve }))
    await render(server({ state: 'ready', version: target, busy_agents: 99 }))
    await click('update-now')
    expect((node('update-now-yes') as HTMLButtonElement).disabled).toBe(true)
    await click('update-now-no')
    await click('update-now')
    expect(first).toBeTypeOf('function')
    await act(async () => { first(7) })
    expect(node('update-now-confirm')!.textContent).not.toContain('7 个')
    await act(async () => { second(0) })
    expect(node('update-now-confirm')!.textContent).toContain('0 个正在运行的任务')
    expect((node('update-now-yes') as HTMLButtonElement).disabled).toBe(false)
  })

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

  it('confirms the displayed supervisor-ready target using the account restart capability', async () => {
    await render(server({ state: 'ready', version: target, scope: 'supervisor' }))
    await click('update-now')
    expect(restart).not.toHaveBeenCalled()
    await click('update-now-yes')
    expect(restart).toHaveBeenCalledExactlyOnceWith('remote', target, true)
  })

  it('requires explicit capability for a supervisor target and accepts the single-process target', async () => {
    const withoutCapability = server({ state: 'ready', version: target, scope: 'supervisor' })
    delete withoutCapability.capabilities.server_confirmed_restart
    await render(withoutCapability)
    expect(node('update-now')).toBeNull()
    await render(server({ state: 'ready', version: target, scope: undefined }))
    expect(node('update-now')).not.toBeNull()
    expect(restart).not.toHaveBeenCalled()
  })

  it.each(['zh-CN', 'en-US'] as const)('explains the legacy ready supervisor in %s when confirmation is unavailable', async (locale) => {
    setLocalePreference(locale)
    const version = '0.3.1-beta.1128'
    for (const count of [1, 12, 0, undefined]) {
      const waiting = server({ state: 'ready', version, scope: 'supervisor', busy_agents: count }, version)
      delete waiting.capabilities.server_confirmed_restart
      await render(waiting)
      const expected = locale === 'zh-CN'
        ? `服务进程 ${version} 已就绪，空闲后自动切换`
        : `Service process ${version} is ready; switches automatically when idle`
      expect(node('update')!.textContent).toBe(expected)
      expect(node('update')!.title).toBe(expected)
      expect(node('update')!.hasAttribute('data-tone')).toBe(false)
      expect(node('update-now')).toBeNull()
    }
    expect(restart).not.toHaveBeenCalled()
  })

  it.each(['account', undefined] as const)('preserves ready feedback for scope %s', async (scope) => {
    await render(server({ state: 'ready', version: target, scope, busy_agents: 2 }))
    expect(node('update')!.textContent).toBe('新版本已就绪，2 个任务在运行')
    expect(node('update')!.dataset.tone).toBe('accent')
    expect(node('update')!.title).toContain('现在重启更新')
    expect(node('update-now')).not.toBeNull()
  })

  it('confirms once, keeps Restarting after the RPC ack, and finishes on the new version heartbeat', async () => {
    await render()
    await click('update-now')
    expect(retry).not.toHaveBeenCalled()
    await click('update-now-yes')
    expect(restart).toHaveBeenCalledExactlyOnceWith('remote', target, true)
    expect(retry).not.toHaveBeenCalled()
    expect(node('restarting')!.textContent).toBe('正在重启…')
    expect(node('update-now')).toBeNull()
    await render(server(undefined, target))
    expect(node('restarting')).toBeNull()
    expect(toast).not.toHaveBeenCalled()
  })

  it.each(['refused', 'rejected'])('reports a %s restart request instead of leaving a sent state', async (failure) => {
    if (failure === 'refused') restart.mockResolvedValue({ requested: false })
    else restart.mockRejectedValue(new Error('remote disconnected'))
    await render(); await click('update-now'); await click('update-now-yes')
    expect(node('restarting')).toBeNull()
    expect(node('update-now')).not.toBeNull()
    expect(toast).toHaveBeenCalledWith(expect.stringContaining('未能确认'), 'error', failure === 'rejected' ? expect.any(String) : undefined)
  })

  it.each(['switched', 'rolledBack', 'failed', 'refused'] as const)('ends the spinner on this request’s %s result even when the failure tuple is unchanged', async kind => {
    const at = 1234 // Host request identity; unrelated to the desktop clock.
    restart.mockResolvedValue({ requested: true, at })
    const failed = { state: 'failed' as const, version: target, reason: 'boot-failed' as const }
    await render(server(failed)); await click('match-restart-now'); await click('update-now-yes')
    expect(node('restarting')).not.toBeNull()
    await render(server({ ...failed, lastOutcome: { kind, request: at } }))
    expect(node('restarting')).toBeNull()
    expect(node('match-failed')!.textContent).toContain('更新没成功')
    expect(toast).not.toHaveBeenCalled()
  })

  it.each([
    { kind: 'waiting' as const, request: 1234 },
    { kind: 'failed' as const, request: 1233 },
  ])('keeps waiting for a terminal result of this request (%j)', async lastOutcome => {
    restart.mockResolvedValue({ requested: true, at: 1234 })
    await render(); await click('update-now'); await click('update-now-yes')
    await render(server({ state: 'ready', version: target, lastOutcome }))
    expect(node('restarting')).not.toBeNull()
    expect(toast).not.toHaveBeenCalled()
  })

  it('keeps a correlated request pending while the host stages it', async () => {
    restart.mockResolvedValue({ requested: true, at: 1234 })
    await render(); await click('update-now'); await click('update-now-yes')
    await render(server({ state: 'downloading', version: target }))
    expect(node('restarting')).not.toBeNull()
  })

  it('continues to display a host-written pending request after the click observer has ended', async () => {
    await render(server({ state: 'ready', version: target, lastOutcome: { kind: 'waiting', request: 42 } }))
    expect(node('restarting')).not.toBeNull()
    expect(node('update-now')).toBeNull()
    expect(restart).not.toHaveBeenCalled()
    await render(server({ state: 'idle', version: target, lastOutcome: { kind: 'switched', request: 42 } }, target))
    expect(node('restarting')).toBeNull()
    expect(toast).not.toHaveBeenCalled()
  })
  it('ends the exact request on the separate idle receipt without an active update badge', async () => {
    restart.mockResolvedValue({ requested: true, at: 42 })
    await render(server({ state: 'ready', version: target, scope: undefined })); await click('update-now'); await click('update-now-yes')
    const next = server()
    delete next.capabilities.server_update
    next.capabilities.server_update_outcome = { request: 41, kind: 'switched' }
    await render(next)
    expect(node('restarting')).not.toBeNull()
    next.capabilities.server_update_outcome = { request: 42, kind: 'switched' }
    await render(next)
    expect(node('restarting')).toBeNull()
    expect(node('update')).toBeNull()
  })

  const legacyChanges = [
    { name: 'ready to failure', before: { state: 'ready', version: target }, after: { state: 'failed', version: target } },
    { name: 'another failed target', before: { state: 'ready', version: target }, after: { state: 'failed', version: '0.3.1' } },
    { name: 'download progress state', before: { state: 'ready', version: target }, after: { state: 'downloading', version: target } },
    { name: 'another ready target', before: { state: 'ready', version: target }, after: { state: 'ready', version: '0.3.1' } },
    { name: 'supervisor ready at the same version', before: { state: 'ready', version: target }, after: { scope: 'supervisor', state: 'ready', version: target } },
    { name: 'update cleared after rollback', before: { state: 'ready', version: target }, after: null },
    { name: 'retry failed with another reason', before: { state: 'failed', version: target, reason: 'boot-failed' }, after: { state: 'failed', version: target } },
    { name: 'retry now downloading', before: { state: 'failed', version: target, reason: 'boot-failed' }, after: { state: 'downloading', version: target } },
  ] satisfies { name: string; before: NonNullable<Device['capabilities']['server_update']>; after: Device['capabilities']['server_update'] | null }[]
  it.each(legacyChanges)('legacy ACK yields to the host’s $name', async ({ before, after }) => {
    await render(server(before)); await click(before.state === 'failed' ? 'match-restart-now' : 'update-now'); await click('update-now-yes')
    const next = server(after ?? undefined)
    if (after === null) delete next.capabilities.server_update
    await render(next)
    expect(node('restarting')).toBeNull()
    expect(toast).not.toHaveBeenCalled()
  })

  it.each(['same state', 'busy count only', 'other installed version', 'same failed retry'] as const)('legacy ACK keeps waiting with no new result: %s', async variant => {
    const before = variant === 'same failed retry'
      ? { state: 'failed' as const, version: target, reason: 'boot-failed' as const }
      : { state: 'ready' as const, version: target }
    await render(server(before)); await click(before.state === 'failed' ? 'match-restart-now' : 'update-now'); await click('update-now-yes')
    await render(server({ ...before, ...(variant === 'busy count only' ? { busy_agents: 2 } : {}) }, variant === 'other installed version' ? '0.2.58' : current))
    expect(node('restarting')).not.toBeNull()
  })

  it.each([undefined, 1234])('keeps a failed retry pending while the host is offline (request %s)', async at => {
    restart.mockResolvedValue({ requested: true, at })
    const failed = { state: 'failed' as const, version: target, reason: 'boot-failed' as const }
    await render(server(failed)); await click('match-restart-now'); await click('update-now-yes')
    const offline = server(failed)
    offline.is_online = false; offline.status = 'offline'
    await render(offline)
    expect(node('restarting')).not.toBeNull()
    expect(node('match-failed')).toBeNull()
    expect(node('update-now')).toBeNull()
    expect(node('match-restart-now')).toBeNull()
    expect(toast).not.toHaveBeenCalled()
  })

  it('keeps a correlated request pending when only the update scope changes', async () => {
    restart.mockResolvedValue({ requested: true, at: 1234 })
    await render(); await click('update-now'); await click('update-now-yes')
    await render(server({ state: 'ready', version: target, scope: 'supervisor' }))
    expect(node('restarting')).not.toBeNull()
    expect(node('update')).toBeNull()
    expect(node('update-now')).toBeNull()
    expect(toast).not.toHaveBeenCalled()
  })

  it('does not restore a spinner when the ACK arrives after the installed version', async () => {
    let acknowledge!: (value: { requested: boolean; at: number }) => void
    restart.mockReturnValue(new Promise(resolve => { acknowledge = resolve }))
    await render(); await click('update-now'); await click('update-now-yes')
    await render(server(undefined, target))
    await act(async () => { acknowledge({ requested: true, at: 1234 }) })
    expect(node('restarting')).toBeNull()
    expect(toast).not.toHaveBeenCalled()
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
  it.each(['version', 'outcome', 'no result'] as const)('waits silently beyond the deadline while offline, then handles %s online', async completion => {
    restart.mockResolvedValue({ requested: true, at: 42 })
    await render()
    vi.useFakeTimers()
    await click('update-now'); await click('update-now-yes')
    const offline = server()
    offline.is_online = false; offline.status = 'offline'
    await render(offline)
    await act(async () => { await vi.advanceTimersByTimeAsync(180_000) })
    expect(node('restarting')).not.toBeNull()
    expect(node('update-now')).toBeNull()
    expect(node('match-restart-now')).toBeNull()
    expect(toast).not.toHaveBeenCalled()
    const online = server(undefined, completion === 'version' ? target : current)
    if (completion === 'outcome') online.capabilities.server_update_outcome = { request: 42, kind: 'switched' }
    await render(online)
    await act(async () => { await vi.advanceTimersByTimeAsync(1) })
    expect(node('restarting')).toBeNull()
    if (completion === 'no result') expect(toast).toHaveBeenCalledWith(expect.stringContaining(target), 'error')
    else expect(toast).not.toHaveBeenCalled()
  })
  it.each(['ready', 'failed'] as const)('never offers a confirmed restart for an offline %s host', async state => {
    const offline = server({ state, version: target, ...(state === 'failed' ? { reason: 'boot-failed' as const } : {}) })
    offline.is_online = false; offline.status = 'offline'
    await render(offline)
    expect(node('update-now')).toBeNull()
    expect(node('match-restart-now')).toBeNull()
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


it.each(['switched', 'rolledBack', 'failed', 'refused'] as const)('accepts the installation-wide %s receipt without an account scope', async kind => {
  restart.mockResolvedValue({ requested: true, at: 1234 })
  await render(server({ state: 'ready', version: target, scope: undefined }))
  await click('update-now'); await click('update-now-yes')
  expect(restart).toHaveBeenCalledWith('remote', target, true)
  expect(node('restarting')).not.toBeNull()
  await render(server({ state: 'idle', version: current, scope: undefined, lastOutcome: { kind, request: 999 } }))
  expect(node('restarting')).not.toBeNull()
  await render(server({ state: 'idle', version: current, scope: undefined, lastOutcome: { kind, request: 1234 } }))
  expect(node('restarting')).toBeNull()
  expect(node('update-now')).toBeNull()
  expect(toast).not.toHaveBeenCalled()
})
