// @vitest-environment jsdom
import { act } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createReactHarness, clickElement } from '../../../support/testHarness'
import '../../../../apps/desktop/src/i18n/registerAssistantCatalog'
import { AssistantTyping } from '../../../../apps/desktop/src/components/assistant/AssistantTyping'
import { assistantReplyActivity } from '../../../../apps/desktop/src/components/assistant/assistantReplyActivity'
import { emptyAgentWatchTimeline, applySnapshot, applyBatch } from '../../../../apps/desktop/src/mobile/agent-watch/agent-watch-store'

let harness: ReturnType<typeof createReactHarness>
beforeEach(() => { harness = createReactHarness() })
afterEach(() => { harness.cleanup(); vi.useRealTimers() })
const thought = { phase: 'thinking', id: 'thought', startedAt: 1_000, text: 'Real thought text' } as const

describe('assistant reply progress', () => {
  it('ordinary waiting is never called thinking and has no fabricated timer', async () => {
    await harness.render(<AssistantTyping pending="working" name="bc" />)
    expect(harness.container.textContent).toContain('处理中')
    expect(harness.container.textContent).not.toContain('思考')
    expect(harness.container.querySelector('.ast-typing-elapsed')).toBeNull()
  })
  it('shows real thinking duration, expands provided text, then clears it on text/tool/failure transitions', async () => {
    vi.useFakeTimers(); vi.setSystemTime(4_000)
    await harness.render(<AssistantTyping pending="working" name="bc" activity={thought} />)
    expect(harness.container.textContent).toContain('正在思考')
    expect(harness.container.querySelector('.ast-typing-elapsed')?.textContent).toContain('3 秒')
    await act(async () => { vi.advanceTimersByTime(2_000) })
    expect(harness.container.querySelector('.ast-typing-elapsed')?.textContent).toContain('5 秒')
    const button = harness.container.querySelector('button')!
    await clickElement(button)
    expect(button.getAttribute('aria-expanded')).toBe('true')
    expect(harness.container.querySelector('[data-testid="assistant-thinking-text"]')?.textContent).toBe('Real thought text')
    await harness.render(<AssistantTyping pending="working" name="bc" activity={{ phase: 'replying' }} />)
    expect(harness.container.textContent).toContain('正在生成回复')
    expect(harness.container.querySelector('[data-testid="assistant-thinking-text"]')).toBeNull()
    expect(harness.container.querySelector('.ast-typing-elapsed')).toBeNull()
    await harness.render(<AssistantTyping pending="working" name="bc" />)
    expect(harness.container.textContent).toContain('处理中')
    expect(harness.container.textContent).not.toContain('思考')
  })
  it('only accepts the current source and ignores stale or unsupported-host metadata', () => {
    const reply = { sourceMessageId: 'msg:one', activity: thought }
    expect(assistantReplyActivity(reply, 'one')).toEqual(thought)
    expect(assistantReplyActivity(reply, 'other')).toBeNull()
    const base = applySnapshot(emptyAgentWatchTimeline(), { cursor: { epoch: 'e', seq: 1 }, turns: [], settlements: [], hasOlder: false, liveReply: reply })
    const cleared = applyBatch(base, { from: 1, cursor: { epoch: 'e', seq: 2 }, turns: [], removedTurnIds: [], settlements: [], liveReply: null })
    expect(cleared.liveReply).toBeNull()
    const replay = applyBatch(cleared, { from: 0, cursor: { epoch: 'e', seq: 1 }, turns: [], removedTurnIds: [], settlements: [], liveReply: reply })
    expect(replay.liveReply).toBeNull()
    expect(applySnapshot(base, { cursor: { epoch: 'old', seq: 0 }, turns: [], settlements: [], hasOlder: false }).liveReply).toBeNull()
  })
})
