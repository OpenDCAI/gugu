// @vitest-environment jsdom
import { act, useState } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ChatMessageComposer, type ChatMessageComposerProps } from '../../../../apps/desktop/src/components/chat/ChatMessageComposer'
import { buildGroupRosterCandidates } from '../../../../apps/desktop/src/lib/mention'
import { plainTextDoc } from '../../../../packages/session-ui/src/react/components/prompt-editor/serialize'
import { createReactHarness, renderWithAppProviders } from '../../../support/testHarness'
import { readComposer, writeComposer } from '../../../support/composerEditor'

const members: NonNullable<ChatMessageComposerProps['groupMembers']> = [
  { id: 'alpha', name: 'Alpha', type: 'agent' },
  { id: 'beta', name: 'Beta', type: 'agent' },
  { id: 'human', name: 'Human', type: 'human' },
]
let harness: ReturnType<typeof createReactHarness>
let update: (props: Partial<ChatMessageComposerProps>) => void
const input = () => harness.container.querySelector<HTMLElement>('[contenteditable="true"]')!
const hint = () => harness.container.querySelector<HTMLButtonElement>('[data-testid="group-mention-hint"]')
const sender = () => vi.fn(async () => {})
async function mount(onSend = sender(), initial: Partial<ChatMessageComposerProps> = {}) {
  function Fixture() {
    const [props, setProps] = useState<Partial<ChatMessageComposerProps>>(initial)
    update = (next) => setProps((current) => ({ ...current, ...next }))
    return <ChatMessageComposer chatId="room" currentUserId="account-a" isGroupChat groupMembers={members} onSend={onSend} {...props} />
  }
  await renderWithAppProviders(harness, <Fixture />)
  return onSend
}
async function type(text: string) { await act(async () => { writeComposer(input(), text) }) }
async function send() {
  await act(async () => { harness.container.querySelector<HTMLButtonElement>('[data-slot="composer-bar"] button[aria-label="发送消息"]')!.click() })
}
async function key(key: string, init: KeyboardEventInit = {}) {
  const event = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...init })
  await act(async () => { input().focus(); input().dispatchEvent(event) })
  return event
}
beforeEach(() => { localStorage.clear(); harness = createReactHarness() })
afterEach(() => harness.cleanup())

