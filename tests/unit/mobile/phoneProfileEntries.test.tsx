// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { PhoneProfile } from '../../../apps/desktop/src/mobile/assistant/PhoneProfile'
import type { PhonePageProps } from '../../../apps/desktop/src/mobile/assistant/MobileAssistantApp'
import { clickElement, createReactHarness } from '../../support/testHarness'

vi.mock('../../../apps/desktop/src/store/contactsContext', () => ({ useContactsStore: () => ({ updateAgentProfile: vi.fn() }) }))
vi.mock('../../../apps/desktop/src/store/devicesContext', () => ({ useDevicesStore: () => ({ devices: [], phones: [], loading: false, error: null }) }))
vi.mock('../../../apps/desktop/src/mobile/assistant/usePhoneToday', () => ({ usePhoneToday: () => ({ state: 'ok', data: null }) }))
vi.mock('../../../apps/desktop/src/mobile/assistant/usePhoneProfileData', async original => ({
  ...await original<object>(),
  usePhonePersona: () => ({ persona: { preset: null, rest: '' }, loading: false, error: null, reload: vi.fn() }),
  usePhoneIntegrations: () => ({ data: { items: [], configured: { feishu: true }, statuses: null }, loading: false, error: null, retry: vi.fn() }),
}))
vi.mock('../../../apps/desktop/src/components/assistant/AssistantLibraryVolume', () => ({
  AssistantLibraryCard: ({ onOpen }: { onOpen: () => void }) => <button data-testid="assistant-library-capabilities" onClick={onOpen}>能力</button>,
  AssistantLibraryVolume: () => null,
}))
vi.mock('../../../apps/desktop/src/components/Avatar', () => ({ Avatar: () => <span /> }))
vi.mock('../../../apps/desktop/src/components/assistant/AssistantNameInline', () => ({ AssistantNameInline: ({ name }: { name: string }) => name }))

let h: ReturnType<typeof createReactHarness>
beforeEach(() => { h = createReactHarness() })
afterEach(() => h.cleanup())
it('shows only three resource entries, with no expanded apps, diary, file entry or extra section', async () => {
  const go = vi.fn()
  const props: PhonePageProps = { assistant: { id: 'a', display_name: '咕咕', avatar: null, created_at: null }, chatId: 'dm', ownerName: null,
    homeDeviceId: null, cloudDeviceId: null, home: null, machine: { state: 'opening' }, askInChat: vi.fn(), sub: null, go, open: vi.fn() }
  await h.render(<PhoneProfile {...props} />)
  const entries = h.container.querySelector('[data-testid="assistant-profile-entries"] .ta-card-list')!
  expect(entries.children).toHaveLength(3)
  expect(entries.textContent).toContain('连接应用')
  expect(entries.textContent).toContain('设备')
  expect(entries.textContent).toContain('能力')
  expect(h.container.querySelector('[data-testid="assistant-diaries"]')).toBeNull()
  expect(h.container.querySelector('[data-testid="assistant-profile-files-open"]')).toBeNull()
  expect(h.container.querySelector('[data-testid="assistant-capabilities"]')).toBeNull()
  expect(h.container.querySelector('[data-testid="assistant-connectors"]')).toBeNull()
  for (const [id, route] of [['assistant-open-connectors', 'connectors'], ['assistant-library-devices', 'devices'], ['assistant-library-capabilities', 'library:capabilities']]) {
    await clickElement(h.container.querySelector<HTMLElement>(`[data-testid="${id}"]`)!)
    expect(go).toHaveBeenLastCalledWith(route)
  }
})
