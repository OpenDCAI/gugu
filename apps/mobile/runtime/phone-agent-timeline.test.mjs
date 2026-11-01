import { test } from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdtemp, mkdir, writeFile, appendFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createPhoneTimelineRuntime } from './phone-agent-timeline.mjs'
import { createPhoneTaskApi } from './phone-agent-task-api.mjs'

const stamp = (at) => new Date(at).toISOString()
const row = (id, parentId, at, message) => ({ type: 'message', id, parentId, timestamp: stamp(at), message: { ...message, timestamp: at } })
const line = (entry) => `${JSON.stringify(entry)}\n`
const assistant = (text) => ({ role: 'assistant', content: [{ type: 'text', text }], stopReason: 'stop' })

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'gugu-phone-timeline-'))
  const ownerId = randomUUID()
  const agent = { agentUserId: randomUUID(), sessionId: randomUUID(), contextEpoch: randomUUID(), modelId: 'first', status: 'idle' }
  const directory = join(root, agent.sessionId, agent.contextEpoch, 'sessions')
  await mkdir(directory, { recursive: true })
  const path = join(directory, `${stamp(1_700_000_000_000).replaceAll(':', '-')}_${randomUUID()}.jsonl`)
  const record = { path, contextEpoch: agent.contextEpoch }
  const store = { state: { ownerId, jobs: {}, agents: { [agent.agentUserId]: agent }, confirmations: {} }, save: async () => undefined }
  let permitted = true
  let deniedCode = 'not_granted'
  let authorizationError = null
  let revokeDuringRead = false
  let settlements = []
  const make = () => createPhoneTimelineRuntime({ root, store, authorize: async () => {
    if (authorizationError) throw authorizationError
    if (!permitted) throw Object.assign(new Error('日历授权已撤销'), { code: deniedCode })
    if (revokeDuringRead) { revokeDuringRead = false; queueMicrotask(() => { permitted = false }) }
  }, confirmations: () => settlements })
  let api = make()
  return { root, ownerId, agent, store, directory, path, record, get api() { return api },
    revoke: (code = 'not_granted') => { permitted = false; deniedCode = code }, restore: () => { permitted = true },
    failAuthorization: (error) => { authorizationError = error }, settlements: (next) => { settlements = next },
    revokeDuringRead: () => { revokeDuringRead = true },
    async write(entries) { await writeFile(path, line({ type: 'session', version: 3, id: randomUUID(), cwd: directory, timestamp: stamp(1_700_000_000_000) }) + entries.map(line).join('')); agent.record = record },
    async append(entries) { await appendFile(path, entries.map(line).join('')) },
    async reopen() { await api.close(); api = make() },
    async close() { await api.close(); await rm(root, { recursive: true, force: true }) },
  }
}

test('actual Pi JSONL uses the shared transcript, cursor increment, pagination and restart reset', async () => {
  const f = await fixture()
  const at = 1_700_000_000_000
  try {
    await f.write([row('u1', null, at, { role: 'user', content: '第一件任务' }), row('a1', 'u1', at + 1, assistant('第一件完成'))])
    const first = await f.api.snapshot(f.agent, { limit: 1 })
    assert.equal(first.turns.length, 1)
    assert.match(JSON.stringify(first.turns), /第一件任务/)
    assert.match(JSON.stringify(first.turns), /第一件完成/)
    assert.equal(first.turns[0].outcome.kind, 'done')
    assert.equal((await f.api.after(f.agent, { cursor: first.cursor })).batch.turns.length, 0)
    await f.append([row('u2', 'a1', at + 2, { role: 'user', content: '继续第二件' }), row('a2', 'u2', at + 3, assistant('第二件完成'))])
    const after = await f.api.after(f.agent, { cursor: first.cursor, trim: true })
    assert.equal(after.ok, true)
    assert.ok(after.batch.cursor.seq > first.cursor.seq)
    assert.match(JSON.stringify(after.batch.turns), /第二件完成/)
    const latest = await f.api.snapshot(f.agent, { limit: 1 })
    assert.equal(latest.hasOlder, true)
    const older = await f.api.older(f.agent, { beforeTurnId: latest.turns[0].id, limit: 1 })
    assert.match(JSON.stringify(older.turns), /第一件完成/)
    assert.equal(older.hasOlder, false)
    await f.reopen()
    const restart = await f.api.after(f.agent, { cursor: latest.cursor })
    assert.equal(restart.ok, false)
    assert.equal(restart.reset, 'epoch_changed')
    assert.match(JSON.stringify(restart.snapshot.turns), /第二件完成/)
    await assert.rejects(f.api.image(f.agent, { itemId: 'not-a-tool', index: 0 }), { code: 'no_such_item' })
    f.revoke()
    const hidden = await f.api.snapshot(f.agent, {})
    assert.match(JSON.stringify(hidden), /旧记录已隐藏/)
    assert.doesNotMatch(JSON.stringify(hidden), /第一件|第二件/)
  } finally { await f.close() }
})

