// @vitest-environment jsdom
// gugu-dev#181 任务卡在群里的样子:卡头带时刻,「交给」带头像,我自己这台电脑上的卡不写在哪个项目,不挂已读环;
// agent 回群引用那张卡时,引用块是卡头「新任务」+ 原话,不是「发卡的人 / 新任务：原话」。
import { act } from 'react'
import { ComposerCardView } from '../../../../apps/desktop/src/components/chat/ComposerCardView'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { MessageBubble } from '../../../../apps/desktop/src/components/chat/MessageBubble'
import { serializeComposerCard, type TaskCard } from '../../../../packages/core/src/shared/ui/taskCardModels'
import { createNode, createReactHarness, displayIdentity, message, renderWithAppProviders } from '../../../support/testHarness'
import type { ChatContextValue } from '../../../../apps/desktop/src/store/chatContext'
import { installIdentityDirectoryBridge, publishIdentityDirectory } from '../../../../apps/desktop/src/lib/identityDirectoryBridge'
import { setLocalePreference } from '../../../../apps/desktop/src/i18n'

const cardOpen = vi.hoisted(() => ({ open: vi.fn(), snapshot: vi.fn(async () => ({ device_id: 'device-1' })) }))
vi.mock('../../../../apps/desktop/src/components/chat/openTaskCardSession', () => ({ openTaskCardSession: cardOpen.open }))
vi.mock('../../../../apps/desktop/src/platform', async (original) => {
  const actual = await original<typeof import('../../../../apps/desktop/src/platform')>()
  return { ...actual, platform: { ...actual.platform, getLocalDeviceSelfSnapshot: cardOpen.snapshot } }
})

// What this viewer can look up about the agent: for a colleague's agent still waiting to be let in, nothing (80e).
let lookedUp = 'codex'
vi.mock('../../../../apps/desktop/src/hooks/useAgentHarnessIdentity', () => ({ useAgentHarnessIdentity: () => lookedUp }))
// 我替 agent 发起的入群请求(库里的 list_my_agent_join_requests),和读了几次。
const joins = vi.hoisted(() => ({ status: new Map<string, string>(), reads: 0 }))
vi.mock('../../../../apps/desktop/src/lib/groupAgentJoinService', () => ({
  listMyAgentJoinRequests: async () => { joins.reads += 1; return new Map(joins.status) },
}))

// 接手的 agent 此刻的状态(侧栏同一份读数)。
let agentStatus: string | undefined
vi.mock('../../../../apps/desktop/src/hooks/useAgentDisplayStatus', () => ({
  useAgentDisplayStatuses: (ids: string[]) => Object.fromEntries(ids.map((id) => [id, agentStatus])),
}))

let harness: ReturnType<typeof createReactHarness>
beforeEach(() => {
  harness = createReactHarness(); lookedUp = 'codex'; agentStatus = undefined
  installIdentityDirectoryBridge()
  publishIdentityDirectory({}, () => {})
})
afterEach(() => { harness.cleanup(); publishIdentityDirectory(null, null); vi.useRealTimers() })

const CARD: TaskCard = {
  v: 1, type: 'task', text: '用一句话介绍你自己', agentUserId: 'agent-1', agentName: 'Codex 1', agentType: 'codex',
  sessionId: 'session-1', projectId: 'project-1', deviceId: 'device-1', machineLabel: 'This computer',
}
const bubble = (msg: ReturnType<typeof message>, compactMobile = false) => createNode(MessageBubble, {
  msg, compactMobile, onReaction: vi.fn(), memberReadSeqs: {}, onQuote: vi.fn(), onForward: vi.fn(), onDelete: vi.fn(),
  showReadReceipt: true, readReceiptRead: 0, readReceiptTotal: 1,
})
const ring = () => harness.container.querySelector('[data-testid="message-read-receipt"]')

