// @vitest-environment jsdom
import { createElement } from 'react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { TranscriptTurn } from '@gugu/session-core/acp/client'
import { createReactHarness } from '../../../support/testHarness'

const mocks = vi.hoisted(() => {
  const ops: string[] = []
  const makeState = () => ({
    transcript: {
      history: {
        seed: vi.fn((turns: { id: string }[]) => ops.push(`seed:${turns.map((t) => t.id).join(',')}`)),
        append: vi.fn((turns: { id: string }[]) => ops.push(`append:${turns.map((t) => t.id).join(',')}`)),
        prepend: vi.fn((turns: { id: string }[]) => ops.push(`prepend:${turns.map((t) => t.id).join(',')}`)),
      },
      activeTurn: { set: vi.fn((turn: { id: string } | null, status?: string) => ops.push(`active:${turn?.id ?? 'none'}:${status ?? ''}`)) },
    },
    session: { setBackgroundTasks: vi.fn() },
    dispose: vi.fn(),
  })
  return {
    ops,
    states: [] as ReturnType<typeof makeState>[],
    makeState,
    contexts: [] as { dispose: ReturnType<typeof vi.fn> }[],
    shared: vi.fn(),
    transcriptProps: [] as Record<string, unknown>[],
  }
})

vi.mock('../../../../apps/desktop/src/session/renderer/lib/chat/chat-transcript', () => ({
  loadChatUi: () => Promise.resolve({ createChatState: () => { const s = mocks.makeState(); mocks.states.push(s); return s } }),
  ChatTranscript: (props: Record<string, unknown>) => { mocks.transcriptProps.push(props); return null },
}))
vi.mock('../../../../apps/desktop/src/session/renderer/lib/chat/shared-chat-context', () => ({
  createSessionChatContext: () => { const c = { dispose: vi.fn() }; mocks.contexts.push(c); return c },
  getSharedChatContext: mocks.shared,
}))

import { SessionTranscriptView } from '../../../../apps/desktop/src/components/assistant-ui/session-transcript-view.aui'

const turn = (id: string, settled = true): TranscriptTurn => ({ id, seq: Number(id.slice(1)), items: [], ...(settled ? { outcome: { kind: 'end_turn' } } : {}) }) as unknown as TranscriptTurn
let harness: ReturnType<typeof createReactHarness>
beforeEach(() => { harness = createReactHarness(); mocks.ops.length = 0; mocks.states.length = 0; mocks.contexts.length = 0; mocks.transcriptProps.length = 0 })
afterEach(() => harness.cleanup())

const flush = () => new Promise((resolve) => setTimeout(resolve, 0))

it('draws on a ChatContext of its own, so its layout does not restyle the other transcripts in the window', async () => {
  const layout = { preset: 'double' as const, userGutter: 0, agentConversation: true }
  await harness.render(createElement(SessionTranscriptView, { uri: 's1', turns: [turn('t1')], layout }))
  await flush(); await harness.render(createElement(SessionTranscriptView, { uri: 's1', turns: [turn('t1')], layout }))
  expect(mocks.shared).not.toHaveBeenCalled()
  const props = mocks.transcriptProps.at(-1)!
  expect(props.context).toBe(mocks.contexts[0])
  expect(props.layout).toEqual(layout)
  expect(props.stickToBottom).toBe(true)
})

it('feeds the whole timeline: settled turns into history, the open last turn as the active one', async () => {
  const t1 = turn('t1'), t2 = turn('t2'), t3 = turn('t3', false)
  await harness.render(createElement(SessionTranscriptView, { uri: 's1', turns: [t1, t2, t3] }))
  await flush(); await harness.render(createElement(SessionTranscriptView, { uri: 's1', turns: [t1, t2, t3] }))
  expect(mocks.ops).toContain('seed:t1,t2')
  expect(mocks.ops).toContain('active:t3:generating')
  mocks.ops.length = 0
  const t3done = turn('t3')
  await harness.render(createElement(SessionTranscriptView, { uri: 's1', turns: [t1, t2, t3done] }))
  expect(mocks.ops).toEqual(['append:t3', 'active:none:'])
  mocks.ops.length = 0
  const t0 = turn('t0')
  await harness.render(createElement(SessionTranscriptView, { uri: 's1', turns: [t0, t1, t2, t3done] }))
  expect(mocks.ops).toEqual(['prepend:t0', 'active:none:'])
})

it('hands the background tasks to the transcript and disposes its state and context when the session changes', async () => {
  const tasks = { commands: [{ id: 'call_bg', taskId: 'b1', name: 'Bash' }], subagents: [] } as never
  await harness.render(createElement(SessionTranscriptView, { uri: 's1', turns: [], backgroundTasks: tasks }))
  await flush(); await harness.render(createElement(SessionTranscriptView, { uri: 's1', turns: [], backgroundTasks: tasks }))
  expect(mocks.states[0]!.session.setBackgroundTasks).toHaveBeenLastCalledWith(tasks)
  await harness.render(createElement(SessionTranscriptView, { uri: 's2', turns: [] }))
  expect(mocks.states[0]!.dispose).toHaveBeenCalled()
  expect(mocks.contexts[0]!.dispose).toHaveBeenCalled()
})
