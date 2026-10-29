// @vitest-environment jsdom
import { act } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Device } from '@gugu/core/shared/types/chat'
import type { SessionpageSessionCreateModels, SessionpageSessionCreateOptions } from '@gugu/session-core/session-record/contract'
import { CreateSessionPage } from '../../../apps/desktop/src/mobile/agent-watch/CreateSessionPage'
import { composerDrafts } from '../../../apps/desktop/src/session/renderer/features/sessions/composer-drafts'
import { mobileCreationDraftKey } from '../../../apps/desktop/src/mobile/agent-watch/create-session-draft'
import type { CreateSelection } from '../../../apps/desktop/src/mobile/agent-watch/create-session-form'
import { createNode, createReactHarness, deferred } from '../../support/testHarness'
import { readComposer, writeComposer } from '../../support/composerEditor'

vi.mock('../../../apps/desktop/src/mobile/agent-watch/use-host-terminal-enabled', () => ({ useHostTerminalEnabled: () => ({ enabled: false, refresh: () => undefined }) }))

const rpc = vi.hoisted(() => ({ options: vi.fn(), models: vi.fn(), create: vi.fn() }))
vi.mock('../../../apps/desktop/src/store/auth', async (original) => ({
  ...(await original<typeof import('../../../apps/desktop/src/store/auth')>()),
  useAuth: () => ({ user: { id: 'create-gate-owner' } }),
}))
vi.mock('../../../apps/desktop/src/mobile/agent-watch/useMachineLabel', () => ({
  useMachineLabel: () => ({ label: () => 'This phone', isHome: () => false }),
}))
vi.mock('../../../apps/desktop/src/hooks/useWakeCloudComputer', () => ({
  useCloudComputerWake: () => ({ issue: null, dropped: false, retry: vi.fn() }),
}))
vi.mock('../../../apps/desktop/src/mobile/agent-watch/CreateOptionsPill', async () => {
  const { createElement } = await import('react')
  return {
    CreateOptionsPill: ({ selection, onChange }: {
      selection: CreateSelection
      onChange: (next: CreateSelection, modelPicked?: boolean) => void
    }) => createElement('div', null,
      createElement('button', { 'data-testid': 'pick-codex', onClick: () => onChange({ ...selection, harness: 'codex', model: null, effort: null }) }, 'Codex'),
      createElement('button', { 'data-testid': 'pick-own-default', onClick: () => onChange({ ...selection, model: null }, true) }, 'Own default'),
    ),
  }
})
vi.mock('../../../apps/desktop/src/mobile/agent-watch/sessionpage-rpc', () => ({
  SessionpageRpcError: class SessionpageRpcError extends Error { readonly code = 'test' },
  fetchCreateOptions: rpc.options,
  fetchPhoneCreateOptions: rpc.options,
  fetchCreateModels: rpc.models,
  fetchPhoneCreateModels: rpc.models,
  createSession: rpc.create,
  createPhoneSession: rpc.create,
}))

const options: SessionpageSessionCreateOptions = {
  projects: [{ id: 'phone-project', name: 'Phone task', path: '/phone-project' }],
  harnesses: [{ id: 'pi', name: 'Pi', status: 'available', watchable: true, sessionViews: ['general'], permissionModes: ['read-only'] }],
  lastUsed: null,
}
const device: Device = {
  device_id: 'create-gate-phone', label: 'Phone', hostname: 'phone', platform: 'android', status: 'online',
  is_online: true, last_seen_at: '2026-10-21T00:00:00.000Z',
  capabilities: { terminals: [], runtimes: ['pi'], host_kind: 'phone', host_runtime_capability: 1 },
}
let harness: ReturnType<typeof createReactHarness>
const scrollTo = Element.prototype.scrollTo
beforeEach(() => {
  harness = createReactHarness()
  Element.prototype.scrollTo = () => undefined
  composerDrafts.set(mobileCreationDraftKey('create-gate-owner'), '')
  rpc.options.mockReset()
  rpc.models.mockReset().mockResolvedValue({ harness: 'pi', models: [], efforts: [], selected: null, selectedEffort: null })
  rpc.create.mockReset().mockResolvedValue({ conversationId: 'made', projectId: 'phone-project', title: 'Task', session: { conversationId: 'made', supported: true } })
})
afterEach(() => {
  harness.cleanup()
  Element.prototype.scrollTo = scrollTo
})
const input = () => harness.container.querySelector<HTMLElement>('[data-testid="prompt-editor"]')!
const send = () => harness.container.querySelector<HTMLButtonElement>('[data-slot="composer-actions-end"] > button')!
async function write(text: string) {
  await act(async () => { writeComposer(input(), text) })
}

