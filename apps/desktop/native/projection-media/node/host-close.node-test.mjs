import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openMediaProcess } from './host.mjs'

test('close bounds acknowledged but lingering helpers, escalates signals, and waits for actual exit', { timeout: 20000 }, async t => {
  const root = await mkdtemp(join(tmpdir(), 'projection-media-close-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  for (const ignoreTerm of [false, true]) {
    const marker = join(root, `term-${ignoreTerm}`), executable = join(root, `helper-${ignoreTerm}`)
    await writeFile(executable, `#!${process.execPath}
const fs = require('node:fs');
const emit = value => { const data = Buffer.from(JSON.stringify(value)), header = Buffer.alloc(5); header.writeUInt32BE(data.length + 1); header[4] = 1; process.stdout.write(Buffer.concat([header, data])); };
emit({type:'offer',sdp:{type:'offer',sdp:String(process.pid)}});
process.on('SIGTERM',()=>{fs.writeFileSync(${JSON.stringify(marker)},'SIGTERM'); ${ignoreTerm ? '' : 'process.exit(0);'}});
setInterval(()=>{},1000);
let bytes = Buffer.alloc(0);
process.stdin.on('data',chunk=>{bytes=Buffer.concat([bytes,chunk]);while(bytes.length>=4 && bytes.length>=bytes.readUInt32BE(0)+4){const size=bytes.readUInt32BE(0),command=JSON.parse(bytes.subarray(5,size+4));bytes=bytes.subarray(size+4);if(command.type==='close')emit({type:'closed',id:command.id});}});
`, { mode: 0o700 })
    const lifetime = new AbortController()
    const media = await openMediaProcess({ executable, ffmpeg: process.execPath, width: 128, height: 96, fps: 10, bitrate: 500000, signal: lifetime.signal })
    const pid = Number(media.offer.sdp)
    let timer
    try {
      const error = await Promise.race([media.close().then(() => null, reason => reason),
        new Promise(resolve => { timer = setTimeout(() => resolve(new Error('Close never enforced an exit deadline')), 8000) })])
      assert.match(error?.message ?? '', /after close receipt/)
      assert.equal(/SIGKILL/.test(error.message), ignoreTerm)
      assert.equal(await readFile(marker, 'utf8'), 'SIGTERM')
      assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' })
      await assert.rejects(media.closed, reason => reason === error)
    } finally {
      clearTimeout(timer)
      lifetime.abort(new Error('Close fixture finished'))
      await media.closed.catch(() => undefined)
    }
  }
})