test('live Pi deltas keep their shared timeline identity when the real JSONL takes over', async () => {
  const f = await fixture()
  const at = 1_700_000_000_000
  const job = { id: randomUUID(), agentUserId: f.agent.agentUserId, contextEpoch: f.agent.contextEpoch, prompt: '流式任务', status: 'running', createdAt: stamp(at - 1), startedAt: stamp(at - 1) }
  f.store.state.jobs[job.id] = job
  try {
    await f.write([row('u1', null, at, { role: 'user', content: job.prompt })])
    const initial = await f.api.snapshot(f.agent, {})
    f.api.live(f.agent, job, { kind: 'message', id: 'actual-live-message', at: at + 1 })
    f.api.live(f.agent, job, { kind: 'delta', id: 'actual-live-message', index: 0, textKind: 'text', text: '实时' })
    const first = await f.api.after(f.agent, { cursor: initial.cursor })
    assert.equal(first.ok, true)
    assert.match(JSON.stringify(first.batch.turns), /实时/)
    const streaming = await f.api.snapshot(f.agent, {})
    const itemIds = streaming.turns[0].items.map((item) => item.id)
    f.api.live(f.agent, job, { kind: 'delta', id: 'actual-live-message', index: 0, textKind: 'text', text: '回答' })
    const second = await f.api.after(f.agent, { cursor: streaming.cursor })
    assert.equal(second.ok, true)
    f.api.live(f.agent, job, { kind: 'complete', id: 'actual-live-message', at: at + 1, content: [{ type: 'text', text: '实时回答' }] })
    f.api.live(f.agent, job, { kind: 'committed', id: 'actual-live-message', recordId: 'a1' })
    await f.append([row('a1', 'u1', at + 1, assistant('实时回答'))])
    const disk = await f.api.after(f.agent, { cursor: second.batch.cursor })
    assert.equal(disk.ok, true)
    job.status = 'done'
    await f.api.finish(f.agent, job)
    const settled = await f.api.snapshot(f.agent, {})
    assert.deepEqual(settled.turns[0].items.map((item) => item.id), itemIds)
    assert.equal(settled.turns[0].outcome.kind, 'done')
    assert.equal(JSON.stringify(settled.turns).split('实时回答').length - 1, 1)
    await f.reopen()
    const recovered = await f.api.snapshot(f.agent, {})
    assert.match(JSON.stringify(recovered.turns), /实时回答/)
    assert.equal(recovered.turns[0].outcome.kind, 'done')
  } finally { await f.close() }
})

test('a real tool image is fetched from its Pi record instead of returning a placeholder', async () => {
  const f = await fixture()
  const at = 1_700_000_000_000
  try {
    await f.write([
      row('u1', null, at, { role: 'user', content: '看这张相册图片' }),
      row('a1', 'u1', at + 1, { role: 'assistant', content: [{ type: 'toolCall', id: 'actual-photo-tool', name: 'phone_call', arguments: { name: 'photos.read', args: { id: '1' } } }], stopReason: 'toolUse' }),
      row('t1', 'a1', at + 2, { role: 'toolResult', toolCallId: 'actual-photo-tool', content: [{ type: 'image', mimeType: 'image/png', data: 'aW1hZ2UtZml4dHVyZQ==' }], isError: false }),
      row('a2', 't1', at + 3, assistant('图片已读取')),
    ])
    const snapshot = await f.api.snapshot(f.agent, {})
    const serialized = JSON.stringify(snapshot)
    assert.match(serialized, /actual-photo-tool/)
    const find = (nodes) => nodes.flatMap((node) => [node, ...(node.children ? find(node.children) : [])]).find((node) => node.images?.length)
    const actual = find(snapshot.turns.flatMap((turn) => turn.items))
    assert.ok(actual)
    assert.deepEqual(await f.api.image(f.agent, { itemId: actual.id, index: 0 }), { mimeType: 'image/png', data: 'aW1hZ2UtZml4dHVyZQ==' })
    await assert.rejects(f.api.image(f.agent, { itemId: actual.id, index: 1 }), { code: 'no_such_image' })
  } finally { await f.close() }
})

