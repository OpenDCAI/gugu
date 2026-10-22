import { test } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { Readable } from 'node:stream'
import { fetchPhoneWebPage, isPublicWebAddress, phoneWebTool, publicWebUrl, readableWebText } from './phone-agent-web.mjs'

const response = (body, headers = { 'content-type': 'text/html; charset=utf-8' }, statusCode = 200) => Object.assign(Readable.from([Buffer.from(body)]), { headers, statusCode })
const server = (...responses) => {
  const calls = []
  const requestPage = (url, options, callback) => {
    calls.push({ url, options })
    const req = new EventEmitter()
    req.end = () => queueMicrotask(() => callback(responses.shift()))
    return req
  }
  return { calls, requestPage, resolve: async () => [{ address: '93.184.215.14', family: 4 }] }
}

test('public web addresses reject local, reserved, mapped and alternate-protocol destinations', () => {
  for (const ip of ['127.0.0.1', '10.2.3.4', '172.16.0.1', '192.168.0.1', '169.254.169.254', '100.100.100.100', '0.0.0.0', '198.18.0.1', '::1', '::ffff:127.0.0.1', 'fc00::1', 'fe80::1', '2001:db8::1']) assert.equal(isPublicWebAddress(ip), false, ip)
  assert.equal(isPublicWebAddress('1.1.1.1'), true)
  assert.equal(isPublicWebAddress('2606:4700:4700::1111'), true)
  for (const url of ['file:///etc/passwd', 'http://example.com', 'https://u:p@example.com', 'https://example.com:8443', 'https://localhost', 'https://host.local', 'https://2130706433', 'https://127.1', 'https://[::1]']) assert.throws(() => publicWebUrl(url), undefined, url)
})

test('pins the validated DNS address for connection and returns bounded UTF-8 text without script instructions', async () => {
  const fake = server(response('<title>示例</title><script>steal()</script><p>你好 &amp; world</p><p>&#x1f600;</p>'))
  const result = await fetchPhoneWebPage('https://example.com/path#anchor', fake)
  assert.equal(result.url, 'https://example.com/path')
  assert.equal(result.text.includes('steal'), false)
  assert.match(result.text, /你好 & world/)
  assert.match(result.text, /😀/)
  await new Promise((resolve, reject) => fake.calls[0].options.lookup('example.com', { all: true }, (error, addresses) => {
    try { assert.ifError(error); assert.deepEqual(addresses, [{ address: '93.184.215.14', family: 4 }]); resolve() } catch (cause) { reject(cause) }
  }))
  assert.equal(fake.calls[0].options.headers.Cookie, undefined)
})

test('does not connect on mixed private DNS and does not follow a redirect into a local network', async () => {
  const mixed = server(response('unused'))
  await assert.rejects(fetchPhoneWebPage('https://example.com', { ...mixed, resolve: async () => [{ address: '1.1.1.1', family: 4 }, { address: '10.0.0.1', family: 4 }] }), { code: 'not_granted' })
  assert.equal(mixed.calls.length, 0)
  const redirect = server(response('', { location: 'https://192.168.1.1/secret' }, 302))
  await assert.rejects(fetchPhoneWebPage('https://example.com', redirect), { code: 'not_granted' })
  assert.equal(redirect.calls.length, 1)
})

test('rejects binary and oversized responses instead of handing incomplete content to the model', async () => {
  await assert.rejects(fetchPhoneWebPage('https://example.com', server(response('binary', { 'content-type': 'image/png' }))), { code: 'unsupported' })
  await assert.rejects(fetchPhoneWebPage('https://example.com', server(response('short', { 'content-type': 'text/plain', 'content-length': String(3 * 1024 * 1024) }))), { code: 'too_large' })
  await assert.rejects(fetchPhoneWebPage('https://example.com', server(response('a'.repeat(2 * 1024 * 1024 + 1), { 'content-type': 'text/plain' }))), { code: 'too_large' })
  assert.equal(readableWebText('a & b', false), 'a & b')
})

test('tool pages Unicode text and rechecks data authorization before delivering a page', async () => {
  const checks = []
  const job = { usedGroups: ['calendar'], permissionRequirements: [{ permission: 'calendar' }] }, agent = { sessionId: 'task' }
  const tool = phoneWebTool({ job, agent, authorize: async (...args) => { checks.push(args) }, fetchPage: async () => ({ url: 'https://example.com/', content_type: 'text/plain', text: 'a😀bc' }) })
  const first = await tool.execute('call', { url: 'https://example.com', limit: 1 })
  const result = await tool.execute('call', { url: 'https://example.com', offset: 1, limit: 2, snapshot_id: first.details.snapshot_id })
  assert.equal(result.details.text, '😀b')
  assert.equal(result.details.next_offset, 3)
  assert.equal(result.details.eof, false)
  assert.equal(checks.length, 4)
  let calls = 0
  const revoked = phoneWebTool({ job, agent, authorize: async () => { if (++calls === 2) throw Object.assign(new Error('revoked'), { code: 'revoked' }) }, fetchPage: async () => ({ text: 'private-derived output' }) })
  await assert.rejects(revoked.execute('call', { url: 'https://example.com' }), { code: 'revoked' })
  const controller = new AbortController(); controller.abort()
  await assert.rejects(fetchPhoneWebPage('https://example.com', { signal: controller.signal }), { name: 'AbortError' })
})

test('continued pages use one immutable response and reject a mismatched or expired version', async () => {
  let calls = 0
  const tool = phoneWebTool({ job: {}, agent: { sessionId: 'task' }, authorize: async () => {}, fetchPage: async () => ({ text: ++calls === 1 ? 'original-page' : 'changed-page' }) })
  const first = await tool.execute('first', { url: 'https://example.com', limit: 3 })
  const second = await tool.execute('next', { url: first.details.requested_url, offset: 3, snapshot_id: first.details.snapshot_id })
  assert.equal(second.details.text, 'ginal-page')
  assert.equal(calls, 1)
  await assert.rejects(tool.execute('bad-version', { url: 'https://example.com', offset: 3, snapshot_id: 'wrong' }), { code: 'web_snapshot_expired' })
  await assert.rejects(tool.execute('no-version', { url: 'https://example.com', offset: 3 }), { code: 'invalid_args' })
  assert.equal(readableWebText('<'.repeat(100_000), true), '<'.repeat(100_000))
  assert.equal(readableWebText('<script>'.repeat(100_000), true), '')
})
