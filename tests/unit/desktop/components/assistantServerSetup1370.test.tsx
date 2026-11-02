// @vitest-environment jsdom
import { act, createElement, StrictMode } from 'react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { createReactHarness } from '../../../support/testHarness'
import '../../../../apps/desktop/src/i18n/registerAssistantCatalog'

const f = vi.hoisted(() => ({
  list: vi.fn(), setup: vi.fn(), resume: vi.fn(), pending: null as Record<string, unknown> | null,
  reload: vi.fn(), step: vi.fn(), back: vi.fn(),
  SetupError: class extends Error {
    constructor(readonly code: string) { super(code) }
  },
}))
vi.mock('@/lib/assistantServerSetup', () => ({
  AssistantServerSetupError: f.SetupError, listAssistantServerTargets: f.list,
  setUpAssistantOnServer: f.setup, resumeServerAssistant: f.resume, pendingServerAssistant: () => f.pending,
}))
vi.mock('@/lib/assistantSetupState', () => ({ offerCustomizeCard: vi.fn(), writeSetupStep: f.step }))
vi.mock('@/lib/myAssistant', () => ({ reloadMyAssistant: f.reload }))
vi.mock('@/lib/log', () => ({ rendererLogger: () => ({ error: vi.fn() }) }))

import { AssistantServerSetup } from '../../../../apps/desktop/src/components/assistant/AssistantServerSetup'
const draft = { name: '小满', color: 0, rest: 'neutral' as const, owner: { preferredName: '主人', about: '研究者' } }
const record = () => ({ version: 1, ownerUserId: 'owner', deviceId: 'linux', deviceLabel: '研究服务器', operationId: 'op-1', draft, installationStarted: true, model: null })
let harness: ReturnType<typeof createReactHarness>
beforeEach(() => {
  harness = createReactHarness(); vi.clearAllMocks(); f.pending = null
  f.list.mockResolvedValue([{ deviceId: 'linux', label: '研究服务器', selectable: true, reason: null },
    { deviceId: 'mac', label: 'Mac 服务器', selectable: false, reason: 'unsupported_platform' }])
  f.setup.mockReset(); f.resume.mockReset()
})
afterEach(() => harness.cleanup())
async function render(strict = false) {
  const child = createElement(AssistantServerSetup, { ownerUserId: 'owner', name: '小满', createDraft: async () => draft, onBack: f.back })
  await harness.render(createElement(QueryClientProvider, { client: new QueryClient({ defaultOptions: { queries: { retry: false } } }) }, strict ? createElement(StrictMode, null, child) : child))
  await vi.waitFor(() => expect(f.list).toHaveBeenCalled())
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 10)) })
}
const query = (id: string) => harness.container.querySelector<HTMLElement>(`[data-testid="${id}"]`)
async function click(element: Element | null) { expect(element).not.toBeNull(); await act(async () => (element as HTMLElement).click()) }

it('passes the existing draft and selected Linux target, and waits for actual completion', async () => {
  let finish!: () => void
  f.setup.mockImplementation(() => new Promise<void>(resolve => { finish = resolve }))
  await render()
  const targets = harness.container.querySelectorAll('[data-testid="assistant-server-target"]')
  expect((targets[1] as HTMLButtonElement).disabled).toBe(true)
  expect((query('assistant-server-install') as HTMLButtonElement).disabled).toBe(true)
  await click(targets[0]); await click(query('assistant-server-install'))
  expect(f.setup).toHaveBeenCalledWith(draft, 'linux', expect.objectContaining({ signal: expect.any(AbortSignal) }))
  expect(f.reload).not.toHaveBeenCalled()
  expect(f.step).not.toHaveBeenCalledWith('owner', 'connect')
  await act(async () => finish())
  expect(f.step).toHaveBeenLastCalledWith('owner', 'connect')
  expect(f.reload).toHaveBeenCalledWith('owner')
})

it('retries the original operation and blocks Back after installation begins', async () => {
  f.setup.mockImplementation(async (_draft, _device, options) => {
    f.pending = record(); options.onInstalling()
    options.onProgress({ phase: 'failed', cancellable: false })
    throw new f.SetupError('runtime_failed')
  })
  f.resume.mockImplementation(() => new Promise(() => {}))
  await render()
  await click(query('assistant-server-target')); await click(query('assistant-server-install'))
  expect(query('assistant-server-error')?.textContent).toContain('运行程序')
  expect([...harness.container.querySelectorAll('button')].some(button => button.textContent === '返回')).toBe(false)
  await click(query('assistant-server-install'))
  expect(f.resume).toHaveBeenCalledOnce()
  expect(f.setup).toHaveBeenCalledOnce()
})

it('shows a read failure rather than claiming there are no servers', async () => {
  f.list.mockRejectedValue(new Error('Network failure'))
  await render()
  expect(harness.container.textContent).toContain('服务器列表没能读到')
  expect(query('assistant-server-empty')).toBeNull()
  expect(f.setup).not.toHaveBeenCalled()
})

it('waits for cleanup before returning from a failed preparation', async () => {
  f.setup.mockImplementation(async (_draft, _device, options) => {
    f.pending = { ...record(), installationStarted: false }
    options.onProgress({ phase: 'failed', cancellable: true })
    throw new f.SetupError('runtime_failed')
  })
  f.resume.mockImplementation(async options => {
    expect(options.signal.aborted).toBe(true)
    expect(f.back).not.toHaveBeenCalled()
    f.pending = null
    throw new DOMException('Cancelled', 'AbortError')
  })
  await render()
  await click(query('assistant-server-target')); await click(query('assistant-server-install'))
  await click([...harness.container.querySelectorAll('button')].find(button => button.textContent === '返回') ?? null)
  expect(f.resume).toHaveBeenCalledOnce()
  expect(f.setup).toHaveBeenCalledOnce()
  expect(f.back).toHaveBeenCalledOnce()
})

it('resumes a persisted server setup once under StrictMode', async () => {
  f.pending = record()
  f.resume.mockImplementation(() => new Promise(() => {}))
  const child = createElement(AssistantServerSetup, { ownerUserId: 'owner', name: '小满', createDraft: async () => draft, onBack: f.back })
  await harness.render(createElement(StrictMode, null, createElement(QueryClientProvider, { client: new QueryClient() }, child)))
  await act(async () => {})
  expect(f.resume).toHaveBeenCalledOnce()
  expect(f.resume.mock.calls[0][0].signal.aborted).toBe(false)
  expect(f.setup).not.toHaveBeenCalled()
  expect(f.list).not.toHaveBeenCalled()
})
