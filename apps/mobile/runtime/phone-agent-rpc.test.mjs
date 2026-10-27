import { test } from 'node:test'
import assert from 'node:assert/strict'
import { startPhoneAgentRpc } from './phone-agent-rpc.mjs'
import { REMOTE_PROTOCOL_VERSION } from '../../../packages/core/src/cloud/serverMachineHealth.ts'

const ownerId = '68a158dd-1832-4671-ac02-ebde330d3d7a'
const deviceId = 'phone-rpc-recovery-fixture'
const sharedName = `gugu:${deviceId}:rpc`
const commandsName = `gugu:${deviceId}:commands`
const flush = () => new Promise((resolve) => setImmediate(resolve))
const advance = async (t, ms) => { t.mock.timers.tick(ms); await flush() }

/** Drive the production adapter through the same channel/token surface supplied by supabase-js. */
function fixture({ autoSubscribe = () => true, onCommand = async () => undefined } = {}) {
  const channels = []
  const connectivity = []
  const warnings = []
  const invocations = []
  let ticks = 0
  let deviceRuns = 0
  const cloud = {
    token: async () => 'owner-token',
    client: {
      channel(name, options) {
        const bindings = []
        const channel = {
          name, options, removed: false, sent: [],
          on(type, filter, handler) { bindings.push({ type, filter, handler }); return channel },
          subscribe(callback) {
            channel.callback = callback
            if (autoSubscribe(name, channels.filter((entry) => entry.name === name).length)) queueMicrotask(() => callback('SUBSCRIBED'))
            return channel
          },
          status(status, error) { channel.callback(status, error) },
          broadcast(payload, event = 'broadcast') {
            for (const binding of bindings) if (binding.type === 'broadcast' && binding.filter.event === event) binding.handler({ payload })
          },
          async send(message) { channel.sent.push(message); return 'ok' },
          teardown() { channel.tornDown = true },
        }
        channels.push(channel)
        return channel
      },
      async removeChannel(channel) { channel.removed = true; channel.status('CLOSED'); channel.teardown(); return 'ok' },
    },
  }
  const starting = startPhoneAgentRpc({
    cloud, ownerId, deviceId,
    invoke: async (...args) => { invocations.push(args); return { accepted: true } },
    provider: { manifest: () => [], permit: () => ({ ok: true }), run: async () => { deviceRuns++; return { ok: true } } },
    onCommand: async () => { ticks++; return onCommand() },
    onConnectivity: (connected) => connectivity.push(connected), warn: (message) => warnings.push(message),
  })
  return { cloud, channels, connectivity, warnings, invocations, starting, deviceRuns: () => deviceRuns, ticks: () => ticks, named: (name) => channels.filter((channel) => channel.name === name) }
}

test('terminal CLOSED rebuilds both persistent channels once and ignores retired/duplicate callbacks', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] })
  const fx = fixture()
  const rpc = await fx.starting
  try {
    const shared = fx.named(sharedName)[0]
    const commands = fx.named(commandsName)[0]
    assert.deepEqual(fx.connectivity, [true])
    shared.status('CLOSED')
    assert.equal(fx.connectivity.at(-1), false)
    commands.status('CLOSED')
    shared.status('CLOSED'); shared.status('TIMED_OUT'); commands.status('CLOSED')
    await flush()
    await advance(t, 999)
    assert.equal(fx.channels.length, 2)
    await advance(t, 1)
    assert.equal(fx.named(sharedName).length, 2)
    assert.equal(fx.named(commandsName).length, 2)
    assert.deepEqual(fx.connectivity, [true, false, true])
    assert.equal(fx.ticks(), 2)
    assert.equal(fx.invocations.length, 0)
    const replacement = fx.named(sharedName)[1]
    assert.equal(replacement.options.config.private, true)
    assert.equal(replacement.sent.filter((message) => message.payload.type === 'taskhost.ready').length, 1)
    shared.status('SUBSCRIBED'); shared.status('CLOSED')
    commands.status('SUBSCRIBED'); commands.broadcast({}, 'command_created')
    replacement.status('SUBSCRIBED'); replacement.status('SUBSCRIBED')
    fx.named(commandsName)[1].status('SUBSCRIBED')
    await advance(t, 5_000)
    assert.equal(fx.channels.length, 4)
    assert.equal(fx.ticks(), 2)
    assert.equal(fx.invocations.length, 0)
    assert.equal(fx.channels.filter((channel) => !channel.removed).length, 2)
  } finally { await rpc.close() }
})

