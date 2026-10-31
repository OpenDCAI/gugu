import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createPhoneAgentCloud } from './phone-agent-cloud.mjs'
import { createPhonePreparation } from './phone-agent-network.mjs'

const ownerId = '68a158dd-1832-4671-ac02-ebde330d3d7a'
const jwt = (claims, signature = 'one') => `${Buffer.from('{}').toString('base64url')}.${Buffer.from(JSON.stringify(claims)).toString('base64url')}.${signature}`
const now = Math.floor(Date.now() / 1000)
const claims = { sub: ownerId, iat: now, exp: now + 3600 }
const config = { ownerId, supabaseUrl: 'https://phone-host.invalid', supabaseAnonKey: 'public-anon', accessToken: jwt(claims), refreshToken: 'old-private-refresh' }
const response = (data, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } })

test('a real preparation fetch records its leaf operation and DNS cause, then retries without exposing credentials', async () => {
  let issues = 0
  const failures = []
  const cloud = createPhoneAgentCloud(config, () => undefined, async (url) => {
    if (String(url).endsWith('/auth/v1/user')) return response({ id: ownerId })
    if (++issues === 1) throw new TypeError('fetch failed', { cause: Object.assign(new Error('private URL and token'), { code: 'ENOTFOUND' }) })
    return response({ session_id: 'issued' })
  }, { onRequestFailure: value => failures.push(value) })
  try {
    await cloud.start()
    const prepare = createPhonePreparation({ signal: new AbortController().signal, retryDelayMs: 0, run: cloud.prepareRequest })
    assert.equal((await prepare('model-access.issue', () => cloud.modelAccess({ action: 'issue' }))).session_id, 'issued')
    assert.equal(issues, 2)
    assert.deepEqual(failures, [{ operation: 'model-access.issue', phase: 'preparing', category: 'dns', code: 'ENOTFOUND', retryable: true }])
    assert.doesNotMatch(JSON.stringify(failures), /private|https|token/)
  } finally { await cloud.close() }
})

test('a reset while reading the preparation response body retries the same request', async () => {
  let issues = 0
  const failures = []
  const cloud = createPhoneAgentCloud(config, () => undefined, async (url) => {
    if (String(url).endsWith('/auth/v1/user')) return response({ id: ownerId })
    if (++issues === 1) return new Response(new ReadableStream({ start(controller) {
      controller.error(Object.assign(new Error('private response details'), { code: 'ECONNRESET' }))
    } }))
    return response({ session_id: 'issued' })
  }, { onRequestFailure: value => failures.push(value) })
  try {
    await cloud.start()
    const prepare = createPhonePreparation({ signal: new AbortController().signal, retryDelayMs: 0, run: cloud.prepareRequest })
    assert.equal((await prepare('model-access.issue', () => cloud.modelAccess({ action: 'issue' }))).session_id, 'issued')
    assert.equal(issues, 2)
    assert.equal(failures[0].operation, 'model-access.issue')
    assert.equal(failures[0].category, 'connection_reset')
  } finally { await cloud.close() }
})

test('a model renewal timer does not inherit the expired preparation deadline', async () => {
  let later
  let renewSignal
  const cloud = createPhoneAgentCloud(config, () => undefined, async (url, options) => {
    if (String(url).endsWith('/auth/v1/user')) return response({ id: ownerId })
    renewSignal = options.signal
    return response({})
  })
  try {
    await cloud.start()
    await cloud.prepareRequest(() => {
      later = new Promise((resolve, reject) => setTimeout(() => cloud.modelAccess({ action: 'renew' }).then(resolve, reject), 30))
    }, { signal: AbortSignal.timeout(5), deadline: Date.now() + 5 })
    await later
    assert.equal(renewSignal.aborted, false)
  } finally { await cloud.close() }
})

