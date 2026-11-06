// @vitest-environment jsdom
import { act } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentDisplayStatus } from '@gugu/core/shared/types/chat'
import { ChatMessageComposer } from '../../../../apps/desktop/src/components/chat/ChatMessageComposer'
import { setLocalePreference } from '../../../../apps/desktop/src/i18n'
import type { GroupRosterCandidate } from '../../../../apps/desktop/src/lib/mention'
import { installIdentityDirectoryBridge, publishIdentityDirectory } from '../../../../apps/desktop/src/lib/identityDirectoryBridge'
import { publishDirectoryDevices } from '../../../../apps/desktop/src/session/shared/remote-sessions/session-directory'
import { readComposer, writeComposer } from '../../../support/composerEditor'
import { createReactHarness, device, displayIdentity, renderWithAppProviders } from '../../../support/testHarness'

const { mobile } = vi.hoisted(() => ({ mobile: { value: false } }))
vi.mock('../../../../apps/desktop/src/hooks/useMobileShell', () => ({ useMobileShell: () => mobile.value }))

const members: GroupRosterCandidate[] = [
  { id: 'agent-a', name: 'Solver', type: 'agent' },
  { id: 'agent-b', name: 'Other', type: 'agent' },
  { id: 'human', name: 'Reader', type: 'human' },
]
let harness: ReturnType<typeof createReactHarness>
const onSend = vi.fn(async () => {})
const toast = vi.fn()
installIdentityDirectoryBridge()

beforeEach(() => {
  vi.useFakeTimers()
  mobile.value = false
  onSend.mockClear()
  toast.mockClear()
  setLocalePreference('zh-CN')
  harness = createReactHarness()
})
afterEach(() => {
  harness.cleanup()
  publishIdentityDirectory(null, null)
  publishDirectoryDevices([])
  vi.useRealTimers()
})

function render(status?: AgentDisplayStatus, mentionToInsert?: { id: string; name: string }, isGroupChat = true) {
  return renderWithAppProviders(harness, <ChatMessageComposer
    onSend={onSend} chatId="mention-status-group" isGroupChat={isGroupChat} groupMembers={members}
    currentUserId="owner" agentStatuses={status ? { 'agent-a': status, human: 'offline' } : {}}
    mentionToInsert={mentionToInsert} onMentionInserted={() => {}}
  />, { toast })
}
const editor = () => harness.container.querySelector<HTMLElement>('[contenteditable=true]')!
const caption = () => harness.container.querySelector('[data-agent-status-surface="mention-inline"]')

