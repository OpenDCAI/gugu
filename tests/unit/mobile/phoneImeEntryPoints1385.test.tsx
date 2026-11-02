// @vitest-environment jsdom
import { act, useState, type ReactNode } from 'react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { platform } from '../../../apps/desktop/src/platform'
import { usePhoneImeDismiss } from '../../../apps/desktop/src/mobile/usePhoneImeDismiss'
import { ContactSearch } from '../../../apps/desktop/src/components/contacts/ContactSearch'
import { CreateGroupChatForm } from '../../../apps/desktop/src/components/CreateGroupChatModal'
import { InlineNameInput } from '../../../apps/desktop/src/components/ui/InlineNameInput'
import { AssistantNameInline } from '../../../apps/desktop/src/components/assistant/AssistantNameInline'
import { LoginPage } from '../../../apps/desktop/src/pages/LoginPage'
import { authService } from '../../../apps/desktop/src/lib/auth'
import { clickElement, contact, createReactHarness, renderWithAppProviders, typeInto } from '../../support/testHarness'

vi.mock('../../../apps/desktop/src/lib/chat', () => import('../../support/contactsChatServiceTestDouble'))
vi.mock('../../../apps/desktop/src/hooks/useAgentDisplayStatus', () => import('../../support/agentDisplayStatusTestDouble'))
vi.mock('../../../apps/desktop/src/lib/auth', () => ({ authService: { requestLoginOtp: vi.fn(), verifyLoginOtp: vi.fn() } }))
vi.mock('../../../apps/desktop/src/lib/sessionCoordinator', () => ({ sessionCoordinator: { beginInteractiveLogin: vi.fn(), acceptInteractiveSession: vi.fn() } }))
let h: ReturnType<typeof createReactHarness>
const kind = Object.getOwnPropertyDescriptor(platform, 'kind')!
function Owner({ children }: { children: ReactNode }) { usePhoneImeDismiss(); return children }
const providers = { auth: { id: 'owner', email: 'owner@example.com' }, contacts: { contacts: [contact({ id: 'alice', display_name: 'Alice' })] }, chat: { chats: [] } }
const enter = (input: HTMLInputElement) => act(async () => {
  input.focus(); input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }))
  await new Promise(resolve => setTimeout(resolve, 10))
})
beforeEach(() => {
  Object.defineProperty(platform, 'kind', { configurable: true, value: 'capacitor' })
  vi.stubGlobal('matchMedia', (media: string) => ({ media, matches: true, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} }))
  h = createReactHarness()
})
afterEach(() => { h.cleanup(); vi.unstubAllGlobals(); Object.defineProperty(platform, 'kind', kind) })

