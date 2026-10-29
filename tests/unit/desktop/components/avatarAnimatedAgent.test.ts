// @vitest-environment jsdom
import { act } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Avatar } from '../../../../apps/desktop/src/components/Avatar'
import { AGENT_AVATAR_PALETTES, agentAvatarPalette, boringFaceFeatureColor, boringLookUrl, parseBoringLook } from '../../../../apps/desktop/src/lib/agentAvatarPalette'
import { boringAgentAvatarDataUri } from '../../../../apps/desktop/src/lib/boringAgentAvatar'
import { SessionAvatar } from '../../../../apps/desktop/src/mobile/agent-watch/StatusGlyph'
import { runtime } from '../../../../apps/desktop/src/components/agentAvatar/engine/runtime'
import { installIdentityDirectoryBridge, publishIdentityDirectory } from '../../../../apps/desktop/src/lib/identityDirectoryBridge'
import { installAssistantShellBridge, publishAssistantShell, type AssistantShellSnapshot } from '../../../../apps/desktop/src/lib/assistantShellBridge'
import type { DisplayIdentity } from '../../../../apps/desktop/src/lib/displayIdentity'
import { presentAgentStatus } from '@gugu/core/shared/agentStatusPresentation'
import { createNode, createReactHarness } from '../../../support/testHarness'

const UPLOAD = 'https://db.example/storage/v1/object/public/avatars/a.png'
const LOOK = 'https://db.example/storage/v1/object/public/avatars/agent-look/v1/sakura.webp?rest=shy'
const ID = '7d1e2f30-4a5b-4c6d-8e9f-0a1b2c3d4e5f'
let harness: ReturnType<typeof createReactHarness>
const identity = (type: 'human' | 'agent') => ({ id: ID, type, avatar: null } as DisplayIdentity)
const assistant = (id: string | null) => publishAssistantShell({ assistant: id ? { id, display_name: 'Assistant', avatar: LOOK } : null } as AssistantShellSnapshot)
const svg = () => harness.container.querySelector<SVGElement>('svg[data-agent-avatar-boring]')
// React creates unique mask ids for each mounted SVG. Compare the face, independently of those document ids.
const geometry = () => svg()?.innerHTML.replace(/id="[^"]+"|url\(#[^)]+\)/g, '')
const render = (props: Record<string, unknown> = {}) => harness.render(createNode(Avatar, {
  name: 'Agent', seed: ID, size: 32, isAgent: true, harnessBadge: false, ...props,
}))
beforeEach(() => {
  harness = createReactHarness()
  installIdentityDirectoryBridge()
  publishIdentityDirectory({}, () => {})
  installAssistantShellBridge()
  assistant(null)
  vi.spyOn(runtime, 'register').mockImplementation(() => ({
    engine: { crop: 'full', gain: 1, rotate: true, setState() {}, setExpression() {}, setBodyColor() {}, poke() {}, hop() {} },
    outfit: { set() {} }, opts: {},
  }) as never)
})
afterEach(() => {
  harness.cleanup()
  publishIdentityDirectory(null, null)
  assistant(null)
  vi.restoreAllMocks()
})

