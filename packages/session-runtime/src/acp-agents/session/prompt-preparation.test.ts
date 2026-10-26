import { afterEach, expect, it, vi } from 'vitest'
import { noopLogger } from '@gugu/session-shared/logger'
import { SessionCell } from './cell'
import { FakeAcpAgent } from '../acp-test-support'
import { setNativePromptPreparation } from './prompt-preparation'

const cells: SessionCell[] = []
afterEach(() => { setNativePromptPreparation(null); for (const cell of cells.splice(0)) cell.dispose() })
function fixture() {
  const agent = new FakeAcpAgent()
  const cell = new SessionCell({ sessionId: 'assistant',projectId: 'home',providerId: 'claude',acpSessionId: 'native',agent,
    mergeEnvelopes: texts => texts.join('\n'),resolveAttachment: async () => ({ data: '',mimeType: 'image/png' }),logger: noopLogger,
  })
  cell.applySessionReady(); cells.push(cell)
  return { cell,agent }
}

it('adds current panel changes to a direct prompt and consumes them only after a native receipt', async () => {
  const { cell,agent } = fixture(), completed = Promise.withResolvers<{ stopReason: 'end_turn' }>()
  const accepted = vi.fn(async () => {})
  setNativePromptPreparation(async () => ({ text: 'memory was deleted; do not use it',accepted }))
  agent.prompt = vi.fn(() => completed.promise)
  const sent = cell.prompt({ text: 'Hello',origin: 'typed' })
  await vi.waitFor(() => expect(agent.prompt).toHaveBeenCalledOnce())
  expect(JSON.stringify(vi.mocked(agent.prompt).mock.calls[0])).toContain('memory was deleted')
  expect(accepted).not.toHaveBeenCalled()
  completed.resolve({ stopReason: 'end_turn' }); await sent
  expect(accepted).toHaveBeenCalledOnce()
})

it('reads the latest changes after queued messages coalesce and before their actual model request', async () => {
  const { cell,agent } = fixture(), first = Promise.withResolvers<{ stopReason: 'end_turn' }>(), second = Promise.withResolvers<{ stopReason: 'end_turn' }>()
  let context = ''
  const accepted = vi.fn(async () => {})
  const prepare = vi.fn(async () => ({ text: context,accepted: context ? accepted : async () => {} }))
  setNativePromptPreparation(prepare)
  agent.prompt = vi.fn().mockImplementationOnce(() => first.promise).mockImplementationOnce(() => second.promise)
  const running = cell.prompt({ text: 'First',origin: 'typed' })
  await vi.waitFor(() => expect(agent.prompt).toHaveBeenCalledOnce())
  cell.queuePrompt({ text: 'Obsolete',origin: 'communication',coalesceKey: 'report' })
  cell.queuePrompt({ text: 'Latest',origin: 'communication',coalesceKey: 'report' })
  context = 'personality changed after enqueue'
  expect(prepare).toHaveBeenCalledOnce()
  expect(accepted).not.toHaveBeenCalled()
  first.resolve({ stopReason: 'end_turn' }); await running
  await vi.waitFor(() => expect(agent.prompt).toHaveBeenCalledTimes(2))
  const actual = JSON.stringify(vi.mocked(agent.prompt).mock.calls[1])
  expect(actual).toContain('Latest'); expect(actual).toContain(context); expect(actual).not.toContain('Obsolete')
  expect(accepted).not.toHaveBeenCalled()
  second.resolve({ stopReason: 'end_turn' })
  await vi.waitFor(() => expect(accepted).toHaveBeenCalledOnce())
})

it('does not call the provider if a required panel change could not be applied', async () => {
  const { cell,agent } = fixture()
  setNativePromptPreparation(async () => { throw new Error('memory/note: DELETE_DENIED') })
  const result = await cell.prompt({ text: 'Hello',origin: 'typed' })
  expect(result.success).toBe(false)
  expect(agent.prompt).not.toHaveBeenCalled()
})
