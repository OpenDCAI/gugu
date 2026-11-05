// @vitest-environment jsdom
import { act } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { BoringAgentAvatar } from '../../../../apps/desktop/src/components/BoringAgentAvatar'
import { BubbleSender } from '../../../../apps/desktop/src/components/chat/MessageBubbleChrome'
import { BODY_COLORS } from '../../../../apps/desktop/src/components/agentAvatar/engine/identity'
import { resolveAgentLook } from '../../../../apps/desktop/src/components/agentAvatar/look'
import { boringAvatarAppearance, boringAvatarNameHue } from '../../../../apps/desktop/src/lib/agentAvatarPalette'
import { hexToOklch } from '../../../../apps/desktop/src/lib/colorOklch'
import { createAvatar } from '../../../../apps/desktop/node_modules/@dicebear/core'
import { notionists } from '../../../../apps/desktop/node_modules/@dicebear/collection'
import * as defaultAvatar from '../../../../apps/desktop/src/lib/dicebearAvatar'
import { dicebearAvatarDataUri } from '../../../../apps/desktop/src/lib/dicebearAvatar'
import { memberNameHue } from '../../../../apps/desktop/src/lib/memberNameHue'
import { installAssistantShellBridge, publishAssistantShell, type AssistantShellSnapshot } from '../../../../apps/desktop/src/lib/assistantShellBridge'
import { installIdentityDirectoryBridge, publishIdentityDirectory } from '../../../../apps/desktop/src/lib/identityDirectoryBridge'
import type { DisplayIdentity } from '../../../../apps/desktop/src/lib/displayIdentity'
import type { MemberProfileCardModel } from '../../../../apps/desktop/src/components/MemberProfileCard'
import { createNode, createReactHarness } from '../../../support/testHarness'

vi.mock('../../../../apps/desktop/src/store/auth', async (importOriginal) => ({
  ...await importOriginal<typeof import('../../../../apps/desktop/src/store/auth')>(),
  useAuth: () => ({ user: null }),
}))
vi.mock('../../../../apps/desktop/src/lib/openMessageSender', () => ({ openMessageSender: vi.fn() }))
vi.mock('react-i18next', async (importOriginal) => ({
  ...await importOriginal<typeof import('react-i18next')>(),
  useTranslation: () => ({ t: (key: string) => key }),
}))

// Reference bodies and hue readings from the approved eight-avatar comparison.
const agents = [
  ['agent-00000000-demo', '#e07a5f', 35.8],
  ['agent-9e3779b1-demo', '#edecb3', 106.9],
  ['agent-3c6ef362-demo', '#118ab2', 228.0],
  ['agent-daa66d13-demo', '#41655c', 176.9],
  ['agent-78dde6c4-demo', '#a33462', 358.7],
  ['agent-b54cda26-demo', '#872ace', 304.8],
  ['agent-8ff34739-demo', '#426086', 254.8],
  ['agent-c17c31a5-demo', '#6b705c', 83.3],
] as const
const upload = 'https://images.example/photo.png'
const savedLook = (color: string) => `https://images.example/agent-look/v1/${color}.webp?rest=shy&wear=`
let harness: ReturnType<typeof createReactHarness>
const hue = () => Number(harness.container.querySelector<HTMLElement>('.msg-sender')?.style.getPropertyValue('--member-hue'))
const sender = (id: string, type: 'agent' | 'human' = 'agent', avatar: string | null = null) => createNode(BubbleSender, {
  senderId: id, member: { type, avatar, displayName: 'Name' } as MemberProfileCardModel,
})
beforeEach(() => {
  harness = createReactHarness()
  installAssistantShellBridge()
  publishAssistantShell({ assistant: null } as AssistantShellSnapshot)
  installIdentityDirectoryBridge()
  publishIdentityDirectory({}, () => {})
})
afterEach(() => {
  vi.restoreAllMocks()
  harness.cleanup()
  publishAssistantShell({ assistant: null } as AssistantShellSnapshot)
  publishIdentityDirectory(null, null)
})

