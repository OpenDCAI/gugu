import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { spawn } from 'node:child_process'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { openMediaProcess } from './host.mjs'

test('Node host → actual native helper → Chromium decodes correlated video and returns direct control', { timeout: 30000 }, async t => {
  assert.ok(process.env.GUGU_TEST_CHROMIUM, 'GUGU_TEST_CHROMIUM must select the actual browser')
  const lifetime = new AbortController()
  const controls = []
  let browserReady = false
  let browserFailure
  const media = await openMediaProcess({
    executable: process.env.GUGU_TEST_MEDIA_HELPER,
    ffmpeg: process.env.GUGU_PROJECTION_FFMPEG,
    width: 128, height: 96, fps: 10, bitrate: 500000,
    signal: lifetime.signal,
    onControl: raw => controls.push(JSON.parse(raw)),
  })
  t.after(async () => { lifetime.abort(); await media.closed.catch(() => undefined) })
  const server = createServer(async (request, response) => {
    try {
      if (request.url === '/viewer.mjs') {
        response.setHeader('Content-Type', 'text/javascript')
        response.end(await readFile(new URL('../web/viewer.mjs', import.meta.url)))
        return
      }
      if (request.url === '/offer') { response.end(JSON.stringify(media.offer)); return }
      let data = ''
      if (request.method === 'POST') for await (const chunk of request) {
        data += chunk
        if (data.length > 128 * 1024) throw new Error('Oversized browser fixture message')
      }
      if (request.url === '/answer') await media.answer(JSON.parse(data))
      else if (request.url === '/ready') browserReady = true
      else if (request.url === '/error') browserFailure = new Error(data)
      else { response.setHeader('Content-Type', 'text/html'); response.end(fixture); return }
      response.end('{}')
    } catch (error) { browserFailure = error; response.writeHead(400); response.end(String(error)) }
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve) }))
  const profile = await mkdtemp(join(tmpdir(), 'projection-media-browser-'))
  t.after(() => rm(profile, { recursive: true, force: true }))
  const args = ['--headless=new', '--autoplay-policy=no-user-gesture-required', `--user-data-dir=${profile}`]
  if (process.getuid?.() === 0) args.push('--no-sandbox')
  args.push(`http://127.0.0.1:${server.address().port}`)
  const browser = spawn(process.env.GUGU_TEST_CHROMIUM, args, { stdio: ['ignore', 'ignore', 'pipe'] })
  let diagnostics = ''
  let exit
  const exited = new Promise(resolve => { browser.once('error', error => { browserFailure = error; resolve() }); browser.once('close', code => { exit = code; resolve() }) })
  browser.stderr.on('data', chunk => { diagnostics = (diagnostics + chunk).slice(-4096) })
  t.after(async () => { browser.kill('SIGTERM'); await exited })
  const until = async predicate => {
    const deadline = Date.now() + 12000
    while (!predicate()) {
      if (browserFailure) throw browserFailure
      if (exit !== undefined) throw new Error(`Browser exited ${exit}: ${diagnostics}`)
      if (Date.now() >= deadline) throw new Error(`Browser media fixture did not progress: ${diagnostics}`)
      await delay(20)
    }
  }
  await until(() => browserReady)
  await media.sendControl(JSON.stringify({ probe: '输入中文🙂' }))
  await until(() => controls.some(control => control.echo === '输入中文🙂'))
  let sequence = 0
  const encoded = new Map()
  for (let channel = 0; channel < 3; channel++) {
    const bgra = Buffer.alloc(128 * 96 * 4)
    for (let at = 0; at < bgra.length; at += 4) { bgra[at + channel] = 230; bgra[at + 3] = 255 }
    const deadline = Date.now() + 10000
    let painted
    do {
      const receipt = await media.publish(++sequence, bgra)
      encoded.set(receipt.sequence, receipt)
      await delay(100)
      painted = controls.find(control => control.painted?.rgb?.[2 - channel] > 215
        && control.painted.rgb[(3 - channel) % 3] < 15 && control.painted.rgb[(4 - channel) % 3] < 15
        && encoded.get(control.painted.sequence)?.rtpTimestamp === control.painted.rtpTimestamp)
      if (Date.now() > deadline) throw new Error(`Browser did not paint correlated color ${channel}: ${diagnostics}`)
    } while (!painted)
    assert.equal(encoded.get(painted.painted.sequence).rtpTimestamp, painted.painted.rtpTimestamp)
  }
  await media.close()
  await media.closed
})

const fixture = `<!doctype html><video autoplay muted playsinline></video><canvas width="128" height="96"></canvas>
<script type="module">
import {openProjectionVideo} from '/viewer.mjs';
(async()=>{
  const video=document.querySelector('video'), ctx=document.querySelector('canvas').getContext('2d');
  await openProjectionVideo({video,offer:await(await fetch('/offer')).json(),
    answer:async description=>{
      const response=await fetch('/answer',{method:'POST',body:JSON.stringify(description)});
      if(!response.ok)throw new Error(await response.text());
    },
    onFrame:(frame,send)=>{
      if(!frame)return;
      ctx.drawImage(video,0,0,128,96); const p=ctx.getImageData(64,48,1,1).data;
      send(JSON.stringify({painted:{...frame,rgb:[p[0],p[1],p[2]]}}));
    },
    onControl:(raw,send)=>{const message=JSON.parse(raw);if(message.probe)send(JSON.stringify({echo:message.probe}))}
  });
  await fetch('/ready',{method:'POST'});
})().catch(e=>fetch('/error',{method:'POST',body:String(e)}));
</script>`
