// @vitest-environment jsdom
import { act, createElement } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { useAui } from '../../../apps/desktop/node_modules/@assistant-ui/react'
import type { Device } from '@gugu/core/shared/types/chat'
import type { SessionpageSessionCreateOptions, SessionpageSessionCreateResult } from '@gugu/session-core/session-record/contract'
import { CreateSessionPage } from '../../../apps/desktop/src/mobile/agent-watch/CreateSessionPage'
import { composerDrafts } from '../../../apps/desktop/src/session/renderer/features/sessions/composer-drafts'
import { mobileCreationDraftKey } from '../../../apps/desktop/src/mobile/agent-watch/create-session-draft'
import { createNode, createReactHarness, deferred } from '../../support/testHarness'

type ComposerClient = ReturnType<typeof useAui>['composer']
const state = vi.hoisted(() => ({ owner: 'creation-navigation', composer: null as ComposerClient | null }))
vi.mock('../../../apps/desktop/src/mobile/agent-watch/use-host-terminal-enabled', () => ({ useHostTerminalEnabled: () => ({ enabled: false, refresh: () => undefined }) }))

const rpc = vi.hoisted(() => ({ options: vi.fn(), models: vi.fn(), create: vi.fn() }))
vi.mock('../../../apps/desktop/src/store/auth', async (original) => ({
  ...(await original<typeof import('../../../apps/desktop/src/store/auth')>()),
  useAuth: () => ({ user: { id: state.owner } }),
}))
vi.mock('../../../apps/desktop/src/mobile/agent-watch/useMachineLabel', () => ({
  useMachineLabel: () => ({ label: () => 'Mac', isHome: () => false }),
}))
vi.mock('../../../apps/desktop/src/hooks/useWakeCloudComputer', () => ({
  useCloudComputerWake: () => ({ issue: null, dropped: false, retry: vi.fn() }),
}))
vi.mock('../../../apps/desktop/src/mobile/agent-watch/CreateOptionsPill', () => ({ CreateOptionsPill: () => null }))
vi.mock('../../../apps/desktop/src/mobile/agent-watch/sessionpage-rpc', () => ({
  SessionpageRpcError: class SessionpageRpcError extends Error { readonly code = 'test' },
  fetchCreateOptions: rpc.options,
  fetchPhoneCreateOptions: rpc.options,
  fetchCreateModels: rpc.models,
  fetchPhoneCreateModels: rpc.models,
  createSession: rpc.create,
  createPhoneSession: rpc.create,
}))
vi.mock('../../../apps/desktop/src/components/assistant-ui/thread.aui', async () => {
  const { useAui } = await import('../../../apps/desktop/node_modules/@assistant-ui/react')
  const { ComposerAboveExtras } = await import('../../../apps/desktop/src/components/assistant-ui/composer-extras')
  return { Thread: () => { state.composer = useAui().composer; return createElement(ComposerAboveExtras) } }
})

const options: SessionpageSessionCreateOptions = {
  projects: [{ id: 'project', name: 'Project', path: '/project' }],
  harnesses: [{ id: 'codex', name: 'Codex', status: 'available', watchable: true, sessionViews: ['general'], permissionModes: ['read-only'] }],
  lastUsed: null,
}
const device: Device = {
  device_id: 'creation-device', label: 'Mac', hostname: 'mac', platform: 'darwin', status: 'online',
  is_online: true, last_seen_at: '2026-10-21T00:00:00.000Z', capabilities: { terminals: [], runtimes: ['codex'] },
}
const result: SessionpageSessionCreateResult = { conversationId: 'created-task', projectId: 'project', title: 'Created task' }
let harness: ReturnType<typeof createReactHarness>
beforeEach(() => {
  harness = createReactHarness()
  state.composer = null
  state.owner = 'creation-navigation'
  composerDrafts.set(mobileCreationDraftKey(state.owner), '')
  rpc.options.mockReset().mockResolvedValue(options)
  rpc.models.mockReset().mockResolvedValue({ harness: 'codex', models: [], efforts: [], selected: null, selectedEffort: null })
  rpc.create.mockReset()
})
afterEach(() => harness.cleanup())

async function sendFirst() {
  await act(async () => { state.composer!.setText('原来的任务'); state.composer!.send() })
  expect(rpc.create).toHaveBeenCalledTimes(1)
}

describe('creation keeps its navigation and draft ownership', () => {
  it('settles a late successful creation without reopening a page the user left', async () => {
    const pending = deferred<SessionpageSessionCreateResult>()
    rpc.create.mockReturnValue(pending.promise)
    const onCreated = vi.fn()
    await harness.render(createNode(CreateSessionPage, { device, onBack: vi.fn(), onCreated }))
    await sendFirst()
    await harness.render(null)
    await act(async () => { pending.resolve(result); await pending.promise })
    expect(onCreated).not.toHaveBeenCalled()
    expect(composerDrafts.get(mobileCreationDraftKey(state.owner))).toBe('')
  })

  it('does not replace newer typing when the first creation fails', async () => {
    const pending = deferred<SessionpageSessionCreateResult>()
    rpc.create.mockReturnValue(pending.promise)
    await harness.render(createNode(CreateSessionPage, { device, onBack: vi.fn(), onCreated: vi.fn() }))
    await sendFirst()
    await act(async () => { state.composer!.setText('正在写下一句'); pending.reject(new Error('network unavailable')); await Promise.resolve() })
    expect(state.composer!.getState().text).toBe('正在写下一句')
    expect(harness.container.querySelector('[data-testid="agent-watch-create-error"]')).not.toBeNull()
  })

  it('does not request creation options from an online phone whose host has stopped', async () => {
    const stoppedPhone = { ...device, platform: 'android', capabilities: { host_kind: 'phone', host_runtime_capability: 0, terminals: [], runtimes: [] } } as Device
    await harness.render(createNode(CreateSessionPage, { device: stoppedPhone, onBack: vi.fn(), onCreated: vi.fn() }))
    expect(rpc.options).not.toHaveBeenCalled()
    expect(harness.container.querySelector('[data-testid="agent-watch-offline-why"]')).not.toBeNull()
  })
})
