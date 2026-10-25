// @vitest-environment jsdom
import { act } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AgentSentBadge } from '../../../../apps/desktop/src/components/chat/AgentSentBadge'
import { MessageBubble } from '../../../../apps/desktop/src/components/chat/MessageBubble'
import { chatService } from '../../../../apps/desktop/src/lib/chat'
import { createNode, createReactHarness, message, renderWithAppProviders } from '../../../support/testHarness'
vi.mock('../../../../apps/desktop/src/hooks/useAgentHarnessIdentity', () => ({ useAgentHarnessIdentity: () => 'codex' }))
let harness: ReturnType<typeof createReactHarness>
beforeEach(() => { harness = createReactHarness() })
afterEach(() => { harness.cleanup() })
const source = { id: 'agent-1', name: 'Researcher' }

describe('AI-sent message attribution (#7299)', () => {
  it.each(['text', 'attachment'] as const)('the recipient sees only AI sent and no Agent name or jump target for %s', async content_type => {
    await renderWithAppProviders(harness, createNode(MessageBubble, {
      msg: message({ sender_user_id: 'owner', is_mine: false, sent_by_agent: true, agent_sender: source, content_type, ...(content_type === 'attachment' ? { content: '[附件] 资料.pdf (application/pdf)\n[URL] https://storage.test/report.pdf\n[Size] 3\n[Kind] file' } : {}) }),
      onReaction: vi.fn(), memberReadSeqs: {}, onQuote: vi.fn(), onForward: vi.fn(), onDelete: vi.fn(),
    }))
    const marker = harness.container.querySelector('[data-ai-sent="true"]')!
    expect(marker.textContent).toBe('AI 发送')
    expect(marker.tagName).toBe('SPAN')
    expect(harness.container.innerHTML).not.toContain('Researcher')
    expect(marker.outerHTML).not.toContain('agent-1')
  })
  it('opens the sending Agent’s conversation using the existing DM navigation', async () => {
    const open = vi.spyOn(chatService, 'getOrCreateDM').mockResolvedValue('agent-dm')
    const select = vi.fn(), upsert = vi.fn(), refresh = vi.fn().mockResolvedValue(undefined)
    await renderWithAppProviders(harness, createNode(AgentSentBadge, { source }), {
      auth: { id: 'owner' }, chat: { setActiveChatId: select, upsertChat: upsert, refreshChats: refresh },
    })
    const marker = harness.container.querySelector<HTMLButtonElement>('[data-ai-sent="true"]')!
    expect(marker.textContent).toBe('由 Researcher 代你发送')
    await act(async () => { marker.click() })
    expect(open).toHaveBeenCalledExactlyOnceWith('owner', 'agent-1')
    expect(upsert).toHaveBeenCalledWith(expect.objectContaining({ id: 'agent-dm', peer_user_id: 'agent-1' }))
    expect(select).toHaveBeenCalledWith('agent-dm')
    expect(refresh).toHaveBeenCalledOnce()
  })
  it('shows a visible failure and keeps the current conversation if opening fails', async () => {
    vi.spyOn(chatService, 'getOrCreateDM').mockRejectedValue(new Error('unavailable'))
    const toast = vi.fn(), select = vi.fn()
    await renderWithAppProviders(harness, createNode(AgentSentBadge, { source }), { toast, chat: { setActiveChatId: select } })
    await act(async () => { harness.container.querySelector<HTMLButtonElement>('button')!.click() })
    expect(toast).toHaveBeenCalledWith('无法打开代发 Agent 的对话', 'error', 'unavailable')
    expect(select).not.toHaveBeenCalled()
    expect(harness.container.querySelector<HTMLButtonElement>('button')!.disabled).toBe(false)
  })
  it('keeps the removed Agent’s name but does not offer a dead button', async () => {
    await renderWithAppProviders(harness, createNode(AgentSentBadge, { source: { ...source, id: null } }))
    expect(harness.container.textContent).toContain('Researcher')
    expect(harness.container.querySelector('button')).toBeNull()
    expect(harness.container.querySelector('[data-ai-sent]')?.getAttribute('title')).toBe('代发 Agent 已移除')
  })
  it('ordinary human messages have no AI marker', async () => {
    await renderWithAppProviders(harness, createNode(MessageBubble, {
      msg: message({ is_mine: false }), onReaction: vi.fn(), memberReadSeqs: {}, onQuote: vi.fn(), onForward: vi.fn(), onDelete: vi.fn(),
    }))
    expect(harness.container.querySelector('[data-ai-sent]')).toBeNull()
  })
})
