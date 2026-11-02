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
  restart.mockReset().mockResolvedValue({ requested: true })
  retry.mockReset().mockResolvedValue(true)
  toast.mockReset()
  container = document.createElement('div'); document.body.appendChild(container); root = createRoot(container)
})
afterEach(() => {
  act(() => root.unmount()); container.remove(); vi.useRealTimers()
})

describe('confirmed server update feedback', () => {
  it.each(['zh-CN', 'en-US'] as const)('renders the counted confirmation in %s for zero and multiple running tasks', async locale => {
    setLocalePreference(locale)
    for (const count of [0, 2]) {
      await render(server({ state: 'ready', version: target, busy_agents: count }))
      await click('update-now')
      const text = node('update-now-confirm')!.textContent!
      expect(text).not.toContain('devices.update.updateNowConfirmCount')
      expect(text).toContain(locale === 'zh-CN'
        ? `${count} 个正在运行的任务会被中断，更新完成后自动继续。`
        : `${count} running tasks will be interrupted and will automatically continue after the update.`)
      await click('update-now-no')
    }
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

  it('never offers an account restart for a supervisor update or an unknown update owner', async () => {
    await render(server({ state: 'ready', version: target, scope: 'supervisor' }))
    expect(node('update-now')).toBeNull()
    await render(server({ state: 'ready', version: target, scope: undefined }))
    expect(node('update-now')).toBeNull()
    expect(restart).not.toHaveBeenCalled()
  })

  it.each(['zh-CN', 'en-US'] as const)('explains the ready supervisor in %s when the account is already current', async (locale) => {
    setLocalePreference(locale)
    const version = '0.3.1-beta.1128'
    for (const count of [1, 12, 0, undefined]) {
      await render(server({ state: 'ready', version, scope: 'supervisor', busy_agents: count }, version))
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
    expect(Boolean(node('update-now'))).toBe(scope === 'account')
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

  it.each([undefined, 1234])('offline feedback ends a failed retry spinner (request %s)', async at => {
    restart.mockResolvedValue({ requested: true, at })
    const failed = { state: 'failed' as const, version: target, reason: 'boot-failed' as const }
    await render(server(failed)); await click('match-restart-now'); await click('update-now-yes')
    const offline = server(failed)
    offline.is_online = false; offline.status = 'offline'
    await render(offline)
    expect(node('restarting')).toBeNull()
    expect(node('match-failed')).toBeNull()
    expect(toast).not.toHaveBeenCalled()
  })

  it('yields to a supervisor update when the account stops reporting an update, even with a correlated ACK', async () => {
    restart.mockResolvedValue({ requested: true, at: 1234 })
    await render(); await click('update-now'); await click('update-now-yes')
    await render(server({ state: 'ready', version: target, scope: 'supervisor' }))
    expect(node('restarting')).toBeNull()
    expect(node('update')!.textContent).toContain('服务进程')
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
