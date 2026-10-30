import { afterEach, expect, it, vi } from 'vitest'
import { noopLogger } from '@gugu/session-shared/logger'
import type { SessionCell } from './cell'
import { FakeAcpAgent, requestActivityCell } from '../acp-test-support'
import { setNativePromptPreparation } from './prompt-preparation'
import { renderDeliveryEnvelope } from '../../../../core/src/local/agent/deliveryEnvelope'
import { hermesPromptText, indexHermesPrompts, originalHermesPrompt } from '@gugu/session-core/acp/hermes-prompt'
import { pluginRegistry } from '@gugu/session-plugins/agents'

const cells: SessionCell[] = []
afterEach(() => { setNativePromptPreparation(null); for (const cell of cells.splice(0)) cell.dispose() })
function fixture(providerId = 'claude') {
  const agent = new FakeAcpAgent()
  const cell = requestActivityCell(agent, { sessionId: 'assistant',projectId: 'home',providerId,acpSessionId: 'native',
    historyRecovery: pluginRegistry.get(providerId)?.behavior.acp?.historyRecovery,
    mergeEnvelopes: texts => texts.join('\n'),resolveAttachment: async () => ({ data: '',mimeType: 'image/png' }),logger: noopLogger,
  })
  cell.applySessionReady(); cells.push(cell)
  return { cell,agent }
}

it.each(['hermes', 'codex', 'claude'])('records a confirmed native/original prompt boundary only for %s when appropriate', async providerId => {
  const { cell, agent } = fixture(providerId)
  const original = '<resource_changes>User-authored XML</resource_changes>'
  setNativePromptPreparation(async () => ({ text: '<resource_changes>Host preparation</resource_changes>', accepted: async () => {} }))
  await cell.prompt({ text: original, origin: 'typed' })
  const native = hermesPromptText(vi.mocked(agent.prompt).mock.calls[0]![0].prompt).text
  const turns = [...cell.transcript.history, ...(cell.transcript.activeTurn ? [cell.transcript.activeTurn] : [])]
  expect(turns).toHaveLength(1)
  const users = turns.flatMap(turn => turn.items).filter(item => item.kind === 'message' && item.role === 'user')
  expect(users).toHaveLength(1)
  expect(originalHermesPrompt(native, indexHermesPrompts(users))).toBe(providerId === 'hermes' ? original : undefined)
})

it('places conditional profile review before the delivery envelope and preserves the final reply instruction', async () => {
  const { cell, agent } = fixture()
  const review = '<gugu_profile_review>Review the outdated profile</gugu_profile_review>'
  const envelope = renderDeliveryEnvelope({ route: 'chat', from: '测试', fromId: 'user:person', messageId: 'msg:fixture', chat: 'isolated', at: 'test', content: 'hi' })
  setNativePromptPreparation(async () => ({ text: 'panel change', beforeText: review, accepted: async () => {} }))
  await cell.prompt({ text: envelope, origin: 'communication' })
  const request = vi.mocked(agent.prompt).mock.calls[0]![0]
  expect(request.prompt).toEqual([{ type: 'text', text: 'panel change' }, { type: 'text', text: review }, { type: 'text', text: envelope }])
  expect(envelope).toContain('what you print here does not reach the sender — reply with message_send.')
  expect(request.prompt.at(-1)).toEqual({ type: 'text', text: envelope })
  const visible = JSON.stringify([...cell.transcript.history, cell.transcript.activeTurn])
  expect(visible).toContain('hi')
  expect(visible).not.toContain('gugu_profile_review')
})

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

