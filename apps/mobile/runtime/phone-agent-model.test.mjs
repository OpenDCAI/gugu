import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createPhoneModelAccess } from './phone-agent-model.mjs'

test('the issuer relay root preserves its gateway prefix and targets the shared OpenAI protocol endpoint', async () => {
  const access = createPhoneModelAccess({ modelAccess: async (request) => request.action === 'issue' ? { session_id: 'protocol-lease', relay_url: 'https://models.invalid/gateway/', token: 'private-short-lived', model: 'free', protocol: 'openai-chat-completions', expires_at: new Date(Date.now() + 600_000).toISOString() } : {} }, { state: { leases: {} }, save: async () => undefined }, () => undefined)
  const lease = await access.issue({ agentUserId: 'real-agent', sessionId: 'real-session', modelId: 'free' })
  try {
    assert.equal(lease.model.baseUrl, 'https://models.invalid/gateway/v1')
    assert.equal(new URL(`${lease.model.baseUrl}/chat/completions`).pathname, '/gateway/v1/chat/completions')
  } finally { await lease.close() }
})

test('only supported platform models are offered; explicit member models are decided by the issuer', async () => {
  const models = [{ id: 'free', enabled: true, protocols: ['openai-chat-completions'] }, { id: 'member', enabled: true, requires_membership: true, protocols: ['openai-chat-completions'] }, { id: 'wrong-wire', enabled: true, protocols: ['anthropic-messages'] }, { id: 'hidden', enabled: true, hidden: true, protocols: ['openai-chat-completions'] }]
  const access = createPhoneModelAccess({ modelAccess: async () => ({ models }) }, { state: { leases: {} }, save: async () => undefined }, () => undefined)
  assert.deepEqual((await access.catalog()).map((item) => item.id), ['free', 'member'])
  assert.equal(await access.resolve(), 'free')
  assert.equal(await access.resolve('platform:member'), 'member')
  await assert.rejects(access.resolve('member'), /platform:/)
  await assert.rejects(access.resolve('platform:wrong-wire'), /不支持/)
})

test('issued token is scoped to the real agent/session and every finished turn checkpoints then revokes it', async () => {
  const requests = []
  const store = { state: { leases: {} }, save: async () => undefined }
  const access = createPhoneModelAccess({ modelAccess: async (request) => {
    requests.push(request)
    return request.action === 'issue' ? { session_id: 'issued-lease', relay_url: 'https://models.invalid', token: 'private-short-lived', model: 'model-alias', protocol: 'openai-chat-completions', expires_at: new Date(Date.now() + 600_000).toISOString() } : {}
  } }, store, () => undefined)
  const lease = await access.issue({ agentUserId: 'real-agent', sessionId: 'real-session', modelId: 'free' })
  assert.deepEqual(requests[0], { action: 'issue', agent_user_id: 'real-agent', engine_id: 'pi', model_id: 'free', protocol: 'openai-chat-completions', provider_session_id: 'real-session' })
  assert.equal(lease.model.apiKey, 'private-short-lived')
  assert.equal(JSON.stringify(store.state).includes('private-short-lived'), false)
  await lease.close()
  assert.deepEqual(requests.map((item) => item.action), ['issue', 'checkpoint', 'revoke'])
  assert.deepEqual(store.state.leases, {})
})
