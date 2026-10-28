// @vitest-environment jsdom
import { act } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AssistantRuntimeProvider, useExternalStoreRuntime, type AttachmentAdapter, type PendingAttachment, type CompleteAttachment, type ThreadMessage } from '../../../../apps/desktop/node_modules/@assistant-ui/react'
import { Thread } from '@/components/assistant-ui/thread.aui'
import { ChatMessageComposer } from '@/components/chat/ChatMessageComposer'
import { DevicesContext, useDevicesStore } from '@/store/devicesContext'
import { startPhoneNewTask } from '@/mobile/chat/PhoneNewTask'
import * as tasks from '@/mobile/agent-watch/createTaskInGroup'
import * as rpc from '@/mobile/agent-watch/sessionpage-rpc'
import { clickElement, createReactHarness, device, renderWithAppProviders } from '../../../support/testHarness'
import { writeComposer } from '../../../support/composerEditor'
import { translateSessionMessage } from '@/session/renderer/localization/locale-store'

let harness: ReturnType<typeof createReactHarness>
const originalWidth = Object.getOwnPropertyDescriptor(window, 'innerWidth')!
const scrollTo = Element.prototype.scrollTo
const input = () => harness.container.querySelector<HTMLElement>('[contenteditable="true"]')!
const send = () => harness.container.querySelector<HTMLButtonElement>(`[data-slot="composer-bar"] button[aria-label="${translateSessionMessage('composer.sendMessage')}"]`)!
const file = () => new File(['notes'], 'keyboard-notes.txt', { type: 'text/plain' })
const attachmentAdapter: AttachmentAdapter = {
  accept: 'text/plain',
  async add({ file }: { file: File }): Promise<PendingAttachment> { return { id: 'notes', name: file.name, type: 'file', file, contentType: file.type, status: { type: 'requires-action', reason: 'composer-send' } } },
  async send(attachment: PendingAttachment): Promise<CompleteAttachment> { return { ...attachment, status: { type: 'complete' }, content: [{ type: 'text', text: 'attached notes' }] } },
  async remove() {},
}

beforeEach(() => {
  Object.defineProperty(window, 'innerWidth', { configurable: true, value: 390 })
  Element.prototype.scrollTo = () => undefined
  harness = createReactHarness()
})
afterEach(() => {
  harness.cleanup()
  Object.defineProperty(window, 'innerWidth', originalWidth)
  Element.prototype.scrollTo = scrollTo
})

async function mount(kind: 'group' | 'dm' | 'agent' | 'task') {
  const delivered = vi.fn(async () => {})
  const attached = vi.fn(async () => {})
  const created = vi.spyOn(tasks, 'createTaskInGroup').mockResolvedValue({ sessionId: 'session' })
  vi.spyOn(rpc, 'fetchCreateOptions').mockResolvedValue({ projects: [], lastUsed: null, harnesses: [
    { id: 'codex', name: 'Codex', status: 'available', watchable: true, sessionViews: ['general'], permissionModes: ['full-access'] },
  ] })
  function Agent() {
    const runtime = useExternalStoreRuntime<ThreadMessage>({ messages: [], onNew: delivered, adapters: { attachments: attachmentAdapter } })
    return <AssistantRuntimeProvider runtime={runtime}><Thread autoFocus={false} submitOnEnter={false} /></AssistantRuntimeProvider>
  }
  function Chat() {
    const base = useDevicesStore()
    return <DevicesContext.Provider value={{ ...base, devices: [device('machine', [], { projects: [{
      localProjectId: 'project', name: 'Project', rootPath: '/project', createdAt: '2026-10-26T00:00:00Z', chatId: 'chat', groupRepresentative: true,
      folders: [{ workspaceId: 'workspace', kind: 'root', path: '/project', attachedAt: null }],
    }] })] }}><ChatMessageComposer chatId="chat" isGroupChat={kind !== 'dm'} onSend={delivered} onSendAttachments={attached} /></DevicesContext.Provider>
  }
  await renderWithAppProviders(harness, kind === 'agent' ? <Agent /> : <Chat />)
  if (kind === 'task') {
    await act(async () => { startPhoneNewTask('chat') })
    await clickElement(harness.container.querySelector<HTMLElement>('[data-testid="project-folder-paper"]')!)
  }
  return { delivered, attached, created }
}

describe('phone keyboard across the real composer hosts', () => {
  for (const kind of ['group', 'dm', 'agent', 'task'] as const) {
    it.each(['button', 'enter', 'attachment'] as const)(`${kind}: %s follows the phone keyboard contract`, async (method) => {
      const { delivered, attached, created } = await mount(kind)
      await act(async () => { writeComposer(input(), 'keyboard check') })
      if (method === 'attachment') {
        const picker = harness.container.querySelector<HTMLInputElement>('input[type="file"]')!
        Object.defineProperty(picker, 'files', { configurable: true, value: [file()] })
        await act(async () => { picker.dispatchEvent(new Event('change', { bubbles: true })) })
        expect(harness.container.querySelector('[data-slot="composer-attachment"]')).not.toBeNull()
      }
      await act(async () => { input().focus() })
      expect(document.activeElement).toBe(input())
      const blurred = vi.fn()
      input().addEventListener('blur', blurred)
      await act(async () => {
        if (method === 'enter') input().dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }))
        else send().click() // DOM click deliberately does not move focus to the button.
      })
      if (method === 'enter') {
        expect(delivered).not.toHaveBeenCalled()
        expect(created).not.toHaveBeenCalled()
        expect(blurred).not.toHaveBeenCalled()
        expect(document.activeElement).toBe(input())
        return
      }
      expect(kind === 'task' ? created : delivered).toHaveBeenCalledTimes(1)
      if (method === 'attachment' && kind !== 'agent' && kind !== 'task') expect(attached).toHaveBeenCalledTimes(1)
      expect(blurred).toHaveBeenCalledTimes(1)
      expect(document.activeElement).toBe(document.body)
      await act(async () => { await new Promise((resolve) => setTimeout(resolve, 50)) })
      expect(document.activeElement).toBe(document.body)
    })
  }
})