describe('task cards follow the current agent identity', () => {
  const at = '2026-11-02T08:00:00.000Z'
  const content = () => harness.container.querySelector<HTMLElement>('[data-testid="composer-card"]')!
  const renderTask = async (card: TaskCard = CARD, createdAt = at, compactMobile = false, identityCreatedAt: string | null = at) => {
    await act(async () => publishIdentityDirectory(identityCreatedAt ? { [card.agentUserId]: displayIdentity(card.agentUserId, {
      type: 'agent', display_name: card.agentName, owner_user_id: 'user-1', created_at: identityCreatedAt,
    }) } : {}, () => {}))
    await renderWithAppProviders(harness, bubble(message({ id: 'live-card', is_mine: true, content_type: 'card', content: serializeComposerCard(card), created_at: createdAt }), compactMobile))
  }
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] })
    vi.setSystemTime(at)
  })

  it.each(['zh-CN', 'en-US'] as const)('shows a bounded naming placeholder for a newly created identity (%s)', async (locale) => {
    setLocalePreference(locale)
    await renderTask()
    const placeholder = locale === 'zh-CN' ? '正在起名…' : 'Naming the agent…'
    expect(content().textContent).toContain(placeholder)
    expect(content().textContent).not.toContain('Codex 1')
    await act(async () => { await vi.advanceTimersByTimeAsync(59_999) })
    expect(content().textContent).toContain(placeholder)
    await act(async () => { await vi.advanceTimersByTimeAsync(1) })
    expect(content().textContent).toContain('Codex 1')
    expect(content().textContent).not.toContain(placeholder)
  })

  it.each([false, true])('updates an existing card from the identity directory without remounting (mobile=%s)', async (mobile) => {
    await renderTask(CARD, at, mobile)
    const card = content()
    await act(async () => publishIdentityDirectory({ [CARD.agentUserId]: displayIdentity(CARD.agentUserId, {
      type: 'agent', display_name: '研究助手', owner_user_id: 'user-1',
    }) }, () => {}))
    expect(content()).toBe(card)
    expect(content().textContent).toContain('研究助手')
    expect(content().textContent).not.toContain('正在起名…')
    await act(async () => publishIdentityDirectory({ [CARD.agentUserId]: displayIdentity(CARD.agentUserId, {
      type: 'agent', display_name: '改过的名字', owner_user_id: 'user-1',
    }) }, () => {}))
    expect(content()).toBe(card)
    expect(content().textContent).toContain('改过的名字')
    expect(content().textContent).not.toContain('研究助手')
  })

  it('uses identity age independently of the card message age', async () => {
    await renderTask(CARD, '2026-11-02T07:00:00.000Z')
    expect(content().textContent).toContain('正在起名…')
    await renderTask(CARD, at, false, '2026-11-02T07:59:00.000Z')
    expect(content().textContent).toContain('Codex 1')
    expect(content().textContent).not.toContain('正在起名…')
  })

  it('keeps explicit names and missing identities raw, and recognizes legacy engine defaults', async () => {
    await renderTask({ ...CARD, agentName: 'Named at spawn' })
    expect(content().textContent).toContain('Named at spawn')
    await renderTask(CARD, at, false, null)
    expect(content().textContent).toContain('Codex 1')
    expect(content().textContent).not.toContain('正在起名…')
    const { agentType: _legacy, ...legacy } = CARD
    await renderTask(legacy)
    expect(content().textContent).toContain('正在起名…')
  })

  it('shows the placeholder on the first frame when identity creation is slightly ahead of the client clock', async () => {
    await renderTask(CARD, at, false, '2026-11-02T08:00:00.150Z')
    expect(content().textContent).toContain('正在起名…')
    expect(content().textContent).not.toContain('Codex 1')
  })

  it('shows the naming label in the actual message sender header without rewriting its profile', async () => {
    const memberProfile = { id: CARD.agentUserId, displayName: CARD.agentName, avatar: null, email: null, type: 'agent', role: 'member', ownerUserId: 'user-1' }
    publishIdentityDirectory({ [CARD.agentUserId]: displayIdentity(CARD.agentUserId, { type: 'agent', display_name: CARD.agentName, created_at: at }) }, () => {})
    await renderWithAppProviders(harness, createNode(MessageBubble, {
      msg: message({ is_mine: false, sender_user_id: CARD.agentUserId, content: 'Hello' }), memberProfile, isGroup: true,
      onReaction: vi.fn(), onQuote: vi.fn(), onForward: vi.fn(), onDelete: vi.fn(),
    }))
    expect(harness.container.querySelector('.msg-sender-name')?.textContent).toBe('正在起名…')
    expect(memberProfile.displayName).toBe('Codex 1')
  })
})