test('one refresh authority accepts a same-second rotation and never reuses the retired refresh token', async () => {
  const events = []
  const calls = []
  let release
  const gate = new Promise((resolve) => { release = resolve })
  const next = { access_token: jwt(claims, 'two'), refresh_token: 'new-private-refresh', expires_at: claims.exp, user: { id: ownerId } }
  const cloud = createPhoneAgentCloud(config, (session) => { events.push(session) }, async (url, options) => {
    calls.push([String(url), options])
    if (String(url).endsWith('/auth/v1/user')) return response({ id: ownerId })
    if (String(url).includes('grant_type=refresh_token')) { await gate; return response(next) }
    throw new Error('unexpected network request')
  })
  try {
    await cloud.start()
    const one = cloud.session(config.refreshToken)
    const two = cloud.session(config.refreshToken)
    release()
    const result = await Promise.all([one, two])
    assert.equal(calls.filter(([url]) => url.includes('grant_type')).length, 1)
    assert.equal(result[0].access_token, next.access_token)
    assert.equal(result[1].refresh_token, next.refresh_token)
    assert.equal((await cloud.session(config.refreshToken)).refresh_token, next.refresh_token)
    assert.equal(calls.filter(([url]) => url.includes('grant_type')).length, 1)
    await cloud.configure(config)
    assert.equal((await cloud.session()).access_token, next.access_token)
    assert.equal(events.at(-1).refresh_token, next.refresh_token)
  } finally { await cloud.close() }
})

test('a token belonging to another owner is refused before any network call', async () => {
  let requests = 0
  const cloud = createPhoneAgentCloud({ ...config, accessToken: jwt({ ...claims, sub: '2c2ff4bc-1a13-4418-bbdb-7320e16f758b' }) }, () => undefined, async () => { requests++; throw new Error('must not fetch') })
  try { await assert.rejects(cloud.start(), /does not belong/); assert.equal(requests, 0) } finally { await cloud.close() }
})

test('logout uses the newest token, freezes refresh, and returns the full retired session', async () => {
  let logoutBearer
  const newest = jwt(claims, 'newest')
  const cloud = createPhoneAgentCloud(config, () => undefined, async (url, options) => {
    if (String(url).endsWith('/auth/v1/user')) return response({ id: ownerId })
    if (String(url).includes('grant_type')) return response({ access_token: newest, refresh_token: 'rotated', expires_at: claims.exp, user: { id: ownerId } })
    if (String(url).includes('/logout?scope=local')) { logoutBearer = options.headers.Authorization; return response({}) }
    throw new Error('unexpected network request')
  })
  try {
    await cloud.start(); await cloud.session(config.refreshToken)
    const session = await cloud.signOut()
    assert.equal(logoutBearer, `Bearer ${newest}`)
    assert.equal(session.refresh_token, 'rotated')
    await assert.rejects(cloud.token(), /paused/)
  } finally { await cloud.close() }
})

test('an expired saved access token is recovered through its refresh token before owner verification', async () => {
  const urls = []
  const cloud = createPhoneAgentCloud({ ...config, accessToken: jwt({ ...claims, exp: now - 1 }) }, () => undefined, async (url) => {
    urls.push(String(url))
    return response({ access_token: jwt(claims, 'fresh'), refresh_token: 'fresh-refresh', expires_at: claims.exp, user: { id: ownerId } })
  })
  try {
    const session = await cloud.start()
    assert.equal(session.refresh_token, 'fresh-refresh')
    assert.equal(urls.length, 1)
    assert.match(urls[0], /grant_type=refresh_token/)
  } finally { await cloud.close() }
})

test('a permanent GoTrue refusal preserves its original code and never keeps retrying the dead token', async () => {
  let refreshes = 0
  const cloud = createPhoneAgentCloud(config, () => undefined, async (url) => {
    if (String(url).endsWith('/auth/v1/user')) return response({ id: ownerId })
    refreshes++
    return response({ error_code: 'refresh_token_already_used', msg: 'Refresh Token has already been used' }, 400)
  })
  try {
    await cloud.start()
    await assert.rejects(cloud.session(config.refreshToken), (error) => error.code === 'refresh_token_already_used' && error.status === 400 && error.permanent === true)
    await assert.rejects(cloud.token(), (error) => error.code === 'refresh_token_already_used')
    assert.equal(refreshes, 1)
  } finally { await cloud.close() }
})

test('a temporary auth service failure retains the session and a later refresh can recover it', async () => {
  let refreshes = 0
  const cloud = createPhoneAgentCloud(config, () => undefined, async (url) => {
    if (String(url).endsWith('/auth/v1/user')) return response({ id: ownerId })
    if (++refreshes === 1) return response({ message: 'temporary auth outage' }, 503)
    return response({ access_token: jwt(claims, 'recovered'), refresh_token: 'recovered-refresh', expires_at: claims.exp, user: { id: ownerId } })
  })
  try {
    await cloud.start()
    await assert.rejects(cloud.session(config.refreshToken), (error) => error.status === 503 && error.permanent === false)
    assert.equal((await cloud.session(config.refreshToken)).refresh_token, 'recovered-refresh')
  } finally { await cloud.close() }
})
