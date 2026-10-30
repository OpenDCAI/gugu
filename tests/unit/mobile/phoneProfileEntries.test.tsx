// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { PhoneProfile } from '../../../apps/desktop/src/mobile/assistant/PhoneProfile'
import type { PhonePageProps } from '../../../apps/desktop/src/mobile/assistant/MobileAssistantApp'
import { clickElement, createReactHarness, typeInto } from '../../support/testHarness'

vi.mock('../../../apps/desktop/src/store/contactsContext', () => ({ useContactsStore: () => ({ updateAgentProfile: vi.fn() }) }))
vi.mock('../../../apps/desktop/src/components/settings/channels/useChatChannels', () => ({ useChatChannels: () => ({ status: 'failed', list: null }) }))
const rename = vi.hoisted(() => vi.fn(async () => {}))
vi.mock('../../../apps/desktop/src/store/devicesContext', () => ({ useDevicesStore: () => ({ devices: [{ device_id: 'offline-mac', label: '离线 Mac' }], phones: [], loading: false, error: null, rename }) }))
vi.mock('../../../apps/desktop/src/components/devices/AssistantDevicesPage', () => ({ AssistantDevicesPage: () => <div data-testid="device-content" /> }))
vi.mock('../../../apps/desktop/src/mobile/assistant/usePhoneToday', () => ({ usePhoneToday: () => ({ state: 'ok', data: null }) }))
vi.mock('../../../apps/desktop/src/mobile/assistant/usePhoneProfileData', async original => ({
  ...await original<object>(),
  usePhonePersona: () => ({ persona: { preset: null, rest: '' }, loading: false, error: null, reload: vi.fn() }),
  usePhoneIntegrations: () => ({ data: { items: [], configured: { feishu: true }, statuses: null }, loading: false, error: null, retry: vi.fn() }),
}))
vi.mock('../../../apps/desktop/src/components/assistant/AssistantLibraryVolume', () => ({
  AssistantLibraryCard: ({ kind, onOpen }: { kind: string; onOpen: () => void }) => <button data-testid={`assistant-library-${kind}`} onClick={onOpen}>{kind === 'workspace' ? '项目 3 条记录' : '能力'}</button>,
  AssistantLibraryVolume: ({ kind }: { kind: string }) => <div data-testid={`library-page-${kind}`} />,
}))
vi.mock('../../../apps/desktop/src/components/Avatar', () => ({ Avatar: () => <span /> }))
vi.mock('../../../apps/desktop/src/components/assistant/AssistantNameInline', () => ({ AssistantNameInline: ({ name }: { name: string }) => name }))

let h: ReturnType<typeof createReactHarness>
beforeEach(() => { h = createReactHarness() })
afterEach(() => h.cleanup())
it('shows projects, devices, capabilities and apps in owner order, without expanded resources or diary', async () => {
  const go = vi.fn()
  const props: PhonePageProps = { assistant: { id: 'a', display_name: '咕咕', avatar: null, created_at: null }, chatId: 'dm', ownerName: null,
    homeDeviceId: null, cloudDeviceId: null, home: null, machine: { state: 'opening' }, askInChat: vi.fn(), sub: null, go, open: vi.fn() }
  await h.render(<PhoneProfile {...props} />)
  expect([...h.container.querySelectorAll('h1')].map(title => title.textContent)).toEqual(['资料'])
  const entries = h.container.querySelector('[data-testid="assistant-profile-entries"] .ta-card-list')!
  expect([...entries.children].map(row => row.getAttribute('data-testid'))).toEqual([
    'assistant-library-workspace', 'assistant-library-devices', 'assistant-library-capabilities', 'assistant-open-connectors',
  ])
  expect(entries.textContent).toContain('项目 3 条记录')
  expect(entries.textContent).toContain('连接应用')
  expect(entries.textContent).toContain('设备')
  expect(entries.textContent).toContain('能力')
  expect(h.container.querySelector('[data-testid="assistant-diaries"]')).toBeNull()
  expect(h.container.querySelector('[data-testid="assistant-profile-files-open"]')).toBeNull()
  expect(h.container.querySelector('[data-testid="assistant-capabilities"]')).toBeNull()
  expect(h.container.querySelector('[data-testid="assistant-connectors"]')).toBeNull()
  for (const [id, route] of [['assistant-library-workspace', 'library:workspace'], ['assistant-library-devices', 'devices'], ['assistant-library-capabilities', 'library:capabilities'], ['assistant-open-connectors', 'connectors']]) {
    await clickElement(h.container.querySelector<HTMLElement>(`[data-testid="${id}"]`)!)
    expect(go).toHaveBeenLastCalledWith(route)
  }
  await h.render(<PhoneProfile {...props} sub="library:workspace" />)
  expect(h.container.querySelector('[data-testid="library-page-workspace"]')).not.toBeNull()
})

it.each([['devices', '设备'], ['devices:this-phone', '这台手机'], ['devices:offline-mac', '离线 Mac']])('names the %s page once without an inner back button', async (sub, title) => {
  const props: PhonePageProps = { assistant: { id: 'a', display_name: '咕咕', avatar: null, created_at: null }, chatId: 'dm', ownerName: null,
    homeDeviceId: null, cloudDeviceId: null, home: null, machine: { state: 'opening' }, askInChat: vi.fn(), sub, go: vi.fn(), open: vi.fn() }
  await h.render(<PhoneProfile {...props} />)
  expect([...h.container.querySelectorAll('h1')].map(heading => heading.textContent)).toEqual([title])
  expect(h.container.querySelector('[data-testid="device-content"]')).not.toBeNull()
  // No inner back button; a device's own page carries only the rename entry.
  expect([...h.container.querySelectorAll('button')].map(button => button.dataset.testid)).toEqual(sub === 'devices:offline-mac' ? ['settings-device-actions-rename'] : [])
})

it('renames the opened device from the phone page head through the devices store', async () => {
  const props: PhonePageProps = { assistant: { id: 'a', display_name: '咕咕', avatar: null, created_at: null }, chatId: 'dm', ownerName: null,
    homeDeviceId: null, cloudDeviceId: null, home: null, machine: { state: 'opening' }, askInChat: vi.fn(), sub: 'devices:offline-mac', go: vi.fn(), open: vi.fn() }
  await h.render(<PhoneProfile {...props} />)
  await clickElement(h.container.querySelector<HTMLElement>('[data-testid="settings-device-actions-rename"]')!)
  const input = h.container.querySelector<HTMLInputElement>('[data-testid="device-rename-input"]')!
  expect(input.value).toBe('离线 Mac')
  await typeInto(input, 'juma2')
  await clickElement([...h.container.querySelectorAll<HTMLElement>('button')].find(button => button.textContent === '保存')!)
  expect(rename).toHaveBeenCalledWith('offline-mac', 'juma2')
  expect(h.container.querySelector('[data-testid="device-rename-input"]')).toBeNull()
})
