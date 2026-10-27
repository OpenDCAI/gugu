// @vitest-environment jsdom
import { act } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { CreateGroupChatForm } from '../../../../apps/desktop/src/components/CreateGroupChatModal'
import { MemberPicker } from '../../../../apps/desktop/src/components/member-picker/MemberPicker'
import {phoneTaskDirectoryRequested} from '../../../../apps/desktop/src/session/shared/remote-sessions/session-directory'
import { clickElement, contact, createNode, createReactHarness, renderWithAppProviders, typeInto } from '../../../support/testHarness'
vi.mock('../../../../apps/desktop/src/lib/chat', () => import('../../../support/contactsChatServiceTestDouble'))
vi.mock('../../../../apps/desktop/src/hooks/useAgentDisplayStatus', () => import('../../../support/agentDisplayStatusTestDouble'))

let harness: ReturnType<typeof createReactHarness>
beforeEach(() => { harness = createReactHarness() })
afterEach(() => { harness.cleanup() })

const providers = {
  auth: { id: 'owner-1', email: 'owner@example.com', nickname: 'Owner' },
  contacts: { contacts: [
    contact({ id: 'helper', display_name: 'Helper', type: 'agent', owner_user_id: 'owner-1' }),
    contact({ id: 'bob', display_name: 'Bob' }),
    contact({ id: 'alice', display_name: 'Alice' }),
  ] },
  chat: { chats: [] },
}
const q = <T extends Element = HTMLElement>(selector: string) => harness.container.querySelector<T & HTMLElement>(selector)
const rows = () => [...harness.container.querySelectorAll<HTMLElement>('[role="option"]')].map((row) => row.dataset.contactOption)
const chips = () => [...harness.container.querySelectorAll('button[aria-label^="移除 "]')].map((chip) => chip.getAttribute('aria-label')!.slice(3))
const search = () => q<HTMLInputElement>('input[type="search"]')!
const key = (target: Element, k: string) => act(async () => { target.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true })) })
const confirmText = () => [...harness.container.querySelectorAll('button')].find((b) => /创建群聊/.test(b.textContent ?? ''))?.textContent

describe('member picker', () => {
  it('retains the phone summary reader while selecting members without requiring an assistant task pane',async()=>{
    expect(phoneTaskDirectoryRequested()).toBe(false)
    await renderWithAppProviders(harness,createNode(MemberPicker,{title:'Add',confirmLabel:(n:number)=>`Add ${n}`,onConfirm:()=>{},onClose:()=>{}}),providers)
    expect(phoneTaskDirectoryRequested()).toBe(true)
    harness.cleanup()
    expect(phoneTaskDirectoryRequested()).toBe(false)
  })
  it('lists sources on the side, people before devices, and opens on the first one with anyone in it', async () => {
    await renderWithAppProviders(harness, createNode(CreateGroupChatForm, { onClose: () => {}, onCreated: () => {} }), providers)
    expect([...harness.container.querySelectorAll<HTMLElement>('[data-picker-source]')].map((s) => s.dataset.pickerSource)).toEqual(['recent', 'people', 'unknown'])
    expect(rows()).toEqual(['alice', 'bob']) // nobody talked to in the last 7 days ⇒ opens on people, A–Z
  })

  it('keeps what was picked while switching sources, and counts members rather than people', async () => {
    await renderWithAppProviders(harness, createNode(CreateGroupChatForm, { onClose: () => {}, onCreated: () => {} }), providers)
    await clickElement(q('[data-contact-option="alice"]')!)
    await clickElement(q('[data-picker-source="unknown"]')!)
    expect(rows()).toEqual(['helper'])
    await clickElement(q('[data-contact-option="helper"]')!)
    expect(chips()).toEqual(['Alice', 'Helper'])
    expect(confirmText()).toBe('创建群聊 · 2 位成员')
  })

  it('works from the keyboard: search + Enter picks and clears, Space toggles a focused row, Backspace drops the last pick', async () => {
    await renderWithAppProviders(harness, createNode(CreateGroupChatForm, { onClose: () => {}, onCreated: () => {} }), providers)
    await typeInto(search(), 'help')
    expect(rows()).toEqual(['helper']) // search reaches every source
    await key(search(), 'Enter')
    expect(search().value).toBe('')
    expect(chips()).toEqual(['Helper'])
    await key(q('[data-contact-option="alice"]')!, ' ')
    expect(chips()).toEqual(['Helper', 'Alice'])
    await key(search(), 'Backspace')
    expect(chips()).toEqual(['Helper'])
  })

  it('shows members already in the group as picked and fixed', async () => {
    const confirm = vi.fn()
    await renderWithAppProviders(harness, createNode(MemberPicker, { title: 'Add', confirmLabel: (n: number) => `Add ${n}`, onConfirm: confirm, onClose: () => {}, lockedIds: new Set(['alice']) }), providers)
    const alice = q('[data-contact-option="alice"]')!
    expect(alice.getAttribute('aria-selected')).toBe('true')
    expect(alice.getAttribute('aria-disabled')).toBe('true')
    await clickElement(alice)
    expect(alice.getAttribute('aria-selected')).toBe('true')
    expect(chips()).toEqual([])
  })
})