test('SDK CHANNEL_ERROR/TIMED_OUT recovery keeps its channel and waits for both endpoints', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] })
  const fx = fixture()
  const rpc = await fx.starting
  try {
    const shared = fx.named(sharedName)[0]
    const commands = fx.named(commandsName)[0]
    shared.status('CHANNEL_ERROR', new Error('socket interrupted'))
    commands.status('TIMED_OUT')
    await advance(t, 30_000)
    assert.equal(fx.channels.length, 2)
    assert.equal(fx.connectivity.at(-1), false)
    shared.status('SUBSCRIBED')
    assert.equal(fx.connectivity.at(-1), false)
    commands.status('SUBSCRIBED')
    await flush()
    assert.equal(fx.connectivity.at(-1), true)
    assert.equal(fx.ticks(), 2)
    assert.equal(fx.invocations.length, 0)
  } finally { await rpc.close() }
})

test('failed replacements stay disconnected with one attempt and capped exponential backoff', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] })
  const fx = fixture({ autoSubscribe: (name, attempt) => name !== sharedName || attempt === 1 })
  const rpc = await fx.starting
  try {
    fx.named(sharedName)[0].status('CLOSED')
    await flush(); await advance(t, 1_000)
    const failed = fx.named(sharedName)[1]
    failed.status('CHANNEL_ERROR'); failed.status('TIMED_OUT')
    await advance(t, 14_999)
    assert.equal(fx.named(sharedName).length, 2)
    await advance(t, 1)
    for (const delay of [2_000, 4_000, 8_000, 16_000, 30_000, 30_000]) {
      const before = fx.named(sharedName).length
      await advance(t, delay - 1)
      assert.equal(fx.named(sharedName).length, before)
      assert.equal(fx.connectivity.at(-1), false)
      await advance(t, 1)
      assert.equal(fx.named(sharedName).length, before + 1)
      assert.equal(fx.named(sharedName).filter((channel) => !channel.removed).length, 1)
      fx.named(sharedName).at(-1).status('CLOSED')
      await flush()
    }
    assert.equal(fx.ticks(), 0)
    assert.equal(fx.invocations.length, 0)
  } finally { await rpc.close() }
})

test('explicit close cancels replacement timers and retired callbacks cannot reconnect', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] })
  const fx = fixture()
  const rpc = await fx.starting
  fx.named(sharedName)[0].status('CLOSED')
  await flush()
  await rpc.close()
  for (const channel of fx.channels) { channel.status('SUBSCRIBED'); channel.status('CLOSED'); channel.broadcast({}, 'command_created') }
  await advance(t, 3_600_000)
  assert.equal(fx.channels.length, 2)
  assert.equal(fx.channels.every((channel) => channel.removed), true)
  assert.equal(fx.ticks(), 0)
  assert.equal(fx.invocations.length, 0)
  assert.equal(fx.connectivity.at(-1), false)
})

test('closing while replacement authentication is pending prevents a late channel from opening', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] })
  const fx = fixture()
  const rpc = await fx.starting
  let release
  fx.cloud.token = () => new Promise((resolve) => { release = resolve })
  fx.named(sharedName)[0].status('CLOSED')
  await flush(); await advance(t, 1_000)
  assert.equal(typeof release, 'function')
  await rpc.close()
  release('late-token')
  await flush(); await advance(t, 60_000)
  assert.equal(fx.channels.length, 2)
  assert.equal(fx.channels.every((channel) => channel.removed), true)
  assert.equal(fx.connectivity.at(-1), false)
})

for (const endpoint of [sharedName, commandsName]) test(`initial ${endpoint} timeout rejects startup and cleans every owned subscription`, async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] })
  const fx = fixture({ autoSubscribe: (name) => name !== endpoint })
  const failed = assert.rejects(fx.starting, /subscription timed out/)
  await flush(); await advance(t, 15_000); await failed
  assert.equal(fx.channels.every((channel) => channel.removed), true)
  const before = fx.channels.length
  for (const channel of fx.channels) channel.status('SUBSCRIBED')
  await advance(t, 60_000)
  assert.equal(fx.channels.length, before)
  assert.equal(fx.connectivity.at(-1), false)
})

