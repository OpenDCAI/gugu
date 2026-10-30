import { test as nodeTest } from 'node:test'
import assert from 'node:assert/strict'
import { openProjectionVideo } from '../web/viewer.mjs'

const test = (name, run) => nodeTest(name, { timeout: 2000 }, run)

// State-machine fixtures; actual browser/decoder coverage is in host-browser.node-test.mjs.
const fixture = (t, options = {}) => {
  let callback, stopped = 0
  const peers = []
  const previous = new Map(['RTCPeerConnection', 'MediaStream'].map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]))
  t.after(() => { for (const [key, descriptor] of previous) {
    if (descriptor) Object.defineProperty(globalThis, key, descriptor); else delete globalThis[key]
  } })
  const channel = { label: 'gugu-projection-input', ordered: true, maxRetransmits: null, maxPacketLifeTime: null,
    readyState: 'open', bufferedAmount: 0, sent: [],
    close() { this.readyState = 'closed'; this.onclose?.() }, send(raw) { this.sent.push(raw) }, ...options.channel }
  globalThis.RTCPeerConnection = class {
    constructor(config) { peers.push(this); this.config = config; this.iceGatheringState = 'complete' }
    async setRemoteDescription() {}
    async createAnswer() { return { type: 'answer', sdp: 'fixture-answer' } }
    async setLocalDescription(description) { this.localDescription = description; this.ondatachannel({ channel }) }
    close() { this.closed = true }
  }
  globalThis.MediaStream = class { constructor(tracks) { this.tracks = tracks } }
  const video = { srcObject: null, play: async () => {},
    requestVideoFrameCallback(fn) { callback = fn; return 1 }, cancelVideoFrameCallback() { callback = undefined } }
  const frames = [], controls = []
  const starting = openProjectionVideo({ video, offer: { type: 'offer', sdp: 'fixture-offer' },
    answer: options.answer ?? (async () => {}), onFrame: frame => frames.push(frame), onControl: raw => controls.push(raw), ...options })
  t.after(async () => { const media = await starting.catch(() => undefined); media?.close() })
  return { starting, video, channel, frames, controls,
    peer: () => peers[0], stopped: () => stopped,
    track() { peers[0].ontrack({ track: { kind: 'video', stop() { stopped++ } } }) },
    paint(stamp) { assert.ok(callback); callback(0, { rtpTimestamp: stamp, width: 128, height: 96 }) },
    message(value) { channel.onmessage({ data: typeof value === 'string' ? value : JSON.stringify(value) }) },
  }
}
const frame = (sequence, stamp = sequence) => ({ type: 'frame', frame: { sequence, rtpTimestamp: stamp, width: 128, height: 96 } })

test('viewer matches the current decoded RTP timestamp, invalidates replaced pictures and ignores late receipts', async t => {
  const view = fixture(t)
  const media = await view.starting
  assert.deepEqual(view.peer().config.iceServers, [])
  view.paint(100)
  view.paint(200)
  view.message(frame(1, 100))
  assert.deepEqual(view.frames, [null, null]) // old decoded picture is already gone
  view.message(frame(2, 200))
  assert.deepEqual(view.frames.at(-1), frame(2, 200).frame)
  view.paint(300)
  assert.equal(view.frames.at(-1), null) // cannot keep admitting input against frame 2
  view.message(frame(3, 300))
  assert.equal(view.frames.at(-1).sequence, 3)
  media.close()
  await media.closed
})

test('viewer admits direct Unicode control with a bounded byte queue and never labels it applied', async t => {
  const view = fixture(t)
  const media = await view.starting
  assert.equal(media.sendControl('中文'), undefined)
  assert.deepEqual(view.channel.sent, ['中文'])
  assert.throws(() => media.sendControl('界'.repeat(6000)), /Invalid/)
  view.channel.bufferedAmount = 256 * 1024 + 1
  assert.throws(() => media.sendControl('retry'), /not writable/)
  view.message('{"result":"unknown"}')
  assert.deepEqual(view.controls, ['{"result":"unknown"}'])
})

test('viewer signs in order and never sends an unsigned or late control after page cancellation', async t => {
  let release, calls = 0
  const gate = new Promise(resolve => { release = resolve })
  const controller = new AbortController()
  const view = fixture(t, { signal: controller.signal, prepareControl: async (raw, signal) => {
    calls++; if (calls === 1) await gate
    signal.throwIfAborted(); return `signed:${raw}`
  } })
  const media = await view.starting
  const first = media.sendControl('ack'), second = media.sendControl('中文')
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(calls, 1); assert.deepEqual(view.channel.sent, [])
  release(); await Promise.all([first, second])
  assert.deepEqual(view.channel.sent, ['signed:ack', 'signed:中文'])
  controller.abort(new Error('Page retargeted'))
  assert.throws(() => media.sendControl('late'), /retargeted/)
})

