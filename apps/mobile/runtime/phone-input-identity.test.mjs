import { test } from 'node:test'
import assert from 'node:assert/strict'
import { phoneInputIdentity } from './phone-input-identity.mjs'

test('the same client identity follows the derived job and its actual persisted Pi message', () => {
  const jobs = [{ id: 'derived-job', clientMessageId: 'original-client', inputRecordId: 'provider-record' }]
  const turns = [{ id: 'turn', items: [
    { kind: 'message', role: 'user', id: 'live:turn:0:message:phone-input:derived-job', text: 'caption' },
    { kind: 'message', role: 'user', id: 'stored:turn:1:message:pi:provider-record#0', text: 'caption' },
    { kind: 'message', role: 'assistant', id: 'answer', text: 'done' },
  ] }]
  const projected = phoneInputIdentity(turns, jobs)
  assert.equal(projected[0].items[0]._meta.guguClientMessageId, 'original-client')
  assert.equal(projected[0].items[1]._meta.guguClientMessageId, 'original-client')
  assert.equal(projected[0].items[2], turns[0].items[2])
  assert.equal(turns[0].items[0]._meta, undefined)
})

test('identical words never identify another job, while existing message metadata remains intact', () => {
  const turns = [{ items: [{ kind: 'message', role: 'user', id: 'pi:record-b#0', text: 'same', _meta: { existing: 'kept' } }] }]
  const jobs = [{ id: 'a', clientMessageId: 'client-a', inputRecordId: 'record-a' }, { id: 'b', clientMessageId: 'client-b', inputRecordId: 'record-b' }]
  assert.deepEqual(phoneInputIdentity(turns, jobs)[0].items[0]._meta, { existing: 'kept', guguClientMessageId: 'client-b' })
  assert.equal(phoneInputIdentity(turns, [jobs[0]])[0].items[0], turns[0].items[0])
})