describe('group mention recall through the real composer and send path', () => {
  it.each(['@Beta @Alpha hello', '@[Beta](aid:beta) @Alpha hello'])('remembers textual first rather than roster/picker order: %s', async (body) => {
    const onSend = await mount()
    await type(body)
    await send()
    expect(onSend).toHaveBeenCalledOnce()
    expect(hint()?.textContent).toBe('@Beta')
    expect(readComposer(input())).toBe('')
    expect(harness.container.querySelector('[data-slot="composer-bar"] button[aria-label="发送消息"]')?.hasAttribute('disabled')).toBe(true)
    await type('ordinary message without mentions')
    await send()
    expect(hint()?.textContent).toBe('@Beta')
  })

  it.each(['@Human @Beta hello', '@所有人 @Beta hello'])('does not recall a human or broadcast first target: %s', async (body) => {
    await mount()
    await type('@Alpha hi'); await send()
    expect(hint()).not.toBeNull()
    await type(body); await send()
    expect(hint()).toBeNull()
  })

  it.each(['ArrowRight', 'Tab'])('accepts %s as the same structural mention and recipient as manual member insertion', async (acceptKey) => {
    const onSend = await mount()
    await type('@Beta hi'); await send()
    const event = await key(acceptKey)
    expect(event.defaultPrevented).toBe(true)
    expect(hint()).toBeNull()
    const recalled = readComposer(input())
    expect(input().querySelector('[data-mention-id="beta"]')).not.toBeNull()
    expect(onSend).toHaveBeenCalledTimes(1)
    await send()
    expect(onSend.mock.calls.at(-1)).toEqual([recalled, expect.objectContaining({ toUserIds: ['beta'] })])
    await act(async () => { update({ mentionToInsert: { id: 'beta', name: 'Beta' } }) })
    expect(readComposer(input())).toBe(recalled)
    await send()
    expect(onSend.mock.calls.at(-1)).toEqual([recalled, expect.objectContaining({ toUserIds: ['beta'] })])
  })

  it.each(['x', ' ', '\n', '@'])('hides immediately for nonempty input %j and returns after deletion', async (text) => {
    await mount(); await type('@Alpha hi'); await send()
    expect(hint()).not.toBeNull()
    await type(text)
    expect(hint()).toBeNull()
    expect((await key('ArrowRight')).defaultPrevented).toBe(false)
    if (text !== '\n') expect(readComposer(input())).toBe(text)
    else expect(input().querySelectorAll('p')).toHaveLength(2) // Existing serialization trims trailing newlines; document still has input.
    await type('')
    expect(hint()?.textContent).toBe('@Alpha')
  })

  it('preserves IME, modified keys, toolbar focus and live input newer than React state', async () => {
    await mount(); await type('@Alpha hi'); await send()
    for (const modifiers of [{ shiftKey: true }, { altKey: true }, { ctrlKey: true }, { metaKey: true }, { isComposing: true }]) {
      expect((await key('Tab', modifiers)).defaultPrevented).toBe(false)
      expect(readComposer(input())).toBe('')
    }
    await act(async () => { input().dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true })) })
    expect(hint()).toBeNull()
    await act(async () => { input().dispatchEvent(new CompositionEvent('compositionend', { bubbles: true })) })
    expect(hint()).not.toBeNull()
    const toolbar = harness.container.querySelector<HTMLButtonElement>('[data-slot="composer-actions-start"] button')!
    const tab = new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true })
    await act(async () => { toolbar.dispatchEvent(tab) })
    expect(tab.defaultPrevented).toBe(false)
    const live = input() as HTMLElement & { editor: { commands: { setContent: (doc: ReturnType<typeof plainTextDoc>, options: { emitUpdate: boolean }) => void } } }
    await act(async () => { live.editor.commands.setContent(plainTextDoc('newer'), { emitUpdate: false }) })
    expect((await key('ArrowRight')).defaultPrevented).toBe(false)
    expect(readComposer(input())).toBe('newer')
  })

  it('uses the same token when tapping the phone hint, without submitting', async () => {
    const width = Object.getOwnPropertyDescriptor(window, 'innerWidth')!
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: 390 })
    try {
      const onSend = await mount(); await type('@Beta hi'); await send()
      expect(harness.container.querySelector('[data-mobile-group="true"]')).not.toBeNull()
      expect(hint()?.textContent).toBe('@Beta')
      await act(async () => { hint()!.click() })
      expect(input().querySelector('[data-mention-id="beta"]')).not.toBeNull()
      expect(onSend).toHaveBeenCalledTimes(1)
      await send()
      expect(onSend.mock.calls.at(-1)).toEqual([expect.any(String), expect.objectContaining({ toUserIds: ['beta'] })])
    } finally { Object.defineProperty(window, 'innerWidth', width) }
  })

  it('isolates groups and signed-in accounts and survives remount on the same account', async () => {
    await mount(); await type('@Alpha hi'); await send()
    await act(async () => update({ chatId: 'other' }))
    expect(hint()).toBeNull()
    await type('@Beta hi'); await send()
    expect(hint()?.textContent).toBe('@Beta')
    await act(async () => update({ chatId: 'room' }))
    expect(hint()?.textContent).toBe('@Alpha')
    await act(async () => update({ currentUserId: 'account-b' }))
    expect(hint()).toBeNull()
    await type('@Beta hi'); await send()
    await act(async () => update({ currentUserId: null }))
    expect(hint()).toBeNull()
    await act(async () => update({ currentUserId: 'account-a' }))
    expect(hint()?.textContent).toBe('@Alpha')
    harness.cleanup(); harness = createReactHarness()
    await mount()
    expect(hint()?.textContent).toBe('@Alpha')
  })

  it('uses current IDs/names, rejects departed/removed members, and never borrows source-topic invitees', async () => {
    await mount(); await type('@Alpha hi'); await send()
    await act(async () => update({ groupMembers: [{ ...members[0]!, name: 'Renamed' }] }))
    expect(hint()?.textContent).toBe('@Renamed')
    await act(async () => update({ groupMembers: [{ ...members[0]!, id: 'same-name-impostor' }] }))
    expect(hint()).toBeNull()
    await act(async () => update({ groupMembers: [] }))
    expect(hint()).toBeNull()
    // Real roster projection excludes removed agents before the shared composer sees them.
    const removed = buildGroupRosterCandidates({ humans: [], agents: [{ id: 'alpha', type: 'agent', account_status: 'removed' }] } as Parameters<typeof buildGroupRosterCandidates>[0], { alpha: { display_name: 'Alpha' } })
    await act(async () => update({ groupMembers: removed }))
    expect(hint()).toBeNull()
    await act(async () => update({ groupMembers: members, surface: 'aside', participantIds: ['beta'] }))
    expect(hint()).toBeNull()
    await act(async () => update({ participantIds: ['alpha'] }))
    expect(hint()?.textContent).toBe('@Alpha')
  })

  it.each([{ isGroupChat: false }, { disabled: true }, { hidden: true }, { whisperTarget: { userId: 'beta', displayName: 'Beta' } }])('does not expose an inactive/private composer hint: %j', async (props) => {
    await mount(); await type('@Alpha hi'); await send()
    await act(async () => update(props))
    expect(hint()).toBeNull()
    expect((await key('ArrowRight')).defaultPrevented).toBe(false)
  })

  it('keeps the last successful target on failure and does not turn a storage error into send rollback', async () => {
    const onSend = await mount()
    await type('@Alpha hi'); await send()
    onSend.mockRejectedValueOnce(new Error('send refused'))
    await type('@Beta fails'); await send()
    expect(readComposer(input())).toContain('@Beta fails')
    await type('')
    expect(hint()?.textContent).toBe('@Alpha')
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('storage unavailable') })
    await type('@Beta succeeds'); await send()
    expect(readComposer(input())).toBe('')
    expect(onSend).toHaveBeenCalledTimes(3)
  })
})
