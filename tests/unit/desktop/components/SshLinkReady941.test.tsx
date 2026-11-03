// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { createReactHarness, device, clickElement } from '../../../support/testHarness'
import type { Device } from '@gugu/core/shared/types/chat'
import { translateSessionMessage } from '../../../../apps/desktop/src/session/renderer/localization/locale-store'
import { act } from 'react'
import { ToastContext } from '@/components/toastContext'
import type { SshUpgradeEvent } from '@/lib/sshLink'

const state = vi.hoisted(() => ({ devices: [] as Device[], ssh: false, calls: [] as unknown[][], busyAgents: 0 as number | undefined, onUpgrade: null as ((event: SshUpgradeEvent) => void) | null }))
vi.mock('@/lib/deviceRpc', () => ({ callDeviceRpc: async (...args: unknown[]) => { state.calls.push(args); return { result: args[1] === 'server.versionMatch.activity' ? { busyAgents: state.busyAgents } : { requested: true } } } }))
vi.mock('@/store/devicesContext', () => ({ useDevicesStore: () => ({ devices: state.devices }) }))
vi.mock('@/lib/sshLinkChannel', () => ({
  isSshMachine: () => state.ssh,
  subscribeSshLinkProblems: (listener: (value: Map<string, string>) => void) => {
    listener(new Map(state.ssh ? [['remote', 'waitingIdle']] : []))
    return () => {}
  },
  subscribeSshSignInPrompts: () => () => {},
  subscribeSshUpgradeEvents: (listener: (event: SshUpgradeEvent) => void) => {
    state.onUpgrade = listener
    return () => { state.onUpgrade = null }
  },
  answerSshSignInPrompt: vi.fn(), requestSshServerUpgrade: vi.fn(), signInSshMachine: vi.fn(), sshReinstallCommand: vi.fn(),
}))
import { SshLinkSignIn } from '@/components/SshLinkSignIn'
import { requestSshServerUpgrade } from '@/lib/sshLinkChannel'

let harness: ReturnType<typeof createReactHarness>
beforeEach(() => { state.ssh = false; state.devices = []; state.calls = []; state.busyAgents = 0; harness = createReactHarness() })
afterEach(() => harness.cleanup())
const target = '0.3.1-beta.990003.1'
function server(scope: 'account' | 'supervisor' | undefined, capability: boolean): Device {
  return device('remote', [], { label: 'Remote', capabilities: {
    host_kind: 'server', terminals: [], runtimes: [], remote_protocol: 15,
    server_confirmed_restart: capability ? true : undefined, server_update: { state: 'ready', version: target, scope },
  } })
}

it.each(['account', 'supervisor', undefined] as const)('uses the same confirmation message for a restartable %s target', async scope => {
  state.devices = [server(scope, true)]
  await harness.render(<SshLinkSignIn />)
  expect(document.querySelector('[data-testid=ssh-link-update-ask]')?.textContent).toContain(
    translateSessionMessage('remoteHost.notice.updateReady', { device: 'Remote', version: target }),
  )
  expect(document.body.textContent).not.toContain('空闲')
})

it.each([['supervisor', false]] as const)('keeps the existing message without a confirmable scope/capability', async (scope, capability) => {
  state.devices = [server(scope, capability)]
  await harness.render(<SshLinkSignIn />)
  expect(document.body.textContent).toContain('空闲')
  expect(document.body.textContent).not.toContain(target)
})

it('leaves the existing SSH upgrader waiting branch unchanged', async () => {
  state.ssh = true
  state.devices = [server('account', true)]
  await harness.render(<SshLinkSignIn />)
  expect(document.body.textContent).toContain('空闲')
  expect(document.body.textContent).not.toContain(target)
})

it('reports an expired observer neutrally with the actual host version', async () => {
  const toast = vi.fn()
  state.devices = [server(undefined, true)]
  await harness.render(<ToastContext.Provider value={{ toast }}><SshLinkSignIn /></ToastContext.Provider>)
  await act(async () => { state.onUpgrade?.({ deviceId: 'remote', phase: 'unconfirmed', request: 42, reportedVersion: '1.0.0' }) })
  expect(toast).toHaveBeenCalledWith(expect.stringContaining('1.0.0'), 'info')
  expect(toast.mock.calls[0]?.[0]).not.toMatch(/失败|成功|failed|succeeded/)
})

it('does not offer a restart for an offline tunnel device with a stale ready heartbeat', async () => {
  state.devices = [{ ...server(undefined, true), is_online: false, status: 'offline' }]
  await harness.render(<SshLinkSignIn />)
  expect(document.querySelector('[data-testid=ssh-link-update-now]')).toBeNull()
  expect(document.querySelector('[data-testid=ssh-link-update-confirm-now]')).toBeNull()
  expect(state.calls).toEqual([])
})

it('uses a fresh zero count in the tunnel confirmation rather than the heartbeat count', async () => {
  const host = server(undefined, true)
  host.capabilities.server_update!.busy_agents = 99
  state.devices = [host]
  await harness.render(<SshLinkSignIn />)
  await clickElement(document.querySelector<HTMLElement>('[data-testid=ssh-link-update-now]')!)
  const text = document.querySelector('[data-testid=ssh-link-update-confirm]')!.textContent!
  expect(text).toContain('0 个正在运行的任务')
  expect(text).not.toContain('devices.update.updateNowConfirmCount')
  expect(text).not.toContain('99')
  expect(state.calls).toEqual([['remote', 'server.versionMatch.activity', {}, { timeoutMs: 15000 }]])
})

async function confirmRestart() {
  await clickElement(document.querySelector<HTMLElement>('[data-testid=ssh-link-update-now]')!)
  await clickElement(document.querySelector<HTMLElement>('[data-testid=ssh-link-update-confirm-now]')!)
}

it.each(['account', 'supervisor', undefined] as const)('sends the displayed %s target as an explicit confirmed restart', async scope => {
  state.devices = [server(scope, true)]
  await harness.render(<SshLinkSignIn />)
  await confirmRestart()
  expect(state.calls).toEqual([['remote', 'server.versionMatch.activity', {}, { timeoutMs: 15000 }], ['remote', 'server.versionMatch.restartConfirmed', { version: target, confirmed: true }, { timeoutMs: 15000 }]])
})

it('uses the existing legacy confirmation verb for an older account host', async () => {
  state.devices = [server(undefined, false)]
  await harness.render(<SshLinkSignIn />)
  await confirmRestart()
  expect(state.calls).toEqual([['remote', 'server.versionMatch.activity', {}, { timeoutMs: 15000 }], ['remote', 'server.versionMatch.retry', {}, { timeoutMs: 15000 }]])
})

it('preserves the idle retry for a supervisor without confirmation capability', async () => {
  state.devices = [server('supervisor', false)]
  await harness.render(<SshLinkSignIn />)
  await confirmRestart()
  expect(state.calls).toEqual([['remote', 'server.versionMatch.activity', {}, { timeoutMs: 15000 }], ['remote', 'server.versionMatch.retryWhenIdle', {}, { timeoutMs: 15000 }]])
})

it('keeps the SSH upgrader as the confirmation route for an SSH waiting prompt', async () => {
  state.ssh = true
  state.devices = [server('account', true)]
  await harness.render(<SshLinkSignIn />)
  await confirmRestart()
  expect(requestSshServerUpgrade).toHaveBeenCalledWith('remote', { force: true, now: true })
  expect(state.calls).toEqual([['remote', 'server.versionMatch.activity', {}, { timeoutMs: 15000 }]])
})
