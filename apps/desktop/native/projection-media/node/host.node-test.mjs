import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Readable } from 'node:stream'
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openMediaProcess, mediaMessages } from './host.mjs'

const packet = value => {
  const text = Buffer.from(JSON.stringify(value))
  const output = Buffer.alloc(text.length + 5)
  output.writeUInt32BE(text.length + 1)
  output[4] = 1
  output.set(text, 5)
  return output
}
const config = {
  executable: process.env.GUGU_TEST_MEDIA_HELPER ?? '', ffmpeg: process.env.GUGU_PROJECTION_FFMPEG ?? '/opt/homebrew/bin/ffmpeg',
  width: 128, height: 96, fps: 10, bitrate: 500000,
}

test('decodes split and combined native events, refuses raw/truncated/oversized output', async () => {
  const first = packet({ type: 'sent', id: 1 })
  const second = packet({ type: 'closed', id: 2 })
  const events = []
  for await (const event of mediaMessages(Readable.from([first.subarray(0, 2), first.subarray(2, 6), Buffer.concat([first.subarray(6), second])]))) events.push(event)
  assert.deepEqual(events, [{ type: 'sent', id: 1 }, { type: 'closed', id: 2 }])
  for (const bad of [Buffer.from([0, 2, 8, 2]), Buffer.from([0, 0, 0, 2, 2, 1]), first.subarray(0, first.length - 1)]) {
    await assert.rejects(async () => { for await (const unused of mediaMessages(Readable.from([bad]))) void unused })
  }
})

test('starts and cleanly closes the real helper before any remote answer', { timeout: 15000 }, async () => {
  assert.ok(config.executable, 'GUGU_TEST_MEDIA_HELPER must select the actual built helper')
  const media = await openMediaProcess(config)
  try {
    assert.equal(media.offer.type, 'offer')
    assert.match(media.offer.sdp, /H264/)
    await assert.rejects(media.sendControl('not connected'), /not connected/)
    await assert.rejects(media.publish(1, new Uint8Array(128 * 96 * 4)), /not connected/)
    await assert.rejects(media.answer({ type: 'offer', sdp: media.offer.sdp }), /Invalid media answer/)
  } finally { await media.close() }
  await media.closed
  await media.close()
})

test('refuses unsafe configuration and propagates actual child launch failure', async () => {
  await assert.rejects(openMediaProcess({ ...config, executable: 'projection-media' }), /absolute paths/)
  await assert.rejects(openMediaProcess({ ...config, width: 1920, height: 1080 }), /level 3.1/)
  await assert.rejects(openMediaProcess({ ...config, stun: 'turn:example.invalid' }), /STUN/)
  await assert.rejects(openMediaProcess({ ...config, executable: `${config.executable}.missing` }), /ENOENT/)
})

const fakeMedia = async (t, behavior) => {
  const root = await mkdtemp(join(tmpdir(), 'projection-media-host-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const executable = join(root, 'helper')
  await writeFile(executable, `#!${process.execPath}\n` + `
const emit = value => {
  const data = Buffer.from(JSON.stringify(value)); const header = Buffer.alloc(5);
  header.writeUInt32BE(data.length + 1); header[4] = 1;
  process.stdout.write(Buffer.concat([header, data]));
};
emit({type:'offer',sdp:{type:'offer',sdp:'test-peer'}});
let bytes = Buffer.alloc(0);
process.stdin.on('data', chunk => {
  bytes = Buffer.concat([bytes, chunk]);
  while(bytes.length >= 4 && bytes.length >= bytes.readUInt32BE(0)+4) {
    const size=bytes.readUInt32BE(0); const kind=bytes[4]; const body=bytes.subarray(5,size+4); bytes=bytes.subarray(size+4);
    const command=kind===1?JSON.parse(body):{type:'frame',sequence:Number(body.readBigUInt64BE(0))};
    ${behavior}
  }
});
`, { mode: 0o700 })
  return { ...config, executable }
}

test('a sent receipt cannot masquerade as ready, or a different frame as encoded', { timeout: 10000 }, async t => {
  const badReady = await fakeMedia(t, `if(command.type==='answer') emit({type:'sent',id:command.id});`)
  const media = await openMediaProcess(badReady)
  await assert.rejects(media.answer({ type: 'answer', sdp: 'test' }), /Unassociated media command/)
  await assert.rejects(media.closed, /Unassociated media command/)
  await assert.rejects(media.close())

  const badFrame = await fakeMedia(t, `
    if(command.type==='answer') emit({type:'ready',id:command.id});
    if(command.type==='frame') emit({type:'encoded',frame:{sequence:command.sequence+1,width:128,height:96,rtpTimestamp:9000}});
  `)
  const other = await openMediaProcess(badFrame)
  await other.answer({ type: 'answer', sdp: 'test' })
  await assert.rejects(other.publish(7, Buffer.alloc(128 * 96 * 4)), /Unassociated encoded media frame/)
  await assert.rejects(other.closed)
})

test('early controls wait for ready, each receipt keeps its meaning and close waits for child exit', { timeout: 10000 }, async t => {
  const received = []
  const options = await fakeMedia(t, `
    if(command.type==='answer') { emit({type:'control',data:'early 中文'}); emit({type:'ready',id:command.id}); }
    if(command.type==='send') emit({type:'sent',id:command.id});
    if(command.type==='frame') emit({type:'encoded',frame:{sequence:command.sequence,width:128,height:96,rtpTimestamp:9000}});
    if(command.type==='close') { emit({type:'control',data:'after-close'}); emit({type:'closed',id:command.id}); setTimeout(()=>process.exit(0),100); }
  `)
  const media = await openMediaProcess({ ...options, onControl: text => received.push(text) })
  await media.answer({ type: 'answer', sdp: 'test' })
  assert.deepEqual(received, ['early 中文'])
  assert.equal(await media.sendControl('中文🙂'), undefined)
  const receipt = await media.publish(7, Buffer.alloc(128 * 96 * 4))
  assert.deepEqual(receipt, { sequence: 7, width: 128, height: 96, rtpTimestamp: 9000 })
  await assert.rejects(media.publish(7, Buffer.alloc(128 * 96 * 4)), /Invalid source media frame/)
  await media.close()
  await media.closed
  assert.deepEqual(received, ['early 中文'])
})

test('parent cancellation actually exits the helper, does not leave a pending offer', { timeout: 10000 }, async () => {
  const lifetime = new AbortController()
  const media = await openMediaProcess({ ...config, signal: lifetime.signal })
  lifetime.abort(new Error('App grant withdrawn'))
  await assert.rejects(media.closed, error => error.message === 'App grant withdrawn')
  await assert.rejects(media.publish(1, Buffer.alloc(128 * 96 * 4)), /App grant withdrawn/)
})