it('returns the notice of a cancelled turn to the next one instead of consuming it', async () => {
  const { cell,agent } = fixture()
  const accepted = vi.fn(async () => {}), rejected = vi.fn(async () => {})
  setNativePromptPreparation(async () => ({ text: '',beforeText: '<resource_changes>飞书已连接</resource_changes>',accepted,rejected }))
  agent.prompt = vi.fn(async () => ({ stopReason: 'cancelled' as const }))
  await cell.prompt({ text: 'Hello',origin: 'typed' })
  expect(rejected).toHaveBeenCalledOnce()
  expect(accepted).not.toHaveBeenCalled()
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

it.each(['typed','communication'] as const)('refuses detached %s delivery before admission when panel preparation fails', async origin => {
  const { cell,agent } = fixture()
  setNativePromptPreparation(async () => { throw Object.assign(new Error('面板变更尚未处理完。'),{ deliveryRejectedBeforeAdmission: true }) })
  const delivery = cell.promptDetached({ text: 'Due reminder',origin })
  expect(await delivery.admission).toMatchObject({ success: false,error: { type: 'session_busy' } })
  expect((await delivery.completion).success).toBe(false)
  expect(agent.prompt).not.toHaveBeenCalled()
  expect(cell.history().committed).toHaveLength(0)
  expect(cell.machine.phase.kind).toBe('ready')
})

it('retains an already queued reminder when preparation fails and retries without another user action', async () => {
  const { cell,agent } = fixture(), first = Promise.withResolvers<{ stopReason: 'end_turn' }>()
  const prepare = vi.fn().mockResolvedValueOnce({ text: '',accepted: async () => {} })
    .mockRejectedValueOnce(Object.assign(new Error('面板暂时读不到。'),{ deliveryRejectedBeforeAdmission: true }))
    .mockResolvedValue({ text: '',accepted: async () => {} })
  setNativePromptPreparation(prepare)
  agent.prompt = vi.fn().mockImplementationOnce(() => first.promise).mockResolvedValue({ stopReason: 'end_turn' })
  const running = cell.prompt({ text: 'First',origin: 'typed' })
  await vi.waitFor(() => expect(agent.prompt).toHaveBeenCalledOnce())
  cell.queuePrompt({ text: 'Due reminder',origin: 'communication' })
  first.resolve({ stopReason: 'end_turn' });await running
  await vi.waitFor(() => expect(prepare).toHaveBeenCalledTimes(2))
  expect(cell.machine.queuedPrompts.map(row => row.text)).toEqual(['Due reminder'])
  await vi.waitFor(() => expect(agent.prompt).toHaveBeenCalledTimes(2),{ timeout: 5000 })
  expect(JSON.stringify(vi.mocked(agent.prompt).mock.calls[1])).toContain('Due reminder')
  expect(cell.machine.queuedPrompts).toHaveLength(0)
})

it('keeps the submitted message visible while preparation is pending without claiming provider admission', async () => {
  const { cell,agent } = fixture(), preparation = Promise.withResolvers<{ text: string; accepted(): Promise<void> }>()
  setNativePromptPreparation(() => preparation.promise)
  const sent = cell.promptDetached({ text: 'Waiting for preparation',origin: 'typed' })
  expect(JSON.stringify(cell.history())).toContain('Waiting for preparation')
  expect(agent.prompt).not.toHaveBeenCalled()
  preparation.resolve({ text: '',accepted: async () => {} })
  expect((await sent.admission).success).toBe(true)
  await sent.completion
})
it.each(['prompt','queueBehindTurn'] as const)('%s preserves the next draft typed during preparation when the original message is admitted', async method => {
  const { cell } = fixture(), preparation = Promise.withResolvers<{ text: string; accepted(): Promise<void> }>()
  setNativePromptPreparation(() => preparation.promise)
  cell.setPromptDraft({ rev: 1,input: { text: 'Submitted' } })
  const sent = cell[method]({ text: 'Submitted',origin: 'typed' })
  cell.setPromptDraft({ rev: 2,input: { text: 'Next unsent draft' } })
  preparation.resolve({ text: '',accepted: async () => {} })
  await sent
  expect(cell.promptDraft?.text).toBe('Next unsent draft')
})

it('keeps resource changes hidden for communication input and releases an unadmitted slice after failure', async () => {
  const { cell, agent } = fixture()
  const rejected = vi.fn(async () => {})
  const changes = '<resource_changes>数据：版本0→1\n+ 连接应用 钉钉</resource_changes>'
  setNativePromptPreparation(async () => ({ text: '', beforeText: changes, accepted: async () => {}, rejected }))
  agent.prompt = vi.fn(async () => { throw Object.assign(new Error('No session'), { deliveryRejectedBeforeAdmission: true }) })
  await cell.prompt({ text: 'Scheduled check', origin: 'communication' })
  expect(vi.mocked(agent.prompt).mock.calls[0]?.[0].prompt).toContainEqual({ type: 'text', text: changes })
  expect(JSON.stringify([...cell.transcript.history, cell.transcript.activeTurn])).not.toContain('resource_changes')
  expect(rejected).toHaveBeenCalledOnce()
})
