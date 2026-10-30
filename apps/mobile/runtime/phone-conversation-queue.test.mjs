import { test } from 'node:test'
import assert from 'node:assert/strict'
import { changePhoneConversationQueue } from './phone-conversation-queue.mjs'

function fixture() {
  const jobs = Object.fromEntries([
    { id: 'a', agentUserId: 'mine', status: 'queued', prompt: 'first', createdAt: 'old', inputFingerprint: 'original' },
    { id: 'foreign', agentUserId: 'other', status: 'queued', prompt: 'other' },
    { id: 'b', agentUserId: 'mine', status: 'queued', prompt: 'second' },
  ].map(job => [job.id, job]))
  let saves = 0, interrupts = 0
  const store = { state: { jobs }, save: async () => { saves++ } }
  return { store, args: { store, agent: { agentUserId: 'mine' }, publish() {}, interrupt: async () => { interrupts++ } }, stats: () => ({ saves, interrupts }) }
}

test('native queue edits reserve the entry and retain the original request identity', async () => {
  const fx = fixture(), queueEdit = { draftText: 'editing', originalDraftText: 'draft' }
  await changePhoneConversationQueue({ ...fx.args, action: { kind: 'edit', id: 'a', text: 'edited', queueEdit } })
  assert.equal(fx.store.state.jobs.a.prompt, 'edited')
  assert.equal(fx.store.state.jobs.a.inputFingerprint, 'original')
  assert.equal(fx.store.state.jobs.a.createdAt, 'old')
  assert.deepEqual(fx.store.state.jobs.a.queueEdit, queueEdit)
})

test('native queue order changes without touching another agent slot', async () => {
  const fx = fixture()
  await changePhoneConversationQueue({ ...fx.args, action: { kind: 'reorder', ids: ['b', 'a'] } })
  assert.deepEqual(Object.keys(fx.store.state.jobs), ['b', 'foreign', 'a'])
  assert.equal(fx.store.state.jobs.foreign.prompt, 'other')
})

test('send now interrupts only the verified target and preserves other queued messages', async () => {
  const fx = fixture()
  await changePhoneConversationQueue({ ...fx.args, action: { kind: 'send-now', id: 'b', steers: false } })
  assert.deepEqual(Object.keys(fx.store.state.jobs), ['b', 'foreign', 'a'])
  assert.equal(fx.store.state.jobs.a.status, 'queued')
  assert.deepEqual(fx.stats(), { saves: 1, interrupts: 1 })
})

test('cross-agent, stale, duplicate and malformed mutations fail before save', async () => {
  const fx = fixture()
  for (const action of [{ kind: 'delete', id: 'foreign' }, { kind: 'delete', id: 'gone' }, { kind: 'reorder', ids: ['a', 'a'] }, { kind: 'reorder' }, { kind: 'unknown', id: 'a' }]) {
    await assert.rejects(changePhoneConversationQueue({ ...fx.args, action }))
  }
  assert.deepEqual(fx.stats(), { saves: 0, interrupts: 0 })
  assert.deepEqual(Object.keys(fx.store.state.jobs), ['a', 'foreign', 'b'])
})