describe('task card in a chat (gugu-dev#181)', () => {
  it('shows three rows with the time and the agent avatar, and no read ring', async () => {
    await renderWithAppProviders(harness, bubble(message({
      id: 'card-1', is_mine: true, content_type: 'card', content: serializeComposerCard(CARD), created_at: '2026-10-22T15:26:00.000Z',
    })))
    const card = harness.container.querySelector('[data-testid="composer-card"]')!
    expect(card.textContent).toContain('新任务')
    expect(card.textContent).toMatch(/\d{1,2}:\d{2}/)
    expect(card.textContent).toContain('Codex 1')
    expect(card.querySelector('[data-agent-harness]'), 'the card head is the agent engine mark').not.toBeNull()
    expect(card.textContent).not.toContain('project-1')
    expect(ring(), 'a task card is an event, not a line to read').toBeNull()
  })

  it('draws who took it from the card, whatever this viewer can look up about that agent (80e)', async () => {
    lookedUp = 'unavailable'
    await renderWithAppProviders(harness, bubble(message({
      id: 'card-2', is_mine: false, sender_user_id: 'colleague', content_type: 'card', content: serializeComposerCard(CARD),
    })))
    const head = harness.container.querySelector('[data-testid="composer-card"] [data-agent-harness]')
    expect(head?.getAttribute('data-agent-harness')).toBe('codex')
  })

  it('a card from before the type was kept gets a neutral mark, not an error', async () => {
    const { agentType: _dropped, ...old } = CARD
    await renderWithAppProviders(harness, bubble(message({
      id: 'card-3', is_mine: true, content_type: 'card', content: serializeComposerCard(old as TaskCard),
    })))
    const card = harness.container.querySelector('[data-testid="composer-card"]')!
    expect(card.querySelector('[data-agent-harness]')).toBeNull()
    expect(card.textContent).toContain('Codex 1')
  })

  it('while its agent runs, the row ends in the sidebar\'s spinner, not a still dot; done is a tick', async () => {
    const card = (id: string) => bubble(message({ id, is_mine: true, content_type: 'card', content: serializeComposerCard(CARD) }))
    agentStatus = 'working'
    await renderWithAppProviders(harness, card('card-run'))
    const row = () => harness.container.querySelector('[data-testid="composer-card"]')!.lastElementChild!
    expect(row().textContent, 'a braille spinner frame').toMatch(/[\u2800-\u28ff]/)
    expect(row().querySelector('[data-animate="false"]'), 'it turns').toBeNull()
    harness.cleanup(); harness = createReactHarness()
    agentStatus = 'idle'
    await renderWithAppProviders(harness, card('card-done'))
    expect(row().textContent).not.toMatch(/[\u2800-\u28ff]/)
    expect(row().querySelector('svg')).not.toBeNull()
  })

  it('positive control: my plain message keeps its read ring', async () => {
    await renderWithAppProviders(harness, bubble(message({ id: 'text-1', is_mine: true, content: 'hi' })))
    expect(ring()).not.toBeNull()
  })

  it('quotes a card as its head and words, not as its sender', async () => {
    await renderWithAppProviders(harness, bubble(message({
      id: 'reply-1', is_mine: false, sender_user_id: 'agent-1', content: '我是 Codex',
      reply_to_message_id: 'card-1', reply_to_sender_user_id: 'owner', reply_to_content: serializeComposerCard(CARD),
    }), true))
    await act(async () => { harness.container.querySelector<HTMLButtonElement>('.gg-chat-reply-jump')!.click() })
    const quote = document.querySelector('.gg-chat-reply-preview > [title="跳到被引用的消息"]')!
    expect(quote.textContent).toContain('新任务')
    expect(quote.textContent).toContain('用一句话介绍你自己')
    expect(quote.textContent).not.toContain('新任务：')
  })
})