describe('default agent avatars', () => {
  it('renders a static beam SVG with the full agent id and its palette, plus the existing status badge', async () => {
    await render({ agentStatus: 'working' })
    expect(svg()?.getAttribute('data-agent-avatar-boring')).toBe(ID)
    expect(svg()?.getAttribute('width')).toBe('32')
    expect(harness.container.querySelector('canvas')).toBeNull()
    expect(harness.container.querySelector('.av-status--working')).not.toBeNull()
    const fills = Array.from(svg()!.querySelectorAll('[fill]')).map((el) => el.getAttribute('fill'))
    expect(fills.some((fill) => agentAvatarPalette(ID).includes(fill!))).toBe(true)
    expect(runtime.register).not.toHaveBeenCalled()
  })

  it('spreads ids over the curated palettes and keeps image-only projections on the same palette', () => {
    const used = new Set(Array.from({ length: 400 }, (_, i) => agentAvatarPalette(`${ID}-${i}`)))
    expect(used.size).toBe(AGENT_AVATAR_PALETTES.length)
    const svgText = decodeURIComponent(boringAgentAvatarDataUri(ID))
    expect(agentAvatarPalette(ID).some((color) => svgText.includes(`fill="${color}"`))).toBe(true)
  })

  it('draws the owner\'s pick from its stored address, in the live SVG and the image-only projection alike', async () => {
    const PICK = boringLookUrl('https://db.example/storage/v1/object/public/avatars/agent-look/v1/boring', { palette: 7, seed: 'a1b2c3d4' })
    expect(parseBoringLook(PICK)).toEqual({ palette: 7, seed: 'a1b2c3d4' })
    for (const other of [LOOK, UPLOAD, PICK.replace('p=7', 'p=99'), PICK.replace('boring', 'sakura.webp')]) expect(parseBoringLook(other)).toBeNull()
    await render()
    const face = geometry()
    await render({ avatarUrl: PICK })
    expect(geometry()).not.toBe(face)
    expect(svg()?.getAttribute('data-agent-avatar-boring')).toBe(ID)
    const fills = Array.from(svg()!.querySelectorAll('[fill]')).map((el) => el.getAttribute('fill'))
    expect(fills.some((fill) => AGENT_AVATAR_PALETTES[7].includes(fill!))).toBe(true)
    const svgText = decodeURIComponent(boringAgentAvatarDataUri(ID, PICK))
    expect(svgText).toContain(`fill="${fills.find((fill) => AGENT_AVATAR_PALETTES[7].includes(fill!))}"`)
    expect(decodeURIComponent(boringAgentAvatarDataUri(ID, PICK))).not.toBe(decodeURIComponent(boringAgentAvatarDataUri(ID)))
  })

  it('draws light features once white reaches 3:1 on the body, dark ones otherwise', async () => {
    // Mid-dark reds, corals and purples took black features under beam's own YIQ test.
    for (const body of ['#e76f51', '#ff4d6d', '#7678ed', '#b08968', '#3d5e92']) expect(boringFaceFeatureColor(body)).toBe('#FFFFFF')
    for (const body of ['#ff9915', '#fad928', '#edecb3', '#80ffdb', '#38b000']) expect(boringFaceFeatureColor(body)).toBe('#000000')
    await render({ avatarUrl: boringLookUrl('https://db.example/storage/v1/object/public/avatars/agent-look/v1/boring', { palette: 1, seed: 'a1b2c3d4' }) })
    const rects = svg()!.querySelectorAll('g[mask] > rect')
    const face = svg()!.querySelector('g[mask] > g rect')!.getAttribute('fill')
    expect(face).toBe(boringFaceFeatureColor(rects[1].getAttribute('fill')!))
  })

  it('keeps every palette colour within the first palette\'s contrast bounds on the dark page and on white', () => {
    const channel = (v: number) => (v /= 255) <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4
    const luminance = (hex: string) => [1, 3, 5].map((i) => channel(parseInt(hex.slice(i, i + 2), 16)))
      .reduce((sum, v, i) => sum + v * [0.2126, 0.7152, 0.0722][i], 0)
    const contrast = (a: string, b: string) => {
      const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x)
      return (hi + 0.05) / (lo + 0.05)
    }
    const floor = (surface: string) => Math.min(...AGENT_AVATAR_PALETTES[0].map((c) => contrast(c, surface)))
    for (const surface of ['#121212', '#ffffff']) {
      for (const color of AGENT_AVATAR_PALETTES.flat()) expect(contrast(color, surface)).toBeGreaterThanOrEqual(floor(surface))
    }
  })

  it('keeps the same face across renames, sizes and built-in v1 URLs, including older or unknown looks', async () => {
    await render()
    const face = geometry()
    for (const avatarUrl of [LOOK, LOOK.split('?')[0], LOOK.replace('sakura', 'future')]) {
      await render({ name: 'Renamed', size: 96, avatarUrl, still: true })
      expect(geometry()).toBe(face)
      expect(harness.container.querySelector('img')).toBeNull()
    }
  })

  it('different full ids generate different faces', async () => {
    await render()
    const face = geometry()
    await render({ seed: `${ID}-other` })
    expect(geometry()).not.toBe(face)
  })

  it('keeps custom images and their failure state; never conceals a broken upload with Boring', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    await render({ avatarUrl: UPLOAD })
    expect(harness.container.querySelector('img')?.getAttribute('src')).toBe(UPLOAD)
    expect(svg()).toBeNull()
    await act(async () => { harness.container.querySelector('img')!.dispatchEvent(new Event('error')) })
    expect(harness.container.querySelector('[data-avatar-error]')).not.toBeNull()
    expect(svg()).toBeNull()
  })

  it('keeps human defaults and uploads unchanged', async () => {
    await render({ isAgent: false })
    expect(harness.container.querySelector('img')?.getAttribute('src')).toMatch(/^data:image\/svg\+xml/)
    expect(svg()).toBeNull()
    await render({ isAgent: false, avatarUrl: UPLOAD })
    expect(harness.container.querySelector('img')?.getAttribute('src')).toBe(UPLOAD)
  })

  it('waits for a missing identity type using the existing directory ensure path', async () => {
    const ensure = vi.fn()
    publishIdentityDirectory({}, ensure)
    await render({ isAgent: undefined })
    expect(harness.container.querySelector('[data-avatar-empty]')).not.toBeNull()
    expect(svg()).toBeNull()
    expect(ensure).toHaveBeenCalledWith([ID])
    await act(async () => publishIdentityDirectory({ [ID]: identity('agent') }, ensure))
    expect(svg()).not.toBeNull()
  })

  it('leaves missing keys and malformed explicit URLs in the diagnostic state', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    await render({ seed: '' })
    expect(harness.container.querySelector('[data-avatar-empty]')).not.toBeNull()
    await render({ avatarUrl: 'undefined' })
    expect(harness.container.querySelector('[data-avatar-error]')).not.toBeNull()
    expect(svg()).toBeNull()
  })

  it('preserves the assistant 3D figure, exact state, still posters and uploaded images', async () => {
    assistant(ID)
    await render({ avatarUrl: LOOK, agentStatus: 'needs_user', statusLabel: 'needsApproval', hoverPoke: true })
    expect(harness.container.querySelector('canvas[data-agent-avatar]')?.getAttribute('data-agent-avatar-state')).toBe('needsApproval')
    expect(harness.container.querySelector('canvas')?.getAttribute('data-agent-avatar-color')).toBe('sakura')
    expect(svg()).toBeNull()
    expect(harness.container.querySelector('.av-status')).toBeNull()
    await render({ avatarUrl: LOOK, still: true })
    expect(harness.container.querySelector('[data-agent-avatar-still="sakura"]')).not.toBeNull()
    expect(harness.container.querySelector('canvas')).toBeNull()
    await render({ avatarUrl: UPLOAD })
    expect(harness.container.querySelector('img')?.getAttribute('src')).toBe(UPLOAD)
  })

  it('composites use the directory type, showing Boring only for agents and waiting for unknown members', async () => {
    const ensure = vi.fn()
    publishIdentityDirectory({}, ensure)
    const member = { id: ID, name: 'Member', avatar: LOOK }
    await render({ variant: 'group', memberAvatars: [member] })
    expect(svg()).toBeNull()
    expect(harness.container.querySelector('[data-avatar-empty]')).not.toBeNull()
    expect(ensure).toHaveBeenCalledWith([ID])
    await act(async () => publishIdentityDirectory({ [ID]: identity('agent') }, ensure))
    expect(svg()).not.toBeNull()
    await act(async () => publishIdentityDirectory({ [ID]: identity('human') }, ensure))
    expect(svg()).toBeNull()
    expect(harness.container.querySelector('img')).not.toBeNull()
  })

  it('phone rows use the same canonical id and upload, while an unavailable status stays unavailable', async () => {
    await render()
    const face = geometry()
    await harness.render(createNode(SessionAvatar, { agentId: ID, sessionId: 'task-1', presentation: null }))
    expect(geometry()).toBe(face)
    expect(harness.container.querySelector('.av-status')).toBeNull()
    await act(async () => publishIdentityDirectory({ [ID]: { ...identity('agent'), avatar: UPLOAD } }, () => {}))
    expect(harness.container.querySelector('img')?.getAttribute('src')).toBe(UPLOAD)
    await harness.render(createNode(SessionAvatar, { sessionId: 'task-2', presentation: presentAgentStatus({ reading: { status: 'error', detail: null } }) }))
    expect(svg()?.getAttribute('data-agent-avatar-boring')).toBe('task-2')
    expect(harness.container.querySelector('.av-status')).not.toBeNull()
  })
})