test('revocation during asynchronous record loading prevents returning a previously permitted snapshot', async () => {
  const f = await fixture()
  try {
    await f.write([row('u1', null, 1_700_000_000_000, { role: 'user', content: '查询私密日历' }), row('a1', 'u1', 1_700_000_000_001, assistant('private-calendar-read-during-revoke'))])
    f.revokeDuringRead()
    const hidden = await f.api.snapshot(f.agent, {})
    assert.match(JSON.stringify(hidden), /旧记录已隐藏/)
    assert.doesNotMatch(JSON.stringify(hidden), /查询私密日历|private-calendar-read-during-revoke/)
  } finally { await f.close() }
})

test('explicit permission denial exposes only a stable notice timeline, resets old cursors, and restores the real record', async () => {
  for (const code of ['revoked', 'not_granted', 'os_permission']) {
    const f = await fixture()
    const at = 1_700_000_000_000
    const contextEpoch = f.agent.contextEpoch
    try {
      await f.write([
        row('u-private', null, at, { role: 'user', content: 'private-original-prompt' }),
        row('a-private', 'u-private', at + 1, { role: 'assistant', content: [{ type: 'toolCall', id: 'private-photo-tool', name: 'phone_call', arguments: { name: 'photos.read', args: { id: 'private-photo-id' } } }], stopReason: 'toolUse' }),
        row('t-private', 'a-private', at + 2, { role: 'toolResult', toolCallId: 'private-photo-tool', content: [{ type: 'image', mimeType: 'image/png', data: 'aW1hZ2UtZml4dHVyZQ==' }, { type: 'text', text: 'private-phone-result' }], isError: false }),
        row('done-private', 't-private', at + 3, assistant('private-assistant-result')),
      ])
      const id = randomUUID()
      const queued = { id, agentUserId: f.agent.agentUserId, contextEpoch, prompt: 'private-queued-prompt', status: 'queued', createdAt: stamp(at + 4), inputDataProof: { groups: ['photos'], permissionRequirements: [{ mediaRefs: [{ id: 'private-photo-id' }] }] } }
      f.store.state.jobs[id] = queued
      f.settlements([{ itemId: 'private-confirmation-id', kind: 'permission', title: 'private-approval-title', detail: 'private-approval-args', options: [{ optionId: 'approve', name: '允许', kind: 'allow_once' }], state: 'pending' }])
      const original = await f.api.snapshot(f.agent, {})
      assert.match(JSON.stringify(original), /private-phone-result|private-queued-prompt|private-approval-args/)
      f.revoke(code)
      const [hidden, concurrent] = await Promise.all([f.api.snapshot(f.agent, {}), f.api.snapshot(f.agent, { trim: true })])
      assert.match(JSON.stringify(hidden), /手机数据授权已改变，旧记录已隐藏。可以发送新的任务。/)
      assert.doesNotMatch(JSON.stringify(hidden), /private-|phone_call|photos\.read|aW1hZ2UtZml4dHVyZQ==/)
      assert.equal(hidden.turns.length, 1)
      assert.equal(hidden.turns[0].items.length, 1)
      assert.equal(hidden.turns[0].items[0].kind, 'session-notice')
      assert.deepEqual(hidden.queuedPrompts, [])
      assert.deepEqual(hidden.settlements, [])
      assert.equal(hidden.liveReply, null)
      assert.notEqual(hidden.cursor.epoch, original.cursor.epoch)
      assert.deepEqual(hidden.cursor, concurrent.cursor)
      const oldAfter = await f.api.after(f.agent, { cursor: original.cursor, trim: true })
      assert.equal(oldAfter.ok, false)
      assert.equal(oldAfter.reset, 'epoch_changed')
      assert.deepEqual(oldAfter.snapshot.cursor, hidden.cursor)
      assert.doesNotMatch(JSON.stringify(oldAfter), /private-|phone_call|photos\.read/)
      const unchanged = await f.api.after(f.agent, { cursor: hidden.cursor })
      assert.equal(unchanged.ok, true)
      assert.deepEqual(unchanged.batch.turns, [])
      assert.deepEqual(await f.api.older(f.agent, { beforeTurnId: original.turns[0].id }), { epoch: hidden.cursor.epoch, turns: [], hasOlder: false })
      await assert.rejects(f.api.image(f.agent, { itemId: 'private-photo-tool', index: 0 }), { code })
      assert.equal(f.agent.contextEpoch, contextEpoch)
      assert.equal(f.store.state.jobs[id], queued)
      assert.equal(queued.status, 'queued')
      f.restore()
      const recovered = await f.api.after(f.agent, { cursor: hidden.cursor })
      assert.equal(recovered.ok, false)
      assert.equal(recovered.reset, 'epoch_changed')
      assert.notEqual(recovered.snapshot.cursor.epoch, hidden.cursor.epoch)
      assert.notEqual(recovered.snapshot.cursor.epoch, original.cursor.epoch)
      assert.match(JSON.stringify(recovered.snapshot), /private-original-prompt/)
      assert.match(JSON.stringify(recovered.snapshot), /private-phone-result/)
      assert.match(JSON.stringify(recovered.snapshot), /private-queued-prompt/)
      assert.match(JSON.stringify(recovered.snapshot), /private-approval-args/)
      assert.doesNotMatch(JSON.stringify(recovered.snapshot), /旧记录已隐藏/)
      assert.equal(f.agent.contextEpoch, contextEpoch)
    } finally { await f.close() }
  }
})

