// @vitest-environment jsdom
import { act } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Device } from '@gugu/core/shared/types/chat'
import type { SessionpageSessionCreateOptions } from '@gugu/session-core/session-record/contract'
import { CreateSessionPage } from '../../../apps/desktop/src/mobile/agent-watch/CreateSessionPage'
import { composerDrafts } from '../../../apps/desktop/src/session/renderer/features/sessions/composer-drafts'
import { mobileCreationDraftKey } from '../../../apps/desktop/src/mobile/agent-watch/create-session-draft'
import { createNode, createReactHarness, deferred } from '../../support/testHarness'

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
const input = () => harness.container.querySelector('textarea')!
const send = () => harness.container.querySelector<HTMLButtonElement>('.aui-composer-send')!
async function write(text: string) {
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set?.call(input(), text)
    input().dispatchEvent(new Event('input', { bubbles: true }))
  })
}

describe('phone first-send host readiness', () => {
  it('keeps drafts editable while options load and enables a real send only after the host is ready', async () => {
    const reading = deferred<SessionpageSessionCreateOptions>()
    rpc.options.mockReturnValue(reading.promise)
    const onCreated = vi.fn(), onPickHost = vi.fn()
    await harness.render(createNode(CreateSessionPage, { device, onCreated, landing: true, onPickHost }))
    await write('请检查\n明天的日程')
    expect(input().disabled).toBe(false)
    expect(send().disabled).toBe(true)
    expect(harness.container.querySelector('[data-testid="agent-watch-create-options-loading"]')).toBeTruthy()
    await act(async () => { send().click(); input().closest('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })) })
    expect(rpc.create).not.toHaveBeenCalled()
    expect(input().value).toBe('请检查\n明天的日程')
    await act(async () => { (harness.container.querySelector('[data-testid="phone-conversation-host"]') as HTMLButtonElement).click() })
    expect(onPickHost).toHaveBeenCalledOnce()
    expect(input().value).toBe('请检查\n明天的日程')
    await act(async () => { reading.resolve(options); await reading.promise })
    expect(send().disabled).toBe(false)
    await act(async () => { input().dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })) })
    expect(rpc.create).not.toHaveBeenCalled()
    await act(async () => { send().click() })
    expect(rpc.create).toHaveBeenCalledExactlyOnceWith(device.device_id, expect.objectContaining({ prompt: '请检查\n明天的日程', projectId: 'phone-project', harness: 'pi' }))
    expect(onCreated).toHaveBeenCalledOnce()
  })

  it('retains the same textarea and draft through option failure and retry, without sending defaults', async () => {
    const first = deferred<SessionpageSessionCreateOptions>()
    const retry = deferred<SessionpageSessionCreateOptions>()
    rpc.options.mockReturnValueOnce(first.promise).mockReturnValueOnce(retry.promise)
    await harness.render(createNode(CreateSessionPage, { device, onCreated: vi.fn() }))
    const field = input()
    await write('保留我的任务')
    await act(async () => { first.reject(new Error('host request timed out')); await Promise.resolve() })
    expect(input()).toBe(field)
    expect(field.value).toBe('保留我的任务')
    expect(send().disabled).toBe(true)
    expect(harness.container.querySelector('[data-testid="agent-watch-create-options-error"]')?.textContent).toContain('host request timed out')
    await act(async () => { (harness.container.querySelector('[data-testid="agent-watch-create-options-retry"]') as HTMLButtonElement).click() })
    expect(rpc.options).toHaveBeenCalledTimes(2)
    expect(input()).toBe(field)
    await write('重试中继续编辑')
    expect(send().disabled).toBe(true)
    expect(rpc.create).not.toHaveBeenCalled()
    await act(async () => { retry.resolve(options); await retry.promise })
    expect(field.value).toBe('重试中继续编辑')
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
    expect(field.value).toBe('稍后再发')
    expect(field.disabled).toBe(false)
    expect(send().disabled).toBe(true)
    expect(harness.container.querySelector('[data-testid="agent-watch-offline-why"]')).toBeTruthy()
  })
})
