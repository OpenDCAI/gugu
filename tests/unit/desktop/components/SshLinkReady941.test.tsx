// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { createReactHarness, device } from '../../../support/testHarness'
import type { Device } from '@gugu/core/shared/types/chat'
import { translateSessionMessage } from '../../../../apps/desktop/src/session/renderer/localization/locale-store'

const state = vi.hoisted(() => ({ devices: [] as Device[], ssh: false }))
vi.mock('@/store/devicesContext', () => ({ useDevicesStore: () => ({ devices: state.devices }) }))
vi.mock('@/lib/sshLinkChannel', () => ({
  isSshMachine: () => state.ssh,
  subscribeSshLinkProblems: (listener: (value: Map<string, string>) => void) => {
    listener(new Map(state.ssh ? [['remote', 'waitingIdle']] : []))
    return () => {}
  },
  subscribeSshSignInPrompts: () => () => {},
  answerSshSignInPrompt: vi.fn(), requestSshServerUpgrade: vi.fn(), signInSshMachine: vi.fn(), sshReinstallCommand: vi.fn(),
}))
import { SshLinkSignIn } from '@/components/SshLinkSignIn'

let harness: ReturnType<typeof createReactHarness>
beforeEach(() => { state.ssh = false; state.devices = []; harness = createReactHarness() })
afterEach(() => harness.cleanup())
const target = '0.3.1-beta.990003.1'
function server(scope: 'account' | 'supervisor' | undefined, capability: boolean): Device {
  return device('remote', [], { label: 'Remote', capabilities: {
    host_kind: 'server', terminals: [], runtimes: [], remote_protocol: 15,
    server_confirmed_restart: capability ? true : undefined, server_update: { state: 'ready', version: target, scope },
  } })
}

it.each(['account', 'supervisor'] as const)('uses the same confirmation message for a restartable %s target', async scope => {
  state.devices = [server(scope, true)]
  await harness.render(<SshLinkSignIn />)
  expect(document.querySelector('[data-testid=ssh-link-update-ask]')?.textContent).toContain(
    translateSessionMessage('remoteHost.notice.updateReady', { device: 'Remote', version: target }),
  )
  expect(document.body.textContent).not.toContain('空闲')
})

it.each([['supervisor', false], [undefined, true]] as const)('keeps the existing message without a confirmable scope/capability', async (scope, capability) => {
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