test('unexpected authorization errors still fail instead of being mistaken for revoked data', async () => {
  const f = await fixture()
  try {
    await f.write([row('u1', null, 1_700_000_000_000, { role: 'user', content: '真实任务' })])
    const error = Object.assign(new Error('permission transport is unavailable'), { code: 'transport_failed' })
    f.failAuthorization(error)
    await assert.rejects(f.api.snapshot(f.agent, {}), (found) => found === error)
    await assert.rejects(f.api.after(f.agent, { cursor: { epoch: 'old', seq: 0 } }), (found) => found === error)
    await assert.rejects(f.api.older(f.agent, { beforeTurnId: 'old-turn' }), (found) => found === error)
  } finally { await f.close() }
})

test('queued admissions and pre-Pi failures are real host facts; a missing completed Pi record is an explicit failure', async () => {
  const f = await fixture()
  const id = randomUUID()
  try {
    f.store.state.jobs[id] = { id, agentUserId: f.agent.agentUserId, prompt: '还未开始的真实输入', status: 'queued', createdAt: stamp(1_700_000_000_000) }
    assert.deepEqual((await f.api.snapshot(f.agent, {})).queuedPrompts, [{ id, text: '还未开始的真实输入' }])
    Object.assign(f.store.state.jobs[id], { status: 'failed', startedAt: stamp(1_700_000_000_001), finishedAt: stamp(1_700_000_000_002), error: '模型票申请失败' })
    const failure = await f.api.snapshot(f.agent, {})
    assert.match(JSON.stringify(failure.turns), /还未开始的真实输入/)
    assert.match(JSON.stringify(failure.turns), /模型票申请失败/)
    assert.equal(failure.turns[0].outcome.kind, 'error')
    f.store.state.jobs[id].status = 'done'
    await assert.rejects(f.api.snapshot(f.agent, {}), { code: 'record_unreadable' })
  } finally { await f.close() }
})