describe('selected Agent status belongs to its mention', () => {
  it.each([
    ['offline', '不在线'], ['archived', '已归档'], ['idle', null], ['pending', null], [undefined, null],
  ] as const)('shows only the expected caption for %s without changing the submitted recipient', async (status, expected) => {
    await render(status, { id: 'agent-a', name: 'Solver' })
    expect(caption()?.textContent ?? null).toBe(expected)
    expect(harness.container.querySelector('[data-agent-status-surface="mention-selection"]')).toBeNull()
    expect(readComposer(editor())).toBe('@Solver ')
    expect(toast).not.toHaveBeenCalled()
    await act(async () => {
      harness.container.querySelector('button[aria-label="发送消息"]')!.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    expect(onSend).toHaveBeenCalledWith('@Solver', expect.objectContaining({ toUserIds: ['agent-a'] }))
    expect(caption()).toBeNull()
  })

  it('updates an existing mention on status changes without resetting its document', async () => {
    await render('offline', { id: 'agent-a', name: 'Solver' })
    const selected = editor().querySelector('[data-mention-id="agent-a"]')
    expect(caption()?.textContent).toBe('不在线')
    await render('archived')
    expect(caption()?.textContent).toBe('已归档')
    expect(editor().querySelector('[data-mention-id="agent-a"]')).toBe(selected)
    await render('idle')
    expect(caption()).toBeNull()
    expect(readComposer(editor())).toBe('@Solver ')
    await render('offline')
    expect(caption()?.textContent).toBe('不在线')
    expect(toast).not.toHaveBeenCalled()
    await act(async () => { writeComposer(editor(), '') })
    expect(caption()).toBeNull()
    await render('offline', { id: 'agent-a', name: 'Solver' })
    expect(caption()?.textContent).toBe('不在线')
  })

  it('keeps human, everyone and online Agent mentions free of the offline caption', async () => {
    await render('idle', { id: 'human', name: 'Reader' })
    expect(caption()).toBeNull()
    await act(async () => { writeComposer(editor(), '@') })
    const all = Array.from(document.body.querySelectorAll('[role=option]')).find(e => e.textContent?.includes('所有人'))!
    expect(all).toBeDefined()
    await act(async () => { all.dispatchEvent(new MouseEvent('mousedown', { bubbles: true })) })
    expect(editor().textContent).toContain('@所有人')
    expect(caption()).toBeNull()
  })

  it('restores a saved selected target after reopening its draft without changing the text', async () => {
    const text = 'Before\n@Solver please inspect this.'
    await renderWithAppProviders(harness, <ChatMessageComposer onSend={onSend} chatId="saved" isGroupChat groupMembers={members}
      agentStatuses={{ 'agent-a': 'offline' }} />, { toast, chat: {
        drafts: { saved: text }, draftMentions: { saved: [{ userId: 'agent-a', displayName: 'Solver' }] },
      } })
    expect(caption()?.textContent).toBe('不在线')
    expect(editor().querySelectorAll('[data-mention-id="agent-a"]')).toHaveLength(1)
    expect(readComposer(editor())).toBe(text)
    expect(toast).not.toHaveBeenCalled()
  })

  it('does not turn an unselected typed name into an object while restoring a draft', async () => {
    await renderWithAppProviders(harness, <ChatMessageComposer onSend={onSend} chatId="typed" isGroupChat groupMembers={members}
      agentStatuses={{ 'agent-a': 'offline' }} />, { chat: { drafts: { typed: '@Solver please inspect this.' } } })
    expect(caption()).toBeNull()
    expect(editor().querySelector('[data-mention-id]')).toBeNull()
    expect(readComposer(editor())).toBe('@Solver please inspect this.')
  })

  it('keeps the phone selection notice unchanged in this desktop-only change', async () => {
    mobile.value = true
    await render('offline', { id: 'agent-a', name: 'Solver' })
    expect(caption()).toBeNull()
    expect(harness.container.querySelector('[data-agent-status-surface="mention-selection"]')?.textContent)
      .toBe('当前不在线，可能无法及时回复')
  })

  it('keeps the on-demand cloud exception while still exposing archival', async () => {
    act(() => {
      publishIdentityDirectory({ 'agent-a': displayIdentity('agent-a', { type: 'agent', device_id: 'cloud-host' }) }, null)
      publishDirectoryDevices([device('cloud-host', [], { cloud_computer: 'asleep', is_online: false })])
    })
    await render('offline', { id: 'agent-a', name: 'Solver' })
    expect(caption()).toBeNull()
    await render('archived')
    expect(caption()?.textContent).toBe('已归档')
    await render('offline')
    act(() => { publishDirectoryDevices([device('cloud-host', [], { is_online: false })]) })
    expect(caption()?.textContent).toBe('不在线')
    expect(caption()?.getAttribute('aria-label')).toContain('上线后也不补投')
    expect(toast).not.toHaveBeenCalled()
  })

  it('does not introduce a member picker into private chats', async () => {
    await render('offline', undefined, false)
    await act(async () => { writeComposer(editor(), '@') })
    expect(document.body.querySelector('[role=listbox]')).toBeNull()
    expect(caption()).toBeNull()
    expect(harness.container.querySelector('[data-agent-status-surface="mention-selection"]')).toBeNull()
  })
})
