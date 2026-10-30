import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { app, BrowserWindow, nativeImage } from 'electron';
import { EXTENSION_API_VERSION } from '@shared/extensions/manifest';
import type { BridgeCaller } from '../extension-bridge';
import { extensionProjections as bridge } from '../extension-projection-bridge';
import { extensionsService } from '../extensions-root';
import { revokeExtensionProgramAccess } from '../extension-program-access';
import { createProjectionImageDecoder } from '../projection-image';
import { projectionSources, type ProjectionHost } from '../../../../../../src/session/app-runtime/projection-source';
import { openMediaProcess } from '../../../../../../native/projection-media/node/host.mjs';
import { ProjectionSignals } from '../../../../../../native/projection-media/node/signaling.mjs';

if (!process.env.GUGU_HOME || !process.env.GUGU_USER_DATA_DIR) throw new Error('Pipeline fixture needs isolated paths');
app.setPath('userData', process.env.GUGU_USER_DATA_DIR);
app.dock?.hide();
const pause = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

void app.whenReady().then(async () => {
  const id = 'projection-media-native-fixture', service = extensionsService();
  const bundle = path.join(app.getPath('userData'), 'fixture-app');
  fs.mkdirSync(bundle, { recursive: true });
  fs.writeFileSync(path.join(bundle, 'index.html'), '<body>Fixture App</body>');
  fs.writeFileSync(path.join(bundle, 'fixture.mjs'), 'process.stdin.resume();');
  fs.writeFileSync(path.join(bundle, 'manifest.json'), JSON.stringify({ id, name: id, version: '1.0.0', apiVersion: EXTENSION_API_VERSION,
    platforms: ['desktop'], entry: 'index.html', permissions: { capabilities: ['agents:tools'], network: [] },
    contributes: { tabs: [{ name: 'main', title: 'Fixture' }], mcpServers: [{ name: 'fixture', command: 'node', args: ['fixture.mjs'] }] },
  }));
  service.installFromDirectory(bundle, service.inspectDirectory(bundle).manifestDigest, 'folder');
  const source = new BrowserWindow({ show: false, frame: false, useContentSize: true, width: 128, height: 96,
    webPreferences: { backgroundThrottling: false } });
  const appPage = new BrowserWindow({ show: false });
  let hear: Parameters<NonNullable<ProjectionHost['onProjectionSource']>>[0] = () => {};
  const program = { kind: 'program', extensionId: id, pageId: -91, callingSession: 'fixture-task', binding: null,
    hear: (event: { type: string; event: Parameters<typeof hear>[0] }) => { if (event.type === 'projectionSource') hear(event.event); },
  } as unknown as BridgeCaller;
  const call = (verb: string, args: Record<string, unknown>) => bridge.call(program, verb, args);
  const runtime = projectionSources({ projection: {
    create: args => call('projectionCreate', args) as Promise<{ id: string }>,
    publish: args => call('projectionPublish', args) as Promise<void>, close: args => call('projectionClose', args) as Promise<void>,
    closed: args => call('projectionClosed', args) as Promise<void>, inputResult: args => call('projectionInputResult', args) as Promise<void>,
    watch: async () => {}, unwatch: async () => {}, send: async () => {},
  }, onProjectionSource: callback => { hear = callback; return () => {}; } });
  const page = { kind: 'page', extensionId: id, pageId: appPage.webContents.id, binding: { sessionId: 'fixture-task' } } as BridgeCaller;
  const context = { ownerId: 'fixture-owner', deviceId: 'fixture-viewer', appId: id, sessionId: 'fixture-task', pageId: String(page.pageId), epoch: '0' };
  let fault: unknown, inputCalls = 0, stopped = false;
  const paints: Array<{ sequence: number; rtpTimestamp: number; rgb: number[] }> = [];
  const outcomes: unknown[] = [], pixels: Uint8Array[] = [];
  const decoded: number[][] = [];
  let disconnected = 0, viewerGeneration = "";
  const encoded = new Map<number, number>();
  await source.loadURL('data:text/html,' + encodeURIComponent('<body style="margin:0;background:rgb(26,96,190)"><textarea style="width:60px;height:20px"></textarea><script>document.querySelector("textarea").focus()</script>'));
  const publisher = await runtime.create({
    input: async (input, { signal }) => { signal.throwIfAborted(); assert.equal(input.kind, 'text');
      if (input.kind === 'text') { inputCalls++; await source.webContents.insertText(input.text); } },
    disconnect: async () => { disconnected++; }, close: () => { stopped = true; },
    refresh: async () => { await capture(); },
  });
  async function capture() {
    const picture = await source.webContents.capturePage();
    assert.deepEqual(picture.getSize(), { width: 128, height: 96 });
    return publisher.publish({ width: 128, height: 96, mime: 'image/png', data: picture.toPNG().toString('base64') });
  }
  const decode = createProjectionImageDecoder(nativeImage.createFromBuffer, { r: 0, g: 0, b: 0 });
  const feeds = new Map<unknown, ReturnType<typeof bridge.mediaFeed>>();
  const signals = new ProjectionSignals({
    authorize: async (bound, sourceId, signal) => {
      signal.throwIfAborted();
      const feed = bridge.mediaFeed(page, sourceId, bound, async (frame, signal) => {
        const lease = await decode(frame, signal); pixels.push(lease.data);
        const at = (80 * frame.width + 110) * 4; decoded.push([...lease.data.subarray(at, at + 4)]); return lease;
      }, async (size, signal, onControl) => {
        const media = await openMediaProcess({ ...size, executable: process.env.GUGU_TEST_MEDIA_HELPER!,
          ffmpeg: process.env.GUGU_PROJECTION_FFMPEG!, fps: 10, bitrate: 500000, signal,
          onControl: raw => { const packet = JSON.parse(raw); if (packet.type === 'ack') viewerGeneration ||= packet.generation; onControl(raw); } });
        return { ...media, async publish(sequence, data) { const receipt = await media.publish(sequence, data);
          encoded.set(sequence, receipt.rtpTimestamp); return receipt; } };
      });
      feeds.set(feed.lease, feed); return feed.lease;
    },
    openMedia: (lease, signal, onControl) => feeds.get(lease)!.openMedia(signal, onControl),
  });
  let server: ReturnType<typeof createServer> | undefined, browser: ReturnType<typeof spawn> | undefined;
  let browserExit = Promise.resolve(), exited = false;
  try {
    const opened = await signals.receive(context, { type: 'open', requestId: 'fixture-open', sourceId: publisher.id }) as { id: string; offer: { type: 'offer'; sdp: string } };
    assert.ok(opened?.offer);
    server = createServer(async (request, response) => {
      try {
        if (request.url === '/viewer.mjs') { response.setHeader('Content-Type', 'text/javascript'); response.end(fs.readFileSync(path.join(process.cwd(), 'apps/desktop/native/projection-media/web/viewer.mjs'))); return; }
        if (request.url === '/offer') { response.end(JSON.stringify(opened.offer)); return; }
        if (request.method !== 'POST') { response.setHeader('Content-Type', 'text/html; charset=utf-8'); response.end(html); return; }
        let data = '';
        for await (const chunk of request) { data += chunk; if (data.length > 128 * 1024) throw new Error('Fixture message too large'); }
        if (request.url === '/answer') await signals.receive(context, { type: 'answer', id: opened.id, sdp: JSON.parse(data) });
        else if (request.url === '/paint') paints.push(JSON.parse(data));
        else if (request.url === '/result') outcomes.push(JSON.parse(data));
        else if (request.url === '/error') throw new Error(data);
        response.end('{}');
      } catch (error) { fault = error; response.statusCode = 400; response.end(String(error)); }
    });
    const listening = server;
    await new Promise<void>(resolve => listening.listen(0, '127.0.0.1', resolve));
    const address = server.address(); assert.ok(address && typeof address !== 'string');
    browser = spawn(process.env.GUGU_TEST_CHROMIUM!, ['--headless=new', '--autoplay-policy=no-user-gesture-required',
      '--disable-dev-shm-usage', `--user-data-dir=${path.join(app.getPath('userData'), 'headless-viewer')}`, `http://127.0.0.1:${address.port}`], { stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    browser.stderr?.on('data', data => { stderr = (stderr + data).slice(-4096); });
    const chromium = browser;
    browserExit = new Promise<void>(resolve => { chromium.once('error', error => { fault = error; }); chromium.once('close', () => { exited = true; resolve(); }); });
    const until = async (condition: () => boolean) => {
      const deadline = Date.now() + 12000;
      while (!condition()) { if (fault) throw fault; if (exited) throw new Error('Chromium exited: ' + stderr);
        if (Date.now() > deadline) throw new Error('Pipeline timed out: ' + stderr); await pause(20); }
    };
    await until(() => paints.some(paint => paint.sequence === 1) && outcomes.length > 0);
    const first = paints.find(paint => paint.sequence === 1)!;
    for (const [channel, wanted] of [26, 96, 190].entries()) assert.ok(Math.abs(first.rgb[channel]! - wanted) < 12, JSON.stringify(first));
    assert.equal(first.rtpTimestamp, encoded.get(1));
    assert.ok(viewerGeneration);
    assert.deepEqual(outcomes[0], { type: 'input-result', generation: viewerGeneration, sequence: 1, status: 'applied' });
    assert.equal(inputCalls, 1);
    assert.equal(await source.webContents.executeJavaScript('document.querySelector("textarea").value'), '整链中文🙂');
    // JS completion can precede compositor capture; witness the new paint first.
    await source.webContents.executeJavaScript('document.body.style.background="rgb(190,40,26)"; new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))');
    assert.equal(await capture(), 2);
    await until(() => paints.some(paint => paint.sequence === 2));
    const second = paints.find(paint => paint.sequence === 2)!;
    for (const [channel, wanted] of [190, 40, 26].entries()) assert.ok(Math.abs(second.rgb[channel]! - wanted) < 12, JSON.stringify({ second, decoded }));
    assert.equal(second.rtpTimestamp, encoded.get(2));
    assert.equal(pixels.length, 2); assert.equal(pixels[0], pixels[1]);
    service.setPermissionGranted(id, 'agents:tools', false);
    await assert.rejects(publisher.publish({ width: 128, height: 96, mime: 'image/png', data: 'YQ==' }), /revoked/);
    revokeExtensionProgramAccess(id);
    await until(() => stopped && [...feeds.values()][0]!.lease.signal.aborted);
    await signals.dispose();
    assert.ok(disconnected > 0); assert.equal(inputCalls, 1);
    process.stdout.write('PROJECTION_PIPELINE_RESULT=' + JSON.stringify({ passed: true, paints, decoded, inputCalls, reused: pixels[0] === pixels[1],
      home: process.env.GUGU_HOME, userData: app.getPath('userData'), electron: process.versions.electron }) + '\n');
  } finally {
    try { await signals.dispose(); }
    finally {
      if (!exited) browser?.kill('SIGTERM'); await browserExit;
      if (server) { server.closeAllConnections(); const currentServer = server;
        await new Promise<void>(resolve => currentServer.close(() => resolve())); }
      bridge.closePage(page.pageId); bridge.closePage(program.pageId); source.destroy(); appPage.destroy();
    }
  }
  app.quit();
}).catch(error => { process.stderr.write(String(error) + '\n'); app.exit(1); });

const html = `<!doctype html><meta charset="utf-8"><video autoplay muted playsinline></video><canvas width="128" height="96"></canvas><script type="module">
import {openProjectionVideo} from '/viewer.mjs';
(async()=>{
 let generation, sent=false;
 const video=document.querySelector('video'), ctx=document.querySelector('canvas').getContext('2d');
 await openProjectionVideo({video,offer:await(await fetch('/offer')).json(),
 answer:async sdp=>{const response=await fetch('/answer',{method:'POST',body:JSON.stringify(sdp)});if(!response.ok)throw new Error(await response.text())},
 onControl:raw=>{const value=JSON.parse(raw);if(value.type==='projection-generation')generation=value.generation;
 else if(value.type==='input-result')void fetch('/result',{method:'POST',body:raw})},
 onFrame:(frame,send)=>{if(!frame||!generation)return;ctx.drawImage(video,0,0,128,96);const p=ctx.getImageData(110,80,1,1).data;
 send(JSON.stringify({type:'ack',generation,frame:frame.sequence}));
 void fetch('/paint',{method:'POST',body:JSON.stringify({...frame,rgb:[p[0],p[1],p[2]]})});
 if(!sent){sent=true;send(JSON.stringify({type:'input',generation,frame:frame.sequence,sequence:1,input:{kind:'text',text:'整链中文🙂'}}))}}
 });
})().catch(error=>fetch('/error',{method:'POST',body:String(error)}));
</script>`;