test('viewer aborts an in-flight signer and bounds pending signing work', async t => {
  let signing
  const controller = new AbortController()
  const view = fixture(t, { signal: controller.signal, prepareControl: (_raw, signal) => {
    signing = signal; return new Promise(() => {})
  } })
  const media = await view.starting
  const pending = Array.from({ length: 64 }, () => media.sendControl('ack').catch(error => error))
  assert.throws(() => media.sendControl('overflow'), /queue is full/)
  await new Promise(resolve => setImmediate(resolve))
  controller.abort(new Error('Page left'))
  assert.equal(signing.aborted, true)
  const errors = await Promise.all(pending)
  assert.ok(errors.every(error => /Page left/.test(error.message)))
  assert.deepEqual(view.channel.sent, [])
})

test('viewer rejects unreliable channels, binary controls, oversized text and unassociated receipts', async t => {
  for (const kind of ['unordered', 'limited-retry', 'wrong-label', 'binary', 'oversized', 'old-sequence', 'wrong-geometry']) {
    await t.test(kind, async t => {
      const channel = kind === 'unordered' ? { ordered: false } : kind === 'limited-retry' ? { maxRetransmits: 0 }
        : kind === 'wrong-label' ? { label: 'foreign' } : {}
      const view = fixture(t, { channel })
      if (Object.keys(channel).length) { await assert.rejects(view.starting, /Unexpected projection input channel/); return }
      const media = await view.starting
      if (kind === 'binary') view.channel.onmessage({ data: new ArrayBuffer(1) })
      else if (kind === 'oversized') view.message('a'.repeat(16 * 1024 + 1))
      else if (kind === 'old-sequence') { view.message(frame(2)); view.message(frame(1)) }
      else { view.message({ type: 'frame', frame: { ...frame(1).frame, width: 126 } }); view.paint(1) }
      await assert.rejects(media.closed, /Invalid projection|does not match/)
      assert.equal(view.peer().closed, true)
      assert.equal(view.video.srcObject, null)
    })
  }
})

test('viewer cancellation settles a stalled signaling callback and stops its own track', async t => {
  const lifetime = new AbortController()
  let reached
  const answering = new Promise(resolve => { reached = resolve })
  const view = fixture(t, { signal: lifetime.signal, answer: () => { reached(); return new Promise(() => {}) } })
  await answering
  view.track()
  lifetime.abort(new Error('page retargeted'))
  await assert.rejects(view.starting, /page retargeted/)
  assert.equal(view.stopped(), 1)
  assert.equal(view.peer().closed, true)
  assert.equal(view.video.srcObject, null)
})

test('viewer cleanup still settles if a drawing consumer throws', async t => {
  const view = fixture(t, { onFrame: () => { throw new Error('draw failed') } })
  const media = await view.starting
  view.paint(1)
  await assert.rejects(media.closed, /draw failed/)
  assert.equal(view.peer().closed, true)
})

test('viewer callbacks can reply while the answer callback has not returned yet', async t => {
  let release, reached
  const entered = new Promise(resolve => { reached = resolve })
  const waiting = new Promise(resolve => { release = resolve })
  const view = fixture(t, { answer: () => { reached(); return waiting }, onControl: (raw, send) => send(`ack:${raw}`) })
  t.after(release)
  await entered
  view.message('early')
  assert.deepEqual(view.channel.sent, ['ack:early'])
  release()
  await view.starting
})

test('viewer invalidates the picture on disconnect and rejects missing decoder metadata', async t => {
  for (const reason of ['disconnected', 'missing-metadata']) await t.test(reason, async t => {
    const view = fixture(t)
    const media = await view.starting
    view.message(frame(1))
    view.paint(1)
    if (reason === 'disconnected') { view.peer().connectionState = 'disconnected'; view.peer().onconnectionstatechange() }
    else view.paint(undefined)
    await assert.rejects(media.closed, /connection closed|omitted frame/)
    assert.equal(view.frames.at(-1), null)
    assert.throws(() => media.sendControl('stale'), /connection closed|omitted frame/)
  })
})


test('recovery receipts match a new decoded timestamp for the same source without accepting stale pictures', async t => {
  const view=fixture(t)
  const media=await view.starting
  view.message(frame(1,100))
  view.message({type:'frame',frame:{...frame(1,200).frame,recovery:true}})
  assert.notEqual(view.peer().closed,true,'a valid same-source recovery closed the viewer')
  view.paint(100)
  assert.equal(view.frames.at(-1),null)
  view.paint(200)
  assert.deepEqual(view.frames.at(-1),{...frame(1,200).frame,recovery:true})
  view.message({type:'frame',frame:{...frame(1,300).frame,recovery:true}})
  view.paint(300)
  assert.deepEqual(view.frames.at(-1),{...frame(1,300).frame,recovery:true})
  view.message(frame(2,400)); view.paint(400)
  assert.equal(view.frames.at(-1).sequence,2)
  media.close(); await media.closed
})

test('recovery cannot reuse its RTP timestamp or change source geometry', async t => {
  for(const kind of ['same-timestamp','geometry'])await t.test(kind,async t=>{
    const view=fixture(t),media=await view.starting
    view.message(frame(1,100))
    view.message({type:'frame',frame:{...frame(1,kind==='same-timestamp'?100:200).frame,recovery:true,...(kind==='geometry'?{width:126}:{})}})
    assert.equal(view.peer().closed,true,'invalid recovery did not close its viewer')
    await assert.rejects(media.closed,/Invalid projection frame receipt/)
  })
})