test('interrupted Pi input closes honestly; settled approvals survive a timeline restart', async () => {
  const f = await fixture()
  const at = 1_700_000_000_000
  try {
    await f.write([row('u1', null, at, { role: 'user', content: '进程中断前的输入' })])
    const id = randomUUID()
    f.store.state.jobs[id] = { id, agentUserId: f.agent.agentUserId, contextEpoch: f.agent.contextEpoch, record: f.record, prompt: '进程中断前的输入', status: 'interrupted', createdAt: stamp(at - 2), startedAt: stamp(at - 1), finishedAt: stamp(at + 2), error: '进程被停止' }
    const pending = { itemId: randomUUID(), kind: 'permission', title: '允许创建这条日程吗？', detail: '固定原始参数', options: [{ optionId: 'approve', name: '允许这一次', kind: 'allow_once' }], state: 'pending', optionId: null, resolvedBy: null, resolvedAt: null }
    f.settlements([pending])
    const initial = await f.api.snapshot(f.agent, {})
    assert.equal(initial.turns[0].outcome.kind, 'error')
    assert.equal(initial.settlements[0].state, 'pending')
    f.settlements([{ ...pending, state: 'resolved', optionId: 'approve', resolvedBy: f.ownerId, resolvedAt: at + 3 }])
    assert.equal((await f.api.after(f.agent, { cursor: initial.cursor })).batch.settlements[0].state, 'resolved')
    await f.reopen()
    const reopened = await f.api.snapshot(f.agent, {})
    assert.equal(reopened.settlements[0].state, 'resolved')
    assert.equal(reopened.settlements[0].title, pending.title)
  } finally { await f.close() }
})

test('task input admission is idempotent across transport retries and checks immutable content before accepting', async () => {
  const f = await fixture()
  let admissions = 0
  const api = createPhoneTaskApi({ ownerId: f.ownerId, store: f.store, models: { catalog: async () => [{ id: 'first', display_name: '第一个模型' }], resolve: async (id) => id.slice(9) }, timelines: f.api,
    actions: () => ({}), findSession: (id) => { assert.equal(id, f.agent.sessionId); return f.agent }, verifyAgent: async () => undefined, publish: () => undefined,
    admit: async (job) => { if (!f.store.state.jobs[job.id]) { admissions++; f.store.state.jobs[job.id] = job } } })
  try {
    const input = { conversationId: f.agent.sessionId, text: '这是要受理的真实任务', clientRequestId: randomUUID() }
    const first = await api('sessionTimeline.sessionSend', [input], randomUUID())
    const second = await api('sessionTimeline.sessionSend', [input], randomUUID())
    assert.equal(first.value.accepted, true)
    assert.equal(first.value.messageId, second.value.messageId)
    assert.equal(admissions, 1)
    assert.equal(f.store.state.jobs[first.value.messageId].route.kind, 'task')
    await assert.rejects(api('sessionTimeline.sessionSend', [{ ...input, text: '换了任务却复用请求' }], randomUUID()), /不能更换任务内容/)
    const menu = (await api('sessionTimeline.sessionOptions', [{ conversationId: f.agent.sessionId }])).value
    assert.equal(menu.model.selected, 'platform:first')
    assert.equal(menu.mode, null)
    assert.equal(menu.modelMenu.ownCatalog, null)
    f.agent.status = 'working'
    await assert.rejects(api('sessionTimeline.sessionSetOption', [{ conversationId: f.agent.sessionId, dimension: 'model', value: 'platform:first' }]), { code: 'session_busy' })
  } finally { await f.close() }
})

test('file input projection survives a host restart and job cleanup, without changing unmatched native records', async () => {
  const f = await fixture(), at = 1_700_000_000_000;
  const files = [{ itemId: 'brief', version: 1, name: 'brief.txt', mimeType: 'text/plain', sizeBytes: 3 }];
  try {
    f.agent.fileInputs = { u1: { text: 'original caption', files } };
    await f.write([row('u1', null, at, { role: 'user', content: 'original caption\n\n[File saved at local path: /private/brief.txt]' }), row('a1', 'u1', at + 1, assistant('read it'))]);
    const check = async () => {
      const first = await f.api.snapshot(f.agent, {}), item = first.turns[0].items.find(item => item.kind === 'message' && item.role === 'user');
      assert.equal(item.text, 'original caption');
      assert.deepEqual(item.files, files);
      assert.doesNotMatch(JSON.stringify(first), /private|File saved/);
    };
    await check();
    f.store.state.jobs = {};
    f.agent.fileInputs = JSON.parse(JSON.stringify(f.agent.fileInputs));
    await f.reopen(); await check();
    await f.append([row('u2', 'a1', at + 2, { role: 'user', content: 'unmapped /original/native/path' }), row('a2', 'u2', at + 3, assistant('done'))]);
    assert.match(JSON.stringify(await f.api.snapshot(f.agent, {})), /unmapped \/original\/native\/path/);
    assert.deepEqual(Object.keys(f.agent.fileInputs), ['u1']);
  } finally { await f.close(); }
});
