import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { page, userEvent } from 'vitest/browser'
import { ChatComposer, MessageProvider } from '@gugu/session-ui/react/components'
import { ChatMessageComposer } from '@/components/chat/ChatMessageComposer'
import { createLocalSessionMentionProvider } from '@renderer/lib/chat/local-session-mention-provider'
import { useSessionAgentCreationTools } from '@renderer/lib/chat/use-session-agent-creation-tools'
import { LocalizationProvider, setLocalePreference } from '@/i18n'
import type { GroupRosterCandidate } from '@/lib/mention'
import { installIdentityDirectoryBridge, publishIdentityDirectory } from '@/lib/identityDirectoryBridge'
import { displayIdentity } from '../../../../../../../tests/support/testHarness'
import { dicebearAvatarDataUri } from '@/lib/dicebearAvatar'
import { translateSessionMessage } from '@renderer/localization/locale-store'
import { until } from '../../../../../../../tests/support/awaitCondition'
import '@/i18n/registerMessagingCatalog'
import '@/styles/tokens.css'

vi.mock('@renderer/lib/shell-port', async (importOriginal) => ({
  ...await importOriginal<typeof import('@renderer/lib/shell-port')>(),
  shellPort: () => ({ sessionPeers: async () => [{ sessionId: 'task-claude', engine: 'codex',
    identity: { users: { id: 'agent-claude', display_name: 'Claude', gugu_number: 123 } },
  }] }),
}))

const customAvatar = dicebearAvatarDataUri('alice-uploaded-avatar')
const members: GroupRosterCandidate[] = [
  { id: 'human-alice', name: 'Alice', type: 'human', avatar: customAvatar },
  { id: 'agent-claude', name: 'Claude', type: 'agent' },
]

let root: Root | null = null
let host: HTMLDivElement | null = null
const taskMentions = createLocalSessionMentionProvider()

function TaskEditor() {
  const { renderMentionIcon } = useSessionAgentCreationTools()
  return <MessageProvider locale="en-US" translate={translateSessionMessage}>
    <ChatComposer editorOptions={{ inputTestId: 'task-mention-editor' }} mentionProvider={taskMentions}
      renderMentionIcon={renderMentionIcon} onSubmit={() => {}} onInputChange={() => {}} />
  </MessageProvider>
}

describe('participant mention presentation', () => {
  beforeEach(async () => {
    await page.viewport(900, 720)
    setLocalePreference('en-US')
    installIdentityDirectoryBridge()
    publishIdentityDirectory(Object.fromEntries(members.map((member) => [member.id,
      displayIdentity(member.id, { type: member.type, display_name: member.name, avatar: member.avatar ?? null }),
    ])), null)
    host = document.createElement('div')
    host.style.cssText = 'position:absolute;left:40px;top:340px;width:min(640px, calc(100vw - 80px))'
    document.body.appendChild(host)
    root = createRoot(host)
    root.render(
      <LocalizationProvider>
        <ChatMessageComposer onSend={vi.fn(async () => {})} isGroupChat groupMembers={members} />
      </LocalizationProvider>,
    )
  })

  afterEach(() => {
    root?.unmount()
    host?.remove()
    root = null
    host = null
    publishIdentityDirectory(null, null)
  })

  it.each([390, 900].flatMap((width) => [
    { name: 'Alice', id: 'human-alice' },
    { name: 'Claude', id: 'agent-claude' },
    { name: 'Everyone', id: '*' },
  ].map((member) => ({ ...member, width }))))('shows an avatar in suggestions and an avatar-free @$name pill at $width px', async ({ name, id, width }) => {
    await page.viewport(width, 720)
    const input = page.getByTestId('chat-composer')
    await input.click()
    await userEvent.keyboard('@')
    const option = page.getByRole('option', { name: new RegExp(name) })
    await until('participant option is available', () => option.elements().length === 1)
    expect(option.element().querySelector('img, svg[role="img"]'), 'use the participant avatar, not a first initial').not.toBeNull()
    if (id === 'human-alice') expect(option.element().querySelector('img')?.getAttribute('src')).toBe(customAvatar)
    if (id === '*') expect(option.element().textContent?.replace('↵', '')).toBe('Everyone')

    await option.click()
    await until('participant pill is inserted', () => input.element().querySelector(`[data-mention-id="${id}"]`) !== null)
    const pill = input.element().querySelector(`[data-mention-id="${id}"]`)!
    expect(pill.textContent).toBe(`@${name}`)
    expect(pill.querySelector('img, svg[role="img"]'), 'selected mentions only show @name').toBeNull()
    expect(page.getByRole('button', { name: `Remove @${name}` }).elements()).toHaveLength(1)
  })

  it('shows the task identity avatar in suggestions and only @name in its pill', async () => {
    root!.render(<LocalizationProvider><TaskEditor /></LocalizationProvider>)
    const input = page.getByTestId('task-mention-editor')
    await input.click()
    await userEvent.keyboard('@Claude')
    const option = page.getByRole('option', { name: /Claude/ })
    await until('task peer is available', () => option.elements().length === 1)
    expect(option.element().querySelector('[data-agent-avatar-boring="agent-claude"]')).not.toBeNull()
    await option.click()
    await until('task peer pill is inserted', () => input.element().querySelector('[data-mention-id="aid:agent-claude"]') !== null)
    const pill = input.element().querySelector('[data-mention-id="aid:agent-claude"]')!
    expect(pill.textContent).toBe('@Claude')
    expect(pill.querySelector('img, svg[role="img"]')).toBeNull()
  })

  it('shows only @name when a member is inserted from their profile', async () => {
    root!.render(<LocalizationProvider><ChatMessageComposer onSend={vi.fn(async () => {})} isGroupChat groupMembers={members}
      mentionToInsert={{ id: 'agent-claude', name: 'Claude' }} onMentionInserted={vi.fn()} /></LocalizationProvider>)
    const input = page.getByTestId('chat-composer')
    await until('profile mention is inserted', () => document.querySelector('[data-testid="chat-composer"] [data-mention-id="agent-claude"]') !== null)
    const pill = input.element().querySelector('[data-mention-id="agent-claude"]')!
    expect(pill.textContent).toBe('@Claude')
    expect(pill.querySelector('img, svg[role="img"]')).toBeNull()
  })
})