test('temporary peer and outbound requester channels close without their own replacement loops', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] })
  const fx = fixture()
  const rpc = await fx.starting
  try {
    const shared = fx.named(sharedName)[0]
    shared.broadcast({ type: 'taskhost.attach', request_id: 'attach-fixture', user_id: ownerId, payload: { asker: 'peer_fixture', protocol: REMOTE_PROTOCOL_VERSION } })
    await flush()
    const peerName = `${sharedName}:peer_fixture`
    const peer = fx.named(peerName)[0]
    const request = { type: 'taskhost.call', request_id: 'stable-task-request', user_id: ownerId, payload: { channel: 'agentSession.message', args: [] } }
    peer.broadcast(request); peer.broadcast(request)
    await flush()
    assert.equal(fx.invocations.length, 1)
    await rpc.requester.open('outbound-fixture')
    const outboundName = 'gugu:outbound-fixture:rpc'
    peer.status('CLOSED'); fx.named(outboundName)[0].status('CLOSED')
    await flush(); await advance(t, 180_000)
    assert.equal(fx.named(peerName).length, 1)
    assert.equal(fx.named(outboundName).length, 1)
    assert.equal(peer.removed, true)
    assert.equal(fx.named(outboundName)[0].removed, true)
    assert.equal(fx.invocations.length, 1)
    assert.equal(fx.connectivity.at(-1), true)
  } finally { await rpc.close() }
})

test('recovery tick and ready-broadcast failures are logged without losing the recovered channel', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] })
  const fx = fixture({ onCommand: async () => { throw new Error('tick unavailable') }, autoSubscribe: (name, attempt) => name !== sharedName || attempt === 1 })
  const rpc = await fx.starting
  try {
    fx.named(sharedName)[0].status('CLOSED')
    await flush(); await advance(t, 1_000)
    const replacement = fx.named(sharedName)[1]
    replacement.send = async () => { throw new Error('ready send unavailable') }
    replacement.status('SUBSCRIBED')
    await flush()
    assert.equal(fx.connectivity.at(-1), true)
    assert.equal(fx.warnings.some((message) => message.includes('tick unavailable')), true)
    assert.equal(fx.warnings.some((message) => message.includes('ready send unavailable')), true)
    assert.equal(fx.ticks(), 1)
  } finally { await rpc.close() }
})


test('remote actions and result acknowledgments cannot reuse a control reply or reach the local provider',async()=>{
  const fx=fixture(),rpc=await fx.starting
  try {
    fx.named(sharedName)[0].broadcast({type:'taskhost.attach',request_id:'attach',user_id:ownerId,payload:{asker:'remoteAgent123',protocol:REMOTE_PROTOCOL_VERSION}})
    await flush();await flush()
    const peer=fx.named(sharedName+':remoteAgent123')[0]
    peer.broadcast({type:'taskhost.call',request_id:'reused',user_id:ownerId,payload:{channel:'agentSession.get',args:[]}})
    await flush();await flush()
    assert.equal(fx.invocations.length,1,'control traffic is still allowed')
    for(const type of ['device.action','device.action.result_ack']) {
      peer.broadcast({type,request_id:'reused',user_id:ownerId,payload:{v:1,call_id:'x',action:'calendar.events.list',caller:{deviceId}}})
      await flush();await flush()
      assert.equal(peer.sent.at(-1).payload.error.code,'device_scope_mismatch')
      assert.match(peer.sent.at(-1).payload.error.message,new RegExp('device:'+deviceId))
    }
    assert.equal(fx.deviceRuns(),0)
  } finally { await rpc.close() }
})

test('the account work receiver has its own private peer operation',async()=>{
  const fx=fixture(),rpc=await fx.starting
  try{
    fx.named(sharedName)[0].broadcast({type:'taskhost.attach',request_id:'attach-work',user_id:ownerId,payload:{asker:'work_peer',protocol:REMOTE_PROTOCOL_VERSION}})
    await flush()
    const ref={assistant_id:'assistant',work_id:'work',message_id:'message'}
    fx.named(`${sharedName}:work_peer`)[0].broadcast({type:'assistantWork.deliver',request_id:'work-request',user_id:ownerId,payload:ref})
    await flush()
    assert.equal(fx.invocations[0]?.[0],'assistantWork.deliver')
    assert.deepEqual(fx.invocations[0]?.[1],[ref])
  }finally{await rpc.close()}
})
