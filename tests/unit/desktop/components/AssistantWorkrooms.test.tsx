// @vitest-environment jsdom
import { act } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createReactHarness, renderWithAppProviders } from '../../../support/testHarness'
import type { AssistantShellSnapshot } from '../../../../apps/desktop/src/lib/assistantShellBridge'

const mocks = vi.hoisted(() => ({
  native: true, rpc: vi.fn(), mobileRpc: vi.fn(), list: vi.fn(), bindings: vi.fn(), warn: vi.fn(),
}))
vi.mock('../../../../apps/desktop/src/platform', () => ({ platform: { capabilities: { get agentRuntime() { return mocks.native } } } }))
vi.mock('../../../../apps/desktop/src/session/renderer/lib/ipc', () => {
  const ipc = { rpcOn: mocks.rpc, events: { on: () => () => {} } };
  // 本机(null)那条线就是 events.on;测试里的项目都在本机。
  return { ...ipc, onMachineEvent: (_machine: unknown, event: never, cb: never) => (ipc.events.on as (...args: unknown[]) => () => void)(event, cb) };
})
vi.mock('../../../../apps/desktop/src/mobile/agent-watch/sessionpage-rpc', () => ({ machineRpc: mocks.mobileRpc }))
vi.mock('../../../../apps/desktop/src/lib/log', () => ({ rendererLogger: () => ({ warn: mocks.warn }) }))

import { useAssistantWorkrooms } from '../../../../apps/desktop/src/components/assistant/useAssistantWorkrooms'

const shell = {
  assistantState: 'found', assistant: { id: 'assistant' },
  home: { kind: 'computer', deviceId: 'mac', thisDevice: true },
} as AssistantShellSnapshot
function Probe({ snapshot = shell, revision = '' }: { snapshot?: AssistantShellSnapshot; revision?: string }) {
  const rooms = useAssistantWorkrooms(snapshot, revision)
  return <output>{JSON.stringify(rooms)}</output>
}
let harness: ReturnType<typeof createReactHarness>
beforeEach(() => {
  harness = createReactHarness()
  mocks.native = true
  mocks.rpc.mockReset().mockReturnValue({ sessionTimeline: { sessionsList: mocks.list }, projects: { listProjectGroupBindings: mocks.bindings } })
  mocks.mobileRpc.mockReset().mockImplementation(() => mocks.rpc())
  mocks.warn.mockReset()
  mocks.list.mockReset().mockResolvedValue({ sessions: [{ conversationId: 'root', projectId: 'home', agent: { userId: 'assistant' } }] })
  mocks.bindings.mockReset().mockResolvedValue({ success: true, data: [{ projectId: 'home', chatId: 'workroom' }] })
})
afterEach(() => harness.cleanup())

describe('assistant workroom ownership reads', () => {
  it('reads this computer locally, and does not lose verified ownership on a transient read failure', async () => {
    await renderWithAppProviders(harness, <Probe />)
    expect(mocks.rpc).toHaveBeenCalledWith(null)
    expect(harness.container.textContent).toContain('workroom')
    mocks.bindings.mockResolvedValue({ success: false, error: { type: 'disconnected' } })
    await renderWithAppProviders(harness, <Probe revision="new-membership" />)
    expect(mocks.warn).toHaveBeenCalledOnce()
    expect(harness.container.textContent).toContain('workroom')
  })

  it('ignores late replies from the previous assistant and never reuses its rooms for another account', async () => {
    let reply!: (value: unknown) => void
    mocks.list.mockReturnValueOnce(new Promise(resolve => { reply = resolve }))
    await renderWithAppProviders(harness, <Probe />)
    const other = { ...shell, assistant: { ...shell.assistant!, id: 'other-assistant' } }
    mocks.list.mockResolvedValue({ sessions: [{ conversationId: 'new-root', projectId: 'new-home', agent: { userId: 'other-assistant' } }] })
    mocks.bindings.mockResolvedValue({ success: true, data: [{ projectId: 'new-home', chatId: 'new-room' }] })
    await renderWithAppProviders(harness, <Probe snapshot={other} />, { auth: { id: 'other-owner' } })
    await act(async () => { reply({ sessions: [{ conversationId: 'root', projectId: 'home', agent: { userId: 'assistant' } }] }) })
    expect(harness.container.textContent).toContain('new-room')
    expect(harness.container.textContent).toContain('other-owner')
    expect(harness.container.textContent).not.toContain('workroom')
  })

  it('uses the phone host transport instead of treating the phone as the assistant computer', async () => {
    mocks.native = false
    await renderWithAppProviders(harness, <Probe />)
    expect(mocks.mobileRpc).toHaveBeenCalledWith('mac')
    expect(harness.container.textContent).toContain('workroom')
  })
})