describe('sender-name avatar hue', () => {
  it.each(agents)('matches the rendered beam body for %s', async (id, body, expectedHue) => {
    await harness.render(createNode('div', {}, createNode(BoringAgentAvatar, { id, name: 'Name', size: 32 }), sender(id)))
    expect(harness.container.querySelectorAll('svg g[mask] > rect')[1].getAttribute('fill')).toBe(body)
    expect(boringAvatarAppearance(id).body).toBe(body)
    expect(hue()).toBeCloseTo(expectedHue, 1)
    expect(memberNameHue({ id, isAgent: true })).toBe(hue())
  })

  it('retains the old hue below the neutral-body threshold and uses the body above it', () => {
    const neutral = agents[7][0], coloured = agents[3][0]
    expect(hexToOklch('#6b705c').C).toBeLessThan(0.04)
    expect(hexToOklch('#41655c').C).toBeGreaterThan(0.04)
    expect(boringAvatarNameHue(neutral, 273)).toBe(273)
    expect(boringAvatarNameHue(coloured, 273)).toBeCloseTo(176.9, 1)
    expect(memberNameHue({ id: neutral, avatar: savedLook('sakura'), isAgent: true })).toBe(BODY_COLORS[9].hue)
  })

  it('preserves human-photo and custom-image names instead of guessing image colours', async () => {
    for (const type of ['human', 'agent'] as const) {
      await harness.render(sender(agents[0][0], type, upload))
      expect(hue()).toBe(BODY_COLORS[resolveAgentLook(agents[0][0], upload).color].hue)
    }
  })

  it.each(['human-ui4-a', 'human-ui4-b', 'human-ui4-c', 'human-ui4-d', 'human-ui4-e', 'abc'])('matches the actual DiceBear default background for human %s', async id => {
    const colour = createAvatar(notionists, { seed: id, backgroundColor: ['b6e3f4', 'c0aede', 'd1d4f9', 'ffd5dc', 'ffdfbf'] }).toJson().extra.primaryBackgroundColor
    expect(typeof colour).toBe('string')
    expect(decodeURIComponent(dicebearAvatarDataUri(id))).toContain(String(colour))
    await harness.render(sender(id, 'human'))
    expect(hue()).toBeCloseTo(hexToOklch(String(colour)).h, 8)
  })

  it('retains identity hue for a near-neutral default background and for a grey uploaded avatar', () => {
    const id = 'human-neutral-ui4', identity = BODY_COLORS[resolveAgentLook(id, null).color].hue
    vi.spyOn(defaultAvatar, 'dicebearAvatarMainColor').mockReturnValue('#808080')
    expect(hexToOklch('#808080').C).toBeLessThan(0.04)
    expect(memberNameHue({ id, isAgent: false })).toBe(identity)
    const grey = 'https://images.example/grey.png'
    expect(memberNameHue({ id, avatar: grey, isAgent: false })).toBe(BODY_COLORS[resolveAgentLook(id, grey).color].hue)
    expect(defaultAvatar.dicebearAvatarMainColor).toHaveBeenCalledOnce()
  })

  it('tracks the assistant saved look through the same directory subscription used by its avatar', async () => {
    const id = agents[0][0]
    publishAssistantShell({ assistant: { id } } as AssistantShellSnapshot)
    const publishLook = (color: string) => publishIdentityDirectory({ [id]: { id, type: 'agent', avatar: savedLook(color) } as DisplayIdentity }, () => {})
    publishLook('sakura')
    await harness.render(sender(id))
    expect(hue()).toBe(BODY_COLORS[9].hue)
    await act(async () => publishLook('mint'))
    expect(hue()).toBe(BODY_COLORS[3].hue)
    expect(memberNameHue({ id, avatar: savedLook('sakura'), isAgent: true })).toBeCloseTo(agents[0][2], 1)
  })
})
