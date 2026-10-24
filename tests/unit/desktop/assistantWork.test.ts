import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { AssistantWorkStore, assistantWorkBinding, coordinateAssistantAction,
  receiveAssistantWorkReport, registerAssistantQuestion, settleAssistantQuestion } from '../../../apps/desktop/electron/sessionpage/assistant-work'

let root: string
beforeEach(async () => { root = await mkdtemp(join(tmpdir(), 'assistant-work-')); vi.stubEnv('GUGU_HOME', root) })
afterEach(async () => { vi.unstubAllEnvs(); await rm(root, { recursive: true, force: true }) })

it('registers acknowledged work and survives a new store instance without copying the request or result body', async () => {
  const memoryDir = join(root, 'memory')
  const result = { session_id: 'child', model: { id: 'model' } }
  const dispatch = vi.fn(async () => result)
  const source = 'gugu-chat://3be752cb-0925-447e-8bbc-70de8a867bd1/bfb72f98-986e-4314-b242-d9b95a0c8083'
  expect(await coordinateAssistantAction({ sessionId: 'parent', memoryDir },
    { action: 'spawn', prompt: 'private request body', device: 'phone', source_link: source }, dispatch)).toMatchObject(result)
  const store = new AssistantWorkStore(memoryDir)
  const [work] = store.list()
  expect(work).toMatchObject({ state: 'waiting', recipients: ['session:child'], source_link: source, device: 'phone' })
  expect(dispatch.mock.calls[0]).toEqual([expect.objectContaining({ prompt: expect.stringContaining(work.id) })])
  expect(await readFile(store.path, 'utf8')).not.toContain('private request body')
})

it('a final file-handoff report settles its executor wait; progress, questions and idle-like messages do not', () => {
  const store = new AssistantWorkStore(join(root, 'memory'))
  const id = store.begin({ kind: 'executor' })
  store.confirm(id, ['session:child'], ['dispatch-receipt'])
  for (const status of ['progress', 'question'] as const) {
    store.report('session:child', { work_id: id, status }, 'draft-attachment-message')
    expect(store.list()).toHaveLength(1)
  }
  // Neither a text saying done, an attachment nor then=stop is inspected. Only the typed, correlated result is terminal.
  store.report('session:unrelated', { work_id: id, status: 'completed' }, 'unrelated-final')
  expect(store.list()).toHaveLength(1)
  store.report('session:child', { work_id: id, status: 'completed' }, 'accepted-final-with-attachments')
  expect(new AssistantWorkStore(join(root, 'memory')).list()).toEqual([])
})

it('does not lose a fast result racing the spawn acknowledgement or close other recipients', () => {
  const store = new AssistantWorkStore(root)
  const id = store.begin({ kind: 'executor' })
  store.report('session:first', { work_id: id, status: 'completed' }, 'fast-result')
  store.report('session:wrong', { work_id: id, status: 'completed' }, 'forged-result')
  store.confirm(id, ['session:first', 'session:second'], [])
  expect(store.list()[0].recipients).toEqual(['session:second'])
  store.report('session:second', { work_id: id, status: 'completed' }, 'second-result')
  expect(store.list()).toEqual([])
})

it('keeps unknown outcomes explicit and does not turn them into a successful dispatch', async () => {
  const binding = { sessionId: 'parent', memoryDir: root }
  await expect(coordinateAssistantAction(binding, { action: 'spawn', prompt: 'request' }, async () => { throw new Error('RPC timeout') })).rejects.toThrow('RPC timeout')
  expect(new AssistantWorkStore(root).list()[0].state).toBe('uncertain')
})

it('tracks each question separately and its explicit settlement never completes an executor', () => {
  const binding = assistantWorkBinding('parent', join(root, 'assistant'), 'computer')
  const store = new AssistantWorkStore(binding.memoryDir)
  const work = store.begin({ kind: 'executor' }); store.confirm(work, ['session:child'], [])
  registerAssistantQuestion('parent', 'question-1', 'original-source')
  registerAssistantQuestion('parent', 'question-1', 'original-source')
  expect(store.list()).toHaveLength(2)
  settleAssistantQuestion('parent', 'question-1')
  expect(store.list()).toMatchObject([{ id: work, kind: 'executor' }])
})

it('receives a remote executor report through the durable assistant binding and clearing only forgets recovery entries', () => {
  const binding = assistantWorkBinding('parent', join(root, 'assistant'), 'computer')
  const store = new AssistantWorkStore(binding.memoryDir)
  const id = store.begin({ kind: 'executor' }); store.confirm(id, ['session:remote'], [])
  receiveAssistantWorkReport('parent', 'remote', { work_id: id, status: 'completed' }, 'remote-receipt')
  expect(store.list()).toEqual([])
  store.confirm(store.begin({ kind: 'executor' }), ['session:still-running'], [])
  store.clear()
  expect(store.list()).toEqual([])
})

it('does not register read actions and preserves an ordinary message result', async () => {
  const action = { action: 'get', session_id: 'child' }
  const run = vi.fn(async input => input)
  expect(await coordinateAssistantAction({ sessionId: 'parent', memoryDir: root }, action, run)).toBe(action)
  expect(new AssistantWorkStore(root).list()).toEqual([])
})