describe('phone first-send host readiness', () => {
  const remote: Device = { ...device, platform: 'linux', capabilities: { terminals: [], runtimes: ['codex', 'claude'] } }
  const prepareCodex = (signedIn = false, platformModel = 'platform:available-model') => {
    rpc.options.mockResolvedValue({
      ...options,
      harnesses: ['claude', 'codex'].map((id) => ({ ...options.harnesses[0]!, id, name: id })),
      lastUsed: { projectId: 'phone-project', harness: 'claude', sessionView: 'general', permissionMode: null, model: null, effort: null },
    })
    rpc.models.mockImplementation(async (_device: string, harness: string) => ({
      harness, transport: 'acp', selected: 'own-model', selectedEffort: null, efforts: [],
      harnessState: 'ready', harnessReason: null, guguReason: null,
      selectedCredential: signedIn ? 'credentialed' : 'uncredentialed', harnessAuth: signedIn ? 'signed-in' : 'signed-out',
      models: [
        { id: 'own-model', name: 'Own model', source: 'harness' },
        { id: platformModel, name: 'Available model', source: 'gugu' },
      ],
    }))
  }

  it('keeps the draft editable but waits for the existing catalogue before sending an automatic default', async () => {
    prepareCodex()
    const reading = deferred<SessionpageSessionCreateModels>()
    rpc.models.mockReturnValue(reading.promise)
    await harness.render(createNode(CreateSessionPage, { device: remote, onCreated: vi.fn() }))
    await write('Do not silently start an unsigned-in default')
    expect(send().disabled).toBe(true)
    expect(input().getAttribute('contenteditable')).toBe('true')
    expect(harness.container.querySelector('[data-blocker="loading_model"]')).toBeTruthy()
    await act(async () => { send().click() })
    expect(rpc.create).not.toHaveBeenCalled()
    await act(async () => {
      reading.resolve({ harness: 'claude', transport: 'acp', selected: null, selectedEffort: null, harnessState: 'auth-required', harnessReason: null, guguReason: null, models: [{ id: 'platform:available-model', source: 'gugu', name: 'Available model' }], efforts: [] })
      await reading.promise
    })
    expect(readComposer(input())).toBe('Do not silently start an unsigned-in default')
    expect(send().disabled).toBe(false)
    await act(async () => { send().click() })
    expect(rpc.create).toHaveBeenCalledExactlyOnceWith(remote.device_id, expect.objectContaining({ model: 'platform:available-model' }))
  })

  it('sends the shared available default after switching to an unsigned-in Codex', async () => {
    prepareCodex()
    await harness.render(createNode(CreateSessionPage, { device: remote, onCreated: vi.fn() }))
    await act(async () => { (harness.container.querySelector('[data-testid="pick-codex"]') as HTMLButtonElement).click() })
    await write('Run with an available model')
    await act(async () => { send().click() })
    expect(rpc.create).toHaveBeenCalledExactlyOnceWith(remote.device_id, expect.objectContaining({ harness: 'codex', model: 'platform:available-model' }))
  })

  it('does not replace an explicitly chosen own default when its catalogue returns', async () => {
    prepareCodex(true, 'platform:gpt-6-luna')
    await harness.render(createNode(CreateSessionPage, { device: remote, onCreated: vi.fn() }))
    await act(async () => { (harness.container.querySelector('[data-testid="pick-codex"]') as HTMLButtonElement).click() })
    await act(async () => { (harness.container.querySelector('[data-testid="pick-own-default"]') as HTMLButtonElement).click() })
    await write('Keep my explicit selection')
    await act(async () => { send().click() })
    expect(rpc.create).toHaveBeenCalledOnce()
    expect(rpc.create.mock.calls[0]?.[1]).not.toHaveProperty('model')
  })

  it('shows the existing sign-in explanation when the chosen own model has no login', async () => {
    prepareCodex()
    await harness.render(createNode(CreateSessionPage, { device: remote, onCreated: vi.fn() }))
    await act(async () => { (harness.container.querySelector('[data-testid="pick-codex"]') as HTMLButtonElement).click() })
    await act(async () => { (harness.container.querySelector('[data-testid="pick-own-default"]') as HTMLButtonElement).click() })
    await write('Keep this draft until sign-in')
    expect(harness.container.querySelector('[data-blocker="model_auth_required"]')?.textContent).toContain('登录')
    expect(send().disabled).toBe(true)
    expect(readComposer(input())).toBe('Keep this draft until sign-in')
    expect(rpc.create).not.toHaveBeenCalled()
  })

  it('retains a signed-in remembered own default even when a factory platform model is offered', async () => {
    prepareCodex(true, 'platform:gpt-6-luna')
    await harness.render(createNode(CreateSessionPage, { device: remote, onCreated: vi.fn() }))
    await write('Use the remembered own default')
    await act(async () => { send().click() })
    expect(rpc.create).toHaveBeenCalledOnce()
    expect(rpc.create.mock.calls[0]?.[1]).not.toHaveProperty('model')
  })

  it('keeps drafts editable while options load and enables a real send only after the host is ready', async () => {
    const reading = deferred<SessionpageSessionCreateOptions>()
    rpc.options.mockReturnValue(reading.promise)
    const onCreated = vi.fn()
    await harness.render(createNode(CreateSessionPage, { device, onCreated }))
    await write('请检查\n明天的日程')
    expect(input().getAttribute('contenteditable')).toBe('true')
    expect(send().disabled).toBe(true)
    expect(harness.container.querySelector('[data-testid="agent-watch-create-options-loading"]')).toBeTruthy()
    await act(async () => { send().click() })
    expect(rpc.create).not.toHaveBeenCalled()
    expect(readComposer(input())).toBe('请检查\n明天的日程')
    await act(async () => { reading.resolve(options); await reading.promise })
    expect(send().disabled).toBe(false)
    await act(async () => { input().dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })) })
    expect(rpc.create).not.toHaveBeenCalled()
    await act(async () => { send().click() })
    expect(rpc.create).toHaveBeenCalledExactlyOnceWith(device.device_id, expect.objectContaining({ prompt: '请检查\n明天的日程', projectId: 'phone-project', harness: 'pi' }))
    expect(onCreated).toHaveBeenCalledOnce()
  })

  it('retains the same editor and draft through option failure and retry, without sending defaults', async () => {
    const first = deferred<SessionpageSessionCreateOptions>()
    const retry = deferred<SessionpageSessionCreateOptions>()
    rpc.options.mockReturnValueOnce(first.promise).mockReturnValueOnce(retry.promise)
    await harness.render(createNode(CreateSessionPage, { device, onCreated: vi.fn() }))
    const field = input()
    await write('保留我的任务')
    await act(async () => { first.reject(new Error('host request timed out')); await Promise.resolve() })
    expect(input()).toBe(field)
    expect(readComposer(field)).toBe('保留我的任务')
    expect(send().disabled).toBe(true)
    expect(harness.container.querySelector('[data-testid="agent-watch-create-options-error"]')?.textContent).toContain('host request timed out')
    await act(async () => { (harness.container.querySelector('[data-testid="agent-watch-create-options-retry"]') as HTMLButtonElement).click() })
    expect(rpc.options).toHaveBeenCalledTimes(2)
    expect(input()).toBe(field)
    await write('重试中继续编辑')
    expect(send().disabled).toBe(true)
    expect(rpc.create).not.toHaveBeenCalled()
    await act(async () => { retry.resolve(options); await retry.promise })
    expect(readComposer(field)).toBe('重试中继续编辑')
    expect(send().disabled).toBe(false)
  })

  it('blocks a missing host selection and an offline phone without disabling or removing the draft', async () => {
    rpc.options.mockResolvedValue({ ...options, projects: [] })
    const props = { device, onCreated: vi.fn() }
    await harness.render(createNode(CreateSessionPage, props))
    const field = input()
    await write('稍后再发')
    expect(send().disabled).toBe(true)
    expect(harness.container.querySelector('[data-testid="agent-watch-create-blocker"]')?.getAttribute('data-blocker')).toBe('no_projects')
    await act(async () => { send().click() })
    expect(rpc.create).not.toHaveBeenCalled()
    await harness.render(createNode(CreateSessionPage, { ...props, device: { ...device, is_online: false } }))
    expect(input()).toBe(field)
    expect(readComposer(field)).toBe('稍后再发')
    expect(field.getAttribute('contenteditable')).toBe('true')
    expect(send().disabled).toBe(true)
    expect(harness.container.querySelector('[data-testid="agent-watch-offline-why"]')).toBeTruthy()
  })
})