it('contact search keeps its filtered results and query while dismissing an Enter with no selected result', async () => {
  function Page() {
    const [query, setQuery] = useState('')
    return <ContactSearch query={query} onQuery={setQuery} mobile head={button => <header>{button}</header>}
      people={providers.contacts.contacts} agents={[]} groups={[]} onOpenContact={vi.fn()} onOpenGroup={vi.fn()} onLookupNumber={vi.fn()}><div>Browse</div></ContactSearch>
  }
  await renderWithAppProviders(h, <Owner><Page /></Owner>, { ...providers, shellTab: 'contacts' })
  await clickElement(h.container.querySelector('[data-header-search-open]')!)
  const input = h.container.querySelector<HTMLInputElement>('input')!
  await typeInto(input, 'no such person'); await enter(input)
  expect(document.activeElement).toBe(document.body)
  expect(input.value).toBe('no such person')
  expect(h.container.querySelector('[data-testid=contacts-search-results]')).not.toBeNull()
})
it('group creation still selects a searched member with Enter and creates the selected group', async () => {
  const create = vi.fn().mockResolvedValue('new-group'), created = vi.fn()
  await renderWithAppProviders(h, <Owner><CreateGroupChatForm onClose={vi.fn()} onCreated={created} /></Owner>, { ...providers, chat: { chats: [], createGroupChat: create } })
  const input = h.container.querySelector<HTMLInputElement>('input[type=search]')!
  await typeInto(input, 'Alice'); await enter(input)
  expect(document.activeElement).toBe(document.body)
  expect(h.container.querySelector('[data-contact-option=alice]')?.getAttribute('aria-selected')).toBe('true')
  await clickElement([...h.container.querySelectorAll('button')].find(b => b.textContent?.includes('创建群聊'))!)
  expect(create).toHaveBeenCalledExactlyOnceWith('Alice', ['alice'])
  expect(created).toHaveBeenCalledExactlyOnceWith('new-group')
})
it('a rename commits once when Enter and the shared blur overlap', async () => {
  const commit = vi.fn().mockResolvedValue(undefined)
  function Page() {
    const [open, setOpen] = useState(true)
    return open ? <InlineNameInput name="Old" onCommit={commit} onClose={() => setOpen(false)} /> : <div>Renamed</div>
  }
  await h.render(<Owner><Page /></Owner>)
  const input = h.container.querySelector('input')!
  await typeInto(input, 'New'); await enter(input)
  expect(commit).toHaveBeenCalledExactlyOnceWith('New')
  expect(h.container.textContent).toBe('Renamed')
  expect(document.activeElement).toBe(document.body)
})
it('a refused rename is attempted once, without the IME blur silently retrying it', async () => {
  const commit = vi.fn().mockRejectedValue(new Error('Rename refused'))
  await h.render(<Owner><InlineNameInput name="Old" onCommit={commit} onClose={vi.fn()} /></Owner>)
  const input = h.container.querySelector('input')!
  await typeInto(input, 'New'); await enter(input)
  expect(commit).toHaveBeenCalledOnce()
  expect(input.getAttribute('data-rename-failed')).toBe('true')
})
it('the assistant name also keeps one failed save when Enter dismisses its editor', async () => {
  const commit = vi.fn().mockRejectedValue(new Error('Rename refused'))
  await h.render(<Owner><AssistantNameInline name="Old" onCommit={commit} /></Owner>)
  await clickElement(h.container.querySelector('button')!)
  const input = h.container.querySelector('input')!
  await typeInto(input, 'New'); await enter(input)
  expect(commit).toHaveBeenCalledOnce()
  expect(input.getAttribute('aria-invalid')).toBe('true')
  expect(document.activeElement).toBe(document.body)
})
it.each([
  ['group', { isComposing: true }], ['group', { keyCode: 229 }],
  ['assistant', { isComposing: true }], ['assistant', { keyCode: 229 }],
] as const)('%s rename leaves composition Enter alone (%j)', async (editor, init) => {
  const commit = vi.fn().mockResolvedValue(undefined)
  await h.render(<Owner>{editor === 'group'
    ? <InlineNameInput name="Old" onCommit={commit} onClose={vi.fn()} />
    : <AssistantNameInline name="Old" onCommit={commit} />}</Owner>)
  if (editor === 'assistant') await clickElement(h.container.querySelector('button')!)
  const input = h.container.querySelector('input')!
  await typeInto(input, 'New')
  await act(async () => {
    input.focus()
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true, ...init }))
    await new Promise(resolve => setTimeout(resolve, 10))
  })
  expect(commit).not.toHaveBeenCalled()
  expect(document.activeElement).toBe(input)
})
it('desktop rename Enter keeps the input focused while saving', async () => {
  Object.defineProperty(platform, 'kind', { configurable: true, value: 'electron' })
  const commit = vi.fn(() => new Promise<void>(() => {}))
  await h.render(<Owner><InlineNameInput name="Old" onCommit={commit} onClose={vi.fn()} /></Owner>)
  const input = h.container.querySelector('input')!
  await typeInto(input, 'New'); await enter(input)
  expect(commit).toHaveBeenCalledExactlyOnceWith('New')
  expect(document.activeElement).toBe(input)
})
it('login email and verification-code fields dismiss while their real forms retain submission and validation', async () => {
  vi.mocked(authService.requestLoginOtp).mockResolvedValue({ success: true })
  vi.mocked(authService.verifyLoginOtp).mockResolvedValue({ success: false, error: 'Invalid code' })
  await h.render(<Owner><LoginPage /></Owner>)
  const email = h.container.querySelector<HTMLInputElement>('input[type=email]')!
  await typeInto(email, 'owner@example.com'); await enter(email)
  expect(document.activeElement).toBe(document.body)
  await clickElement(h.container.querySelector('button[type=submit]')!)
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 250)) })
  expect(authService.requestLoginOtp).toHaveBeenCalledExactlyOnceWith('owner@example.com')
  const code = h.container.querySelector<HTMLInputElement>('input[autocomplete=one-time-code]')!
  expect(code).not.toBeNull()
  await typeInto(code, '123456'); await enter(code)
  expect(document.activeElement).toBe(document.body)
  expect(code.value).toBe('123456')
  await clickElement(h.container.querySelector('button[type=submit]')!)
  expect(authService.verifyLoginOtp).toHaveBeenCalledExactlyOnceWith('owner@example.com', '123456')
  expect(h.container.querySelector('[role=alert]')?.textContent).toBe('Invalid code')
})
