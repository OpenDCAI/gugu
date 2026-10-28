import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
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

it('continuing one recipient preserves other unfinished recipients of the same work', () => {
  const store = new AssistantWorkStore(root)
  const id = store.begin({ kind: 'executor' })
  store.confirm(id, ['session:first', 'session:second'], ['initial'])
  expect(store.begin({ kind: 'executor' }, ['session:first'], id)).toBe(id)
  store.confirm(id, ['session:first'], ['follow-up'])
  store.report('session:first', { work_id: id, status: 'completed' }, 'final-first')
  expect(store.list()[0].recipients).toEqual(['session:second'])
  expect(store.list()[0].receipt_ids).toEqual(['initial', 'follow-up'])
})

it('keeps unknown outcomes explicit and does not turn them into a successful dispatch', async () => {
  const binding = { sessionId: 'parent', memoryDir: root }
  await expect(coordinateAssistantAction(binding, { action: 'spawn', prompt: 'request' }, async () => { throw new Error('RPC timeout') })).rejects.toThrow('RPC timeout')
  expect(new AssistantWorkStore(root).list()[0].state).toBe('needs_source')
})

it('persists a source-missing legacy outcome for manual recovery without expiring referenced old work', async () => {
  const store = new AssistantWorkStore(root)
  const legacy = { id: 'legacy', kind: 'executor', state: 'uncertain', created_at: '2020-01-01T00:00:00Z', recipients: [], receipt_ids: [] }
  await writeFile(store.path, JSON.stringify({ version: 1, items: [legacy,
    { ...legacy, id: 'source', source_link: 'gugu-chat://original/request' },
    { ...legacy, id: 'recipient', recipients: ['session:child'] },
    { ...legacy, id: 'receipt', receipt_ids: ['accepted'] },
  ] }))
  expect(store.list().map(row => [row.id, row.state])).toEqual([
    ['legacy', 'needs_source'], ['source', 'uncertain'], ['recipient', 'uncertain'], ['receipt', 'uncertain'],
  ])
  expect(JSON.parse(await readFile(store.path, 'utf8')).items[0]).toEqual({ ...legacy, state: 'needs_source' })
  await expect(coordinateAssistantAction({ sessionId: 'parent', memoryDir: root },
    { action: 'message', work_id: 'legacy', to: ['session:child'], text: 'continue' }, vi.fn())).rejects.toThrow('waiting work')
  store.remove('legacy')
  expect(store.list().map(row => row.id)).toEqual(['source', 'recipient', 'receipt'])
})

it('persists the host-observed original input when dispatch is refused, independently of model source fields', async () => {
  const source = { source_link: 'gugu-chat://127ec4f0-30b1-4583-b469-706756153bdd/ee1a78d8-55f3-42ac-b437-4cf4e81a4741',
    source_message_id: 'ee1a78d8-55f3-42ac-b437-4cf4e81a4741', source_summary: 'Read the latest record on my device.' }
  const binding = { sessionId: 'parent', memoryDir: root, currentInput: async () => source }
  await expect(coordinateAssistantAction(binding,
    { action: 'spawn', prompt: 'executor instructions', device: 'phone', source_link: 'incorrect model address' },
    async () => { throw Object.assign(new Error('Enable the device task host'), { code: 'device_no_task_runtime' }) },
  )).rejects.toThrow('Enable the device task host')
  const [pending] = new AssistantWorkStore(root).list()
  expect(pending).toMatchObject({ ...source, state: 'blocked', blocked_reason: 'device_no_task_runtime', device: 'phone' })
  expect(await readFile(join(root, 'pending-work.json'), 'utf8')).not.toContain('executor instructions')
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

it.each(['spawn', 'message'] as const)('%s tells executors to escalate delivery failures before investigating the platform', async action => {
  const run = vi.fn<(action: unknown) => Promise<unknown>>(async () => action === 'spawn' ? { session_id: 'child' }
    : { recipients: [{ to: 'session:child', status: 'delivered', message_id: 'dispatch-receipt' }] })
  await coordinateAssistantAction({ sessionId: 'parent', memoryDir: root },
    action === 'spawn' ? { action, prompt: 'Make a report.' }
      : { action, to: ['session:child'], text: 'Continue the report.' }, run)
  const dispatched = run.mock.calls[0][0] as Record<string, string>
  const text = dispatched[action === 'spawn' ? 'prompt' : 'text']
  const contract = JSON.parse(text.split('<gugu_work>\n')[1].split('\n</gugu_work>')[0])
  expect(contract.coordinator).toBe('session:parent')
  expect(contract.work_id).toBe(new AssistantWorkStore(root).list()[0].id)
  const report = contract.report as string
  expect(report).toContain('verify result before completed; a failed delivery is progress, never completed')
  expect(report).toContain('Gugu messaging/upload/reporting fails, immediately report progress')
  expect(report).toContain('work done or partial, failed step, observed cause category')
  expect(report).toContain('permission/network/validation/unknown')
  expect(report).toContain('if done say "做好了但交不回"')
  expect(report).toContain('If reporting also fails, preserve this notice in the task reply and stop')
  expect(report).toContain('Never read Gugu program directories or debug/repair the platform')
})

it('implicitly continues open work of the same kind, never on a fresh or reply dispatch, and only ledgered work when asked (#615)', () => {
  const store = new AssistantWorkStore(root)
  const older = store.begin({ kind: 'executor' })
  store.confirm(older, ['session:child'], [])
  // No ledger entry on record: the account ledger has never seen this work, so it is not continued implicitly.
  const fresh = store.dispatch({ kind: 'executor' }, ['session:child'], { ledgered: true })
  expect(fresh).toMatchObject({ continued: false })
  expect(fresh.id).not.toBe(older)
  expect(store.dispatch({ kind: 'executor' }, ['session:child'])).toEqual({ id: older, continued: true })
  expect(store.dispatch({ kind: 'executor', purpose: 'reply' }, ['session:child'])).toMatchObject({ continued: false })
  expect(store.dispatch({ kind: 'executor' }, ['session:child'], { fresh: true })).toMatchObject({ continued: false })
})

it('a follow-up reopens the newest finished work of the same kind for the same executors, never on fresh, reply or unledgered (#615)', () => {
  const store = new AssistantWorkStore(root)
  const id = store.begin({ kind: 'executor' })
  store.confirm(id, ['session:child'], [])
  store.report('session:child', { work_id: id, status: 'completed' }, 'final')
  expect(store.list()).toEqual([])
  expect(store.dispatch({ kind: 'executor' }, ['session:other'])).toMatchObject({ continued: false })
  expect(store.dispatch({ kind: 'executor', purpose: 'reply' }, ['session:child'])).toMatchObject({ continued: false })
  expect(store.dispatch({ kind: 'executor' }, ['session:child'], { fresh: true })).toMatchObject({ continued: false })
  expect(store.dispatch({ kind: 'executor' }, ['session:child'], { ledgered: true })).toMatchObject({ continued: false })
  expect(store.dispatch({ kind: 'executor' }, ['session:child'])).toEqual({ id, continued: true })
  store.confirm(id, ['session:child'], ['follow-up'])
  expect(store.list()).toMatchObject([{ id, state: 'waiting', recipients: ['session:child'] }])
})
