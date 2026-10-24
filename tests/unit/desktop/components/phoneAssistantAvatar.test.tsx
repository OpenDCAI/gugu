// @vitest-environment jsdom
import { act, createElement } from 'react'
import { afterEach, describe, expect, it } from 'vitest'
import { createReactHarness } from '../../../support/testHarness'
import { Avatar } from '../../../../apps/desktop/src/components/Avatar'
import { displayAvatarUrl } from '../../../../apps/desktop/src/lib/dicebearAvatar'
import { publishPhoneAssistant } from '../../../../apps/desktop/src/mobile/assistant/phoneAssistantIdentity'

const id = 'phone-assistant'
const avatar = 'https://example.test/storage/v1/object/public/avatars/agent-look/v1/cream.webp'
afterEach(() => { publishPhoneAssistant(null) })

describe('phone assistant avatar identity', () => {
  it('replaces an ordinary default with the assistant figure when the existing phone store recognizes it', async () => {
    const h = createReactHarness()
    try {
      await h.render(createElement(Avatar, { seed: id, name: 'Assistant', isAgent: true, avatarUrl: avatar, still: true }))
      expect(h.container.querySelector('[data-agent-avatar-boring]')).not.toBeNull()
      await act(async () => { publishPhoneAssistant({ id, name: 'Assistant' }) })
      expect(h.container.querySelector('[data-agent-avatar-boring]')).toBeNull()
      expect(h.container.querySelector('[data-agent-avatar-still]')).not.toBeNull()
      expect(displayAvatarUrl(avatar, id, 'phone review', 'agent')).not.toContain('data:image/svg+xml')
      expect(displayAvatarUrl(null, 'ordinary-agent', 'phone review', 'agent')).toContain('data:image/svg+xml')
    } finally { h.cleanup() }
  })
})
