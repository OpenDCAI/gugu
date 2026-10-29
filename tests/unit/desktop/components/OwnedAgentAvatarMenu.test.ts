// @vitest-environment jsdom
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { OwnedAgentAvatarMenu } from '../../../../apps/desktop/src/components/contacts/OwnedAgentAvatarMenu'
import { agentAvatarPaletteIndex, boringLookUrl, parseBoringLook } from '../../../../apps/desktop/src/lib/agentAvatarPalette'

const BASE = 'https://db.example/storage/v1/object/public/avatars/agent-look/v1/boring'
const { updateAgentProfile, toast, viewer } = vi.hoisted(() => ({ updateAgentProfile: vi.fn(), toast: vi.fn(), viewer: { id: 'owner' } }))
vi.mock('../../../../apps/desktop/src/store/auth', () => ({ useAuth: () => ({ user: viewer }) }))
vi.mock('../../../../apps/desktop/src/store/contactsContext', () => ({ useContactsStore: () => ({ updateAgentProfile }) }))
vi.mock('../../../../apps/desktop/src/components/toastContext', () => ({ useToast: () => ({ toast }) }))
vi.mock('../../../../apps/desktop/src/lib/avatarIdentity', () => ({ useIsAssistantAvatar: () => false }))
vi.mock('../../../../apps/desktop/src/lib/contacts', () => ({ contactsService: { boringLookAvatarUrl: (look: Parameters<typeof boringLookUrl>[1]) => boringLookUrl(BASE, look) } }))

const ID = '7d1e2f30-4a5b-4c6d-8e9f-0a1b2c3d4e5f'
let container: HTMLDivElement
let root: Root
function render(overrides: Partial<Parameters<typeof OwnedAgentAvatarMenu>[0]> = {}) {
  act(() => root.render(createElement(OwnedAgentAvatarMenu, { agentId: ID, avatar: null, ownerUserId: 'owner', children: 'face', ...overrides })))
}
const byLabel = (label: string) => document.body.querySelector<HTMLElement>(`[aria-label="${label}"]`)
const byTestId = (id: string) => document.body.querySelector<HTMLElement>(`[data-testid="${id}"]`)
async function choose(element: HTMLElement | null) {
  if (!element) throw new Error('missing control')
  await act(async () => element.click())
}
const saved = () => updateAgentProfile.mock.calls.at(-1)?.[1].avatar as string | null

beforeEach(() => {
  updateAgentProfile.mockReset().mockResolvedValue(undefined)
  toast.mockReset()
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})
afterEach(() => { act(() => root.unmount()); container.remove() })

describe('owner avatar menu', () => {
  it.each([{ ownerUserId: 'other' }, { ownerUserId: null }, { status: 'removed' as const }, { avatar: 'https://db.example/storage/v1/object/public/avatars/a.png' }])(
    'leaves non-owned, removed and uploaded-photo avatars as plain images: %j', (props) => {
      render(props)
      expect(container.querySelector('button')).toBeNull()
      expect(container.textContent).toBe('face')
    })

  it('picks a palette keeping the shape, rolls a new shape keeping the palette, and resets to the id default', async () => {
    render()
    await choose(byLabel('换头像'))
    const swatches = byTestId('agent-avatar-palettes')!.querySelectorAll('button')
    expect(swatches).toHaveLength(20)
    expect(swatches[agentAvatarPaletteIndex(ID)].getAttribute('aria-checked')).toBe('true')
    await choose(byLabel('配色 3'))
    expect(updateAgentProfile).toHaveBeenCalledWith(ID, { avatar: `${BASE}?p=2` })
    expect(parseBoringLook(saved())).toEqual({ palette: 2, seed: null })

    render({ avatar: `${BASE}?p=2` })
    await choose(byLabel('换头像'))
    await choose(byTestId('agent-avatar-roll'))
    const rolled = parseBoringLook(saved())
    expect(rolled?.palette).toBe(2)
    expect(rolled?.seed).toMatch(/^[0-9a-f]{8}$/)

    render({ avatar: saved() })
    await choose(byLabel('换头像'))
    await choose(byTestId('agent-avatar-reset'))
    expect(updateAgentProfile).toHaveBeenLastCalledWith(ID, { avatar: null })
  })

  it('reports a failed save and keeps the menu open for another try', async () => {
    updateAgentProfile.mockRejectedValueOnce(new Error('offline'))
    render()
    await choose(byLabel('换头像'))
    await choose(byLabel('配色 1'))
    expect(toast).toHaveBeenCalledWith('头像没有换成', 'error', expect.any(String))
    expect(byTestId('agent-avatar-palettes')).not.toBeNull()
  })
})