// 审批群里我派的卡:等群主同意时写「等群主同意它进群」。同意 / 拒绝时库给发起人发 friend_requests_changed,
// 卡跟着变,不用刷新页面;agent 已经坐进群里(成员表随 chat_members_changed 更新)就不读请求、不等。
describe('a task card waiting for the group owner (gugu-dev#181)', () => {
  type Subscribe = ChatContextValue['subscribeAccountRevision']
  let changed: Array<Parameters<Subscribe>[1]> = []
  const chat = { subscribeAccountRevision: ((_events, listener) => { changed.push(listener); return () => {} }) as Subscribe }
  const groupCard = (memberProfiles?: Record<string, unknown>) => createNode(MessageBubble, {
    msg: message({ id: 'card-9', is_mine: true, content_type: 'card', content: serializeComposerCard(CARD) }),
    isGroup: true, memberProfiles, onReaction: vi.fn(), memberReadSeqs: {}, onQuote: vi.fn(), onForward: vi.fn(), onDelete: vi.fn(),
  })
  const cardText = () => harness.container.querySelector('[data-testid="composer-card"]')!.textContent
  const requestChanged = (status: string) => act(async () => {
    joins.status.set('agent-1', status)
    for (const listener of changed) await listener([])
  })
  beforeEach(() => { changed = []; joins.status = new Map([['agent-1', 'pending']]); joins.reads = 0 })

  it('turns when the owner lets it in, without a reload', async () => {
    await renderWithAppProviders(harness, groupCard(), { chat })
    expect(cardText()).toContain('等群主同意它进群')
    await requestChanged('accepted')
    expect(cardText()).not.toContain('等群主同意它进群')
  })

  it('turns when the owner turns it down, without a reload', async () => {
    await renderWithAppProviders(harness, groupCard(), { chat })
    await requestChanged('rejected')
    expect(cardText()).toContain('群主没有同意它进群')
  })

  it('an agent already seated in the group: no request read, no waiting', async () => {
    await renderWithAppProviders(harness, groupCard({ 'agent-1': { displayName: 'Codex 1' } }), { chat })
    expect(joins.reads).toBe(0)
    expect(cardText()).not.toContain('等群主同意它进群')
  })
})


