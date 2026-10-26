// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ExtPanel } from '../../../../apps/desktop/src/components/agentsettings/AgentSharePane'
import { GroupInviteLinkBlock } from '../../../../apps/desktop/src/components/chat/groupSettingsUi'
import { GroupInviteQrShare } from '../../../../apps/desktop/src/components/contacts/GroupInvite'
import { MessageLoadFailure } from '../../../../apps/desktop/src/components/chat/MessageLoadFailure'
import { platform } from '../../../../apps/desktop/src/platform'
import { clickElement, contact, createNode, createReactHarness, renderWithAppProviders, waitForCondition } from '../../../support/testHarness'

vi.mock('qrcode', () => ({ toDataURL: async () => 'data:image/png;base64,cG5n', default: { toDataURL: async () => 'data:image/png;base64,cG5n' } }))
vi.mock('../../../../apps/desktop/src/lib/chat', () => ({ chatService: { getGroupChatSettings: async () => ({ join_token: 'test-invite' }) } }))
let harness: ReturnType<typeof createReactHarness>
const error = new Error('Clipboard denied /Users/test/private sk-synthetic-secret\nstack detail')
const reason = 'Clipboard denied [path] [redacted token]'
const writeText = vi.fn()
beforeEach(() => {
  harness = createReactHarness()
  writeText.mockReset().mockRejectedValue(error)
  vi.stubGlobal('navigator', { clipboard: { writeText } })
})
afterEach(() => { harness.cleanup(); vi.unstubAllGlobals(); vi.unstubAllEnvs() })

describe('copy actions preserve the refusal', () => {
  it('shows the cause beside the external agent link', async () => {
    vi.stubEnv('VITE_GUGU_WEB_URL', 'https://share.example.test')
    await renderWithAppProviders(harness, createNode(ExtPanel, { agent: contact({ id: 'agent', type: 'agent', agent_public: true }) }))
    await clickElement(harness.container.querySelector('[data-testid="agent-share-link"] + button')!)
    expect(writeText).toHaveBeenCalledWith('https://share.example.test/join/agent/agent')
    expect(harness.container.textContent).toContain(reason)
  })
  it('shows the cause when copying a group management link', async () => {
    const toast = vi.fn()
    await renderWithAppProviders(harness, createNode(GroupInviteLinkBlock, { inviteLink: 'https://share.example.test/group', onOpenPoster: () => {} }), { toast })
    await clickElement(harness.container.querySelector('button')!)
    expect(toast).toHaveBeenCalledWith('复制失败', 'error', reason)
  })
  it('shows the cause when copying a group QR link', async () => {
    const toast = vi.fn()
    await renderWithAppProviders(harness, createNode(GroupInviteQrShare, { group: { id: 'group', public_id: 123, kind: 'group', name: 'Group', avatar_url: null, member_count: 1, is_muted: false } }), { toast })
    await waitForCondition(() => harness.container.querySelector('[data-testid="group-invite-link-copy-button"]') !== null, 'invite link was never ready')
    await clickElement(harness.container.querySelector('[data-testid="group-invite-link-copy-button"]')!)
    expect(toast).toHaveBeenCalledWith('复制失败，请手动复制链接', 'error', reason)
  })
  it('shows the clipboard refusal when copying message-load details', async () => {
    const toast = vi.fn()
    vi.spyOn(platform, 'writeClipboardText').mockRejectedValue(error)
    await renderWithAppProviders(harness, createNode(MessageLoadFailure, { error: new Error('history unavailable'), onRetry: async () => {}, inline: false }), { toast })
    await clickElement(harness.container.querySelector('[data-testid="chat-load-details-toggle"]')!)
    await clickElement(harness.container.querySelector('[data-testid="chat-load-details-copy"]')!)
    expect(toast).toHaveBeenCalledWith('复制失败', 'error', reason)
  })
})
