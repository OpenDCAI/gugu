// @vitest-environment jsdom
import { act } from 'react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { SessionpageSessionCreateModels, SessionpageSessionCreateOptions } from '@gugu/session-core/session-record/contract'
import { ChatMessageComposer } from '@/components/chat/ChatMessageComposer'
import { DevicesContext, useDevicesStore } from '@/store/devicesContext'
import { startPhoneNewTask } from '@/mobile/chat/PhoneNewTask'
import * as tasks from '@/mobile/agent-watch/createTaskInGroup'
import * as rpc from '@/mobile/agent-watch/sessionpage-rpc'
import { clickElement, createReactHarness, deferred, device, renderWithAppProviders } from '../../support/testHarness'
import { readComposer, writeComposer } from '../../support/composerEditor'

let harness: ReturnType<typeof createReactHarness>
const width = Object.getOwnPropertyDescriptor(window, 'innerWidth')!
const options: SessionpageSessionCreateOptions = {
  projects: [{ id: 'project', name: 'Project', path: '/project' }], lastUsed: null,
  harnesses: ['claude', 'codex'].map((id) => ({ id, name: id === 'codex' ? 'Codex' : 'Claude', status: 'available', watchable: true, sessionViews: ['general'], permissionModes: ['full-access'] })),
}
const catalogue = (harness = 'codex', signedIn = false): SessionpageSessionCreateModels => ({
  harness, transport: 'acp', selected: 'own-model', selectedEffort: null, efforts: [],
  harnessState: 'ready', harnessReason: null, guguReason: null,
  harnessAuth: signedIn ? 'signed-in' : 'signed-out', selectedCredential: signedIn ? 'credentialed' : 'uncredentialed',
  models: [{ id: 'own-model', name: 'Own model', source: 'harness' }, { id: 'platform:available-model', name: 'Available model', source: 'gugu' }],
})
const input = () => harness.container.querySelector<HTMLElement>('[data-testid="chat-composer"]')!
const send = async () => { await clickElement(harness.container.querySelector<HTMLButtonElement>('[data-slot="composer-bar"] button[aria-label="发送消息"]')!) }
beforeEach(() => {
  Object.defineProperty(window, 'innerWidth', { configurable: true, value: 390 })
  harness = createReactHarness()
  vi.spyOn(rpc, 'fetchCreateOptions').mockResolvedValue(options)
  vi.spyOn(rpc, 'fetchCreateModels').mockImplementation(async (_device, harness) => catalogue(harness))
  vi.spyOn(tasks, 'createTaskInGroup').mockResolvedValue({ sessionId: 'session' })
})
afterEach(() => { harness.cleanup(); Object.defineProperty(window, 'innerWidth', width); vi.restoreAllMocks() })
async function mount() {
  function Host() {
    const base = useDevicesStore()
    return <DevicesContext.Provider value={{ ...base, devices: [device('machine', [], { projects: [{
      localProjectId: 'project', name: 'Project', rootPath: '/project', createdAt: '2026-10-26T00:00:00Z', chatId: 'chat',
      folders: [{ workspaceId: 'workspace', kind: 'root', path: '/project', attachedAt: null }],
    }] })] }}><ChatMessageComposer chatId="chat" isGroupChat onSend={vi.fn()} /></DevicesContext.Provider>
  }
  await renderWithAppProviders(harness, <Host />)
  await act(async () => { startPhoneNewTask('chat'); writeComposer(input(), 'Keep this task draft') })
  await clickElement(harness.container.querySelector<HTMLElement>('[data-testid="project-folder-paper"]')!)
}
async function pickCodex() {
  await clickElement(harness.container.querySelector<HTMLElement>('[data-testid="phone-task-tag"] button[aria-haspopup="menu"]')!)
  await clickElement([...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].find((item) => item.textContent === 'Codex')!)
}

it('dispatches the original group new-task route with the shared available model after switching Claude to unsigned-in Codex', async () => {
  await mount()
  await pickCodex()
  await send()
  expect(rpc.fetchCreateModels).toHaveBeenCalledWith('machine', 'codex', null, null)
  expect(tasks.createTaskInGroup).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ harness: 'codex', model: 'platform:available-model', chatId: 'chat', cwd: '/project' }))
  expect(readComposer(input())).toBe('')
})

it('keeps a quick-send draft until that harness catalogue arrives', async () => {
  const pending = deferred<SessionpageSessionCreateModels>()
  vi.mocked(rpc.fetchCreateModels).mockReturnValue(pending.promise)
  await mount()
  await pickCodex()
  await send()
  expect(tasks.createTaskInGroup).not.toHaveBeenCalled()
  expect(readComposer(input())).toBe('Keep this task draft')
  expect(harness.container.querySelector('[data-testid="phone-task-tag"]')?.textContent).toContain('模型')
  await act(async () => { pending.resolve(catalogue()); await pending.promise })
  await send()
  expect(tasks.createTaskInGroup).toHaveBeenCalledWith(expect.objectContaining({ harness: 'codex', model: 'platform:available-model' }))
})

it('keeps the draft and shows the shared sign-in explanation when no platform model is available', async () => {
  vi.mocked(rpc.fetchCreateModels).mockImplementation(async (_device, harness) => ({ ...catalogue(harness), models: catalogue(harness).models.filter((model) => model.source === 'harness') }))
  await mount()
  await pickCodex()
  await send()
  expect(tasks.createTaskInGroup).not.toHaveBeenCalled()
  expect(readComposer(input())).toBe('Keep this task draft')
  expect(harness.container.querySelector('[data-testid="phone-task-tag"]')?.textContent).toContain('还没登录')
})

it('uses the same remembered signed-in own default as CreateSessionPage', async () => {
  vi.mocked(rpc.fetchCreateOptions).mockResolvedValue({ ...options, lastUsed: { projectId: 'project', harness: 'codex', model: null, effort: null, permissionMode: null, sessionView: 'general' } })
  vi.mocked(rpc.fetchCreateModels).mockImplementation(async (_device, harness) => catalogue(harness, true))
  await mount()
  await send()
  expect(tasks.createTaskInGroup).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ harness: 'codex', model: undefined }))
})

it('replaces a remembered own model that is no longer signed in with the shared available default', async () => {
  vi.mocked(rpc.fetchCreateOptions).mockResolvedValue({ ...options, lastUsed: { projectId: 'project', harness: 'codex', model: 'own-model', effort: null, permissionMode: null, sessionView: 'general' } })
  await mount()
  await send()
  expect(tasks.createTaskInGroup).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ harness: 'codex', model: 'platform:available-model' }))
})

it('does not dispatch an engine default when the catalogue read fails', async () => {
  vi.mocked(rpc.fetchCreateModels).mockRejectedValue(new Error('catalogue unavailable'))
  await mount()
  await send()
  expect(tasks.createTaskInGroup).not.toHaveBeenCalled()
  expect(readComposer(input())).toBe('Keep this task draft')
  expect(harness.container.querySelector('[data-testid="phone-task-tag"]')?.textContent).toContain('读不到')
})