describe('task card resource access', () => {
  beforeEach(() => { cardOpen.open.mockClear(); cardOpen.snapshot.mockReset().mockResolvedValue({ device_id: 'device-1' }) })
  const renderCard = (isMine: boolean, card: TaskCard = CARD) => renderWithAppProviders(harness,
    createNode(ComposerCardView, { card, isMine, isGroup: true, chatId: 'chat-1', senderName: 'Colleague', time: '12:00' }))

  it('opens the owner remote task through the resource route, while a local task keeps its layout opener', async () => {
    await renderCard(true, { ...CARD, deviceId: 'another-device', machineLabel: 'Remote computer' })
    const remote = harness.container.querySelector<HTMLButtonElement>('[data-testid="composer-card"]')!
    expect(remote.tagName).toBe('BUTTON')
    await act(async () => { remote.click() })
    expect(cardOpen.open).toHaveBeenLastCalledWith(expect.objectContaining({ sessionId: CARD.sessionId }), false)
    await renderCard(true)
    await vi.waitFor(() => expect(cardOpen.snapshot).toHaveBeenCalled())
    await act(async () => { harness.container.querySelector<HTMLButtonElement>('[data-testid="composer-card"]')!.click() })
    expect(cardOpen.open).toHaveBeenLastCalledWith(CARD, true)
  })

  it('names the other owner and says it cannot be viewed, without opening a task', async () => {
    await renderCard(false, { ...CARD, files: [
      { itemId: 'brief', version: 1, name: 'brief.pdf', mimeType: 'application/pdf', sizeBytes: 12 },
      { itemId: 'notes', version: 2, name: 'notes.txt', mimeType: 'text/plain', sizeBytes: 4 },
    ] })
    const card = harness.container.querySelector<HTMLElement>('[data-testid="composer-card"]')!
    expect(card.tagName).toBe('DIV')
    expect(card.textContent).toContain('Colleague 的任务 · 无法查看')
    expect(card.textContent).toContain('brief.pdf')
    expect(card.textContent).toContain('notes.txt')
    expect(card.querySelector('a')).toBeNull()
    await act(async () => { card.click() })
    expect(cardOpen.open).not.toHaveBeenCalled()
  })

  it.each([
    { isMine: true, ownerUserId: 'other-owner', openable: false },
    { isMine: false, ownerUserId: 'user-1', openable: true },
  ])('uses the Agent owner when a card was forwarded (sender mine=$isMine)', async ({ isMine, ownerUserId, openable }) => {
    await renderWithAppProviders(harness, createNode(ComposerCardView, {
      card: CARD, isMine, isGroup: true, chatId: 'chat-1', senderName: 'Forwarder', time: '12:00',
      memberProfiles: { [CARD.agentUserId]: { id: CARD.agentUserId, displayName: CARD.agentName, avatar: null, email: null,
        type: 'agent', role: 'member', ownerUserId, ownerDisplayName: 'Original owner' } },
    }))
    const card = harness.container.querySelector<HTMLElement>('[data-testid="composer-card"]')!
    expect(card.tagName).toBe(openable ? 'BUTTON' : 'DIV')
    if (!openable) expect(card.textContent).toContain('Original owner 的任务 · 无法查看')
  })

  // #446:手机上任务那枚页签 = 开在卡上的话题,点卡就切过去;谁的卡都一样,❌ 去开会话页。
  it.each([true, false])('on the phone a tap opens the card\'s topic (mine=%s), not the session', async (isMine) => {
    const onOpenTopic = vi.fn()
    await renderWithAppProviders(harness, createNode(MessageBubble, {
      msg: message({ id: 'card-1', is_mine: isMine, content_type: 'card', content: serializeComposerCard(CARD) }),
      onReaction: vi.fn(), memberReadSeqs: {}, onQuote: vi.fn(), onForward: vi.fn(), onDelete: vi.fn(), compactMobile: true, onOpenTopic,
    }))
    const card = harness.container.querySelector<HTMLElement>('[data-testid="composer-card"]')!
    expect(card.tagName).toBe('BUTTON')
    await act(async () => { card.click() })
    expect(onOpenTopic).toHaveBeenCalledWith('card-1')
    expect(cardOpen.open).not.toHaveBeenCalled()
  })

  // A task's attachments are versions in its agent's DM folder: the phone opens them by id, as it opens any chat file.
  it('opens a task attachment with the chat file opener, by its id and version, without opening the topic', async () => {
    const onOpenTopic = vi.fn(), onOpenFile = vi.fn()
    const files = [{ itemId: 'brief', version: 2, name: 'brief.csv', mimeType: 'text/csv', sizeBytes: 12 }]
    await renderWithAppProviders(harness, createNode(MessageBubble, {
      msg: message({ id: 'card-1', is_mine: true, content_type: 'card', content: serializeComposerCard({ ...CARD, files }) }),
      onReaction: vi.fn(), memberReadSeqs: {}, onQuote: vi.fn(), onForward: vi.fn(), onDelete: vi.fn(), compactMobile: true, onOpenTopic, onOpenFile,
    }))
    const card = harness.container.querySelector<HTMLElement>('[data-testid="composer-card"]')!
    expect(card.tagName).toBe('DIV') // a card holding links is not a <button> around them
    const file = card.querySelector<HTMLElement>('[data-testid="task-card-file"]')!
    expect(file.textContent).toBe('brief.csv')
    await act(async () => { file.click() })
    expect(onOpenFile).toHaveBeenCalledWith({ kind: 'file', fileName: 'brief.csv', mimeType: 'text/csv', sizeBytes: 12, source: { kind: 'item', itemId: 'brief', version: 2 } })
    expect(onOpenTopic).not.toHaveBeenCalled()
    await act(async () => { card.click() })
    expect(onOpenTopic).toHaveBeenCalledWith('card-1')
  })

  it('does not retain a failed device lookup for the next card mount', async () => {
    cardOpen.snapshot.mockRejectedValueOnce(new Error('snapshot unavailable'))
    await renderCard(true)
    expect(harness.container.querySelector('[data-testid="composer-card"]')?.tagName).toBe('BUTTON')
    harness.cleanup(); harness = createReactHarness()
    await renderCard(true)
    expect(cardOpen.snapshot).toHaveBeenCalledTimes(2)
    await act(async () => { harness.container.querySelector<HTMLButtonElement>('[data-testid="composer-card"]')!.click() })
    expect(cardOpen.open).toHaveBeenLastCalledWith(CARD, true)
  })
})
