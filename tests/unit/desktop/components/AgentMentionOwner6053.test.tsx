// @vitest-environment jsdom
import { act } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { readComposer, writeComposer } from '../../../support/composerEditor'
import { ChatMessageComposer } from '../../../../apps/desktop/src/components/chat/ChatMessageComposer'
import { setLocalePreference } from '../../../../apps/desktop/src/i18n'
import type { GroupRosterCandidate } from '../../../../apps/desktop/src/lib/mention'
import { createReactHarness, renderWithAppProviders } from '../../../support/testHarness'

let harness: ReturnType<typeof createReactHarness>
const members: GroupRosterCandidate[] = [
  { id: 'human', name: 'Reader', type: 'human' },
  { id: 'agent-a', name: 'Solver', type: 'agent', ownerDisplayName: 'Alice' },
  { id: 'agent-b', name: 'Solver', type: 'agent', ownerDisplayName: 'Bob' },
  { id: 'unknown-owner', name: 'Other', type: 'agent' },
]

beforeEach(() => {
  vi.useFakeTimers()
  setLocalePreference('zh-CN')
  harness = createReactHarness()
})
afterEach(() => {
  harness.cleanup()
  vi.useRealTimers()
  setLocalePreference('zh-CN')
})

async function typeMention(value: string) {
  const textarea = harness.container.querySelector('[contenteditable]')!
  await act(async () => {
    writeComposer(textarea, value)
  })
  return textarea
}

describe('#6053 agent owners in the mention popup', () => {
  it.each(['mouse', 'keyboard'])('keeps the selected identity and mention text with %s selection', async (method) => {
    const setDraftMentions = vi.fn()
    const onSend = vi.fn(async () => {})
    await renderWithAppProviders(harness, <ChatMessageComposer
      onSend={onSend} chatId="group" isGroupChat groupMembers={members} currentUserId="owner-a"
      agentStatuses={{ 'agent-a': 'offline' }}
    />, { chat: { setDraftMentions } })
    const textarea = await typeMention('@')
    const options = Array.from(document.body.querySelectorAll('[role="option"]'))
    expect(options).toHaveLength(5)
    for (const [index, label] of ['所有人', 'Reader', 'Solver（Alice 的 agent）当前不在线，可能无法及时回复', 'Solver（Bob 的 agent）', 'Other'].entries()) {
      expect(options[index].textContent).toContain(label)
    }

    await typeMention('@Solver')
    const filtered = Array.from(document.body.querySelectorAll('[role="option"]'))
    expect(filtered).toHaveLength(2)
    expect(filtered[1].textContent).toContain('Solver（Bob 的 agent）')
    await act(async () => {
      if (method === 'mouse') filtered[1].dispatchEvent(new MouseEvent('mousedown', { bubbles: true }))
      else {
        textarea.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }))
      }
    })
    if (method === 'keyboard') {
      expect(filtered[1].getAttribute('aria-selected')).toBe('true')
      await act(async () => { textarea.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })) })
    }
    expect(readComposer(textarea)).toBe('@Solver ')
    expect(document.body.querySelector('[role="listbox"]')).toBeNull()
    await act(async () => { await vi.advanceTimersByTimeAsync(350) })
    expect(setDraftMentions).toHaveBeenLastCalledWith('group', [{ userId: 'agent-b', displayName: 'Solver' }])
    await act(async () => {
      harness.container.querySelector('button[aria-label="发送消息"]')!.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    expect(onSend).toHaveBeenLastCalledWith('@Solver', expect.objectContaining({ toUserIds: ['agent-b'] }))
  })

  it.each([
    { label: 'both same-named agents selected', firstPick: true, secondPick: true, text: '@Solver @Solver', ids: ['agent-b', 'agent-a'] },
    { label: 'one selected agent and another typed name', firstPick: true, secondPick: false, text: '@Solver @Reader', ids: ['agent-b', 'human'] },
    { label: 'same-named agents typed without picking', firstPick: false, secondPick: false, text: '@Solver', ids: ['agent-a', 'agent-b'] },
  ])('#6055 sends the expected recipients: $label', async ({ firstPick, secondPick, text, ids }) => {
    const onSend = vi.fn(async () => {})
    await renderWithAppProviders(harness, <ChatMessageComposer onSend={onSend} isGroupChat groupMembers={members} />)
    const pick = async (owner: string) => {
      const option = Array.from(document.body.querySelectorAll('[role="option"]'))
        .find((item) => item.textContent?.includes(`Solver（${owner} 的 agent）`))!
      expect(option).toBeDefined()
      await act(async () => { option.dispatchEvent(new MouseEvent('mousedown', { bubbles: true })) })
    }
    if (firstPick) {
      await typeMention('@Solver')
      await pick('Bob')
    }
    await typeMention(text)
    if (secondPick) await pick('Alice')
    await act(async () => {
      harness.container.querySelector('button[aria-label="发送消息"]')!.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    expect(onSend).toHaveBeenLastCalledWith(text, expect.objectContaining({ toUserIds: ids }))
  })

  it('refreshes late owner identities, renamed owners and language while the picker stays open', async () => {
    const onSend = vi.fn()
    const render = (groupMembers: GroupRosterCandidate[]) => renderWithAppProviders(harness,
      <ChatMessageComposer onSend={onSend} isGroupChat groupMembers={groupMembers} />)
    await render(members.map((member) => member.id === 'agent-b' ? { ...member, ownerDisplayName: undefined } : member))
    await typeMention('@Solver')
    expect(document.body.querySelector('[role="listbox"]')?.textContent).not.toContain('Bob')
    await render(members)
    expect(document.body.querySelector('[role="listbox"]')?.textContent).toContain('Solver（Bob 的 agent）')
    await act(async () => { setLocalePreference('en-US') })
    expect(document.body.querySelector('[role="listbox"]')?.textContent).toContain("Solver (Alice's agent)")
    await render(members.map((member) => member.id === 'agent-b' ? { ...member, ownerDisplayName: 'Robert' } : member))
    const popup = document.body.querySelector('[role="listbox"]')!
    expect(popup.textContent).toContain("Solver (Robert's agent)")
    expect(popup.textContent).not.toContain("Bob's agent")
  })
})
