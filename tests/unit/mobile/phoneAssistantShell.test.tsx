// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { createReactHarness, clickElement } from '../../support/testHarness'

const state = vi.hoisted(() => ({ transition: vi.fn((update: () => void) => update()) }))
vi.mock('../../../apps/desktop/src/mobile/navigateMobile', () => ({ navigateMobile: state.transition }))
vi.mock('react-i18next', async original => ({ ...await original<object>(), useTranslation: () => ({ t: (key: string) => key }) }))
vi.mock('../../../apps/desktop/src/store/auth', () => ({ useAuth: () => ({ user: null }) }))
vi.mock('../../../apps/desktop/src/store/chatContext', () => ({ useChatStore: () => ({ setDraft: vi.fn(), draftAttachments: {}, setDraftAttachments: vi.fn() }) }))
vi.mock('../../../apps/desktop/src/store/chatLineScope', () => ({ ChatLineScope: ({ children }: { children: React.ReactNode }) => children }))
vi.mock('../../../apps/desktop/src/components/assistant/AssistantConversationProgress', () => ({ AssistantConversationProgress: ({ children }: { children: React.ReactNode }) => children }))
vi.mock('../../../apps/desktop/src/components/assistant/AssistantComposerEntries', () => ({ AssistantComposerEntries: () => null }))
vi.mock('../../../apps/desktop/src/components/assistant/useAssistantTyping', () => ({ useAssistantTyping: () => null }))
vi.mock('../../../apps/desktop/src/components/ChatAreaPanel', () => ({ ChatAreaPanel: () => <div data-testid="retained-chat"><input defaultValue="draft" /></div> }))
vi.mock('../../../apps/desktop/src/components/chat/filePreviewHost', () => ({ FilePreviewHost: { Provider: ({ children }: { children: React.ReactNode }) => children } }))
vi.mock('../../../apps/desktop/src/lib/onScreenChat', () => ({ useReportChatOnScreen: (id: string | null) => id }))
vi.mock('../../../apps/desktop/src/lib/assistantSetupState', () => ({ useCustomizeCardOffered: () => false }))
vi.mock('../../../apps/desktop/src/lib/assistantTaskChat', () => ({ useOpenedAssistantTaskChat: () => null, showAssistantTaskChat: vi.fn() }))
vi.mock('../../../apps/desktop/src/components/ui/sheetStack', () => ({ useBackLayer: () => {} }))
vi.mock('../../../apps/desktop/src/components/Avatar', () => ({ Avatar: () => <span>avatar</span> }))
vi.mock('../../../apps/desktop/src/mobile/assistant/phoneMachine', () => ({ usePhoneMachine: () => ({ state: 'opening' }) }))
vi.mock('../../../apps/desktop/src/mobile/assistant/phoneVoiceRuntime', () => ({ usePhoneVoiceNotes: () => ({ disabled: true, start: vi.fn() }) }))
vi.mock('../../../apps/desktop/src/mobile/assistant/PhoneVoiceBar', () => ({ PhoneVoiceBar: () => null }))
vi.mock('../../../apps/desktop/src/mobile/assistant/PhoneIdeas', () => ({ PhoneIdeas: () => null }))
vi.mock('../../../apps/desktop/src/mobile/assistant/PhoneToday', () => ({ PhoneToday: () => <div>today content</div> }))
vi.mock('../../../apps/desktop/src/mobile/assistant/PhoneTasks', () => ({ PhoneTasks: () => <div>tasks content</div> }))
vi.mock('../../../apps/desktop/src/mobile/assistant/PhoneMemory', () => ({ PhoneMemory: () => <div>memory content</div> }))
vi.mock('../../../apps/desktop/src/mobile/assistant/PhoneProfile', () => ({ PhoneProfile: ({ go }: { go: (sub: string) => void }) => <button data-testid="open-devices" onClick={() => go('devices')}>devices</button> }))
vi.mock('../../../apps/desktop/src/session/renderer/features/assistant/assistant-shell', () => ({ ShellSlot: () => null }))

import { UI_EVENTS } from '../../../apps/desktop/src/lib/uiEvents'
import { MobileAssistantApp } from '../../../apps/desktop/src/mobile/assistant/MobileAssistantApp'

let h: ReturnType<typeof createReactHarness>
const find = (id: string) => h.container.querySelector<HTMLElement>(`[data-testid="${id}"]`)!
beforeEach(() => { h = createReactHarness(); state.transition.mockClear() })
afterEach(() => h.cleanup())
const props = { chatId: 'dm', assistant: { id: 'a', display_name: '咕咕', avatar: null, created_at: null }, ownerName: null,
  homeDeviceId: null, cloudDeviceId: null, home: null, visible: true, chatRequest: 0, onExit: vi.fn() }

it('changes internal pages without transitioning or replacing the shared header, search lane, or chat', async () => {
  await h.render(<MobileAssistantApp {...props} />)
  const header = find('mobile-assistant-header')
  const chat = find('retained-chat')
  const input = chat.querySelector('input')!
  const search = find('mobile-assistant-search') as HTMLButtonElement
  const lane = search.parentElement
  input.value = 'unsent draft'
  for (const tab of ['today', 'tasks', 'memory', 'chat']) {
    await clickElement(find(`mobile-assistant-tab-${tab}`))
    expect(find('mobile-assistant-header')).toBe(header)
    expect(h.container.querySelectorAll('[data-slot="pane-header"]')).toHaveLength(1)
    expect(find('retained-chat')).toBe(chat)
    expect(input.value).toBe('unsent draft')
    expect(find('mobile-assistant-search')).toBe(search)
    expect(search.parentElement).toBe(lane)
    expect(search.hidden).toBe(tab !== 'chat')
    expect(find(`mobile-assistant-tab-${tab}`).getAttribute('aria-selected')).toBe('true')
  }
  expect(state.transition).not.toHaveBeenCalled()
})

it('keeps profile subpages inside the same header and restores the search action on return to chat', async () => {
  await h.render(<MobileAssistantApp {...props} />)
  const header = find('mobile-assistant-header')
  const received = vi.fn()
  window.addEventListener(UI_EVENTS.openChatSearch, received)
  await clickElement(find('mobile-assistant-pill'))
  await clickElement(find('open-devices'))
  expect(find('mobile-assistant-app').getAttribute('data-sub')).toBe('devices')
  expect(find('mobile-assistant-header')).toBe(header)
  expect(find('mobile-assistant-back')).not.toBeNull()
  await clickElement(find('mobile-assistant-tab-chat'))
  expect((find('mobile-assistant-search') as HTMLButtonElement).hidden).toBe(false)
  await clickElement(find('mobile-assistant-search'))
  expect(received).toHaveBeenCalledTimes(1)
  expect((received.mock.calls[0][0] as CustomEvent).detail).toEqual({ chatId: 'dm', viewportKey: 'assistant' })
  expect(state.transition).not.toHaveBeenCalled()
  window.removeEventListener(UI_EVENTS.openChatSearch, received)
})
