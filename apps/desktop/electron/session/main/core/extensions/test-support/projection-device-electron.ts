import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { app, BrowserWindow } from 'electron';
import { createDeviceRpcRequestHandler } from '@gugu/core/cloud/deviceRpcResponder';
import { createProjectionHostIdentity } from '../../../../../projection-host-identity';
import { createProjectionDeviceClient } from '../../../../../projection-device-client';
import { createSessionpageProjectionDeviceHost } from '../projection-device-factory';
import { extensionProjections as bridge } from '../extension-projection-bridge';
import type { BridgeCaller } from '../extension-bridge';
import { projectionSources, type ProjectionHost } from '../../../../../../src/session/app-runtime/projection-source';

/** Real installed grant/factory/helper/browser. RPC bytes use the real requester/responder over an isolated in-memory pipe, not the cloud. */
export async function probeDeviceProjection(appId: string) {
  const identity = (deviceId: string) => createProjectionHostIdentity({ auth: async () => ({ userId: 'fixture-owner', accessToken: 'fixture-only' }),
    runtime: () => ({ ownerId: 'fixture-owner', deviceId, runtimeInstanceId: 'fixture-runtime' }) });
  const sourceIdentity = identity('fixture-resource-host'), viewerIdentity = identity('fixture-viewer-host');
  const faults: unknown[] = [], host = createSessionpageProjectionDeviceHost({ identity: sourceIdentity, report: error => faults.push(error),
    executables: () => ({ executable: process.env.GUGU_TEST_MEDIA_HELPER!, ffmpeg: process.env.GUGU_PROJECTION_FFMPEG! }) });
  const respond = createDeviceRpcRequestHandler({ handlers: host.handlers });
  const detached = new Set<() => void>();
  const asker = { id: 'isolated-device-fixture', onDetached(fn: () => void) { detached.add(fn); return () => { detached.delete(fn); }; } };
  const source = new BrowserWindow({ show: false, frame: false, useContentSize: true, width: 128, height: 96,
    webPreferences: { backgroundThrottling: false } });
  const viewer = new BrowserWindow({ show: false });
  let hear: Parameters<NonNullable<ProjectionHost['onProjectionSource']>>[0] = () => {};
  const program = { kind: 'program', extensionId: appId, pageId: -94, callingSession: 'fixture-task', binding: null,
    hear: (event: { type: string; event: Parameters<typeof hear>[0] }) => { if (event.type === 'projectionSource') hear(event.event); } } as unknown as BridgeCaller;
  const call = (verb: string, args: Record<string, unknown>) => bridge.call(program, verb, args);
  const runtime = projectionSources({ projection: {
    create: args => call('projectionCreate', args) as Promise<{ id: string }>,
    publish: args => call('projectionPublish', args) as Promise<void>, close: args => call('projectionClose', args) as Promise<void>,
    closed: args => call('projectionClosed', args) as Promise<void>, inputResult: args => call('projectionInputResult', args) as Promise<void>,
    watch: async () => {}, unwatch: async () => {}, send: async () => {},
  }, onProjectionSource: callback => { hear = callback; return () => {}; } });
  let inputCalls = 0, disconnected = 0;
  const paints: Array<{ sequence: number; rtpTimestamp: number; rgb: number[] }> = [], results: unknown[] = [];
  let client: Awaited<ReturnType<typeof createProjectionDeviceClient>> | undefined;
  let publisher: Awaited<ReturnType<typeof runtime.create>> | undefined;
  let browser: ReturnType<typeof spawn> | undefined, browserExit = Promise.resolve(), exited = false, stderr = '';
  let server: ReturnType<typeof createServer> | undefined;
  try {
    await source.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent('<body style="margin:0;background:rgb(26,96,190)"><textarea style="width:60px;height:20px"></textarea><script>document.querySelector("textarea").focus()</script>'));
    const capture = async () => publisher!.publish({ width: 128, height: 96, mime: 'image/png',
      data: (await source.webContents.capturePage()).toPNG().toString('base64') });
    publisher = await runtime.create({
      input: async (input, { signal }) => { signal.throwIfAborted(); assert.equal(input.kind, 'text');
        if (input.kind === 'text') { inputCalls++; await source.webContents.insertText(input.text); } },
      disconnect: async () => { disconnected++; }, close() {}, refresh: async () => { await capture(); },
    });
    // The real main-binding lookup is exercised separately by the retarget behavior test.
    const page = bridge.viewerPage({ kind: 'page', extensionId: appId, pageId: viewer.webContents.id,
      binding: { sessionId: 'fixture-task' } } as BridgeCaller);
    client = await createProjectionDeviceClient({ page: { ...page, deviceId: 'fixture-resource-host', version: '1.0.0' }, identity: viewerIdentity,
      report: error => faults.push(error), openPipe: async (_device, _asker, handlers) => ({
        send: raw => respond(raw, reply => handlers.onMessage(reply), undefined, asker),
        close: () => { for (const listener of [...detached]) listener(); },
      }) });
    const connection = client, opened = await connection.open(publisher.id);
    assert.deepEqual(Object.keys(opened).sort(), ['id', 'offer']);
    assert.equal('proof' in connection || 'controlKey' in connection, false);
    server = createServer(async (request, response) => {
      try {
        if (request.url === '/viewer.mjs') { response.setHeader('Content-Type', 'text/javascript'); response.end(fs.readFileSync(path.join(process.cwd(), 'apps/desktop/native/projection-media/web/viewer.mjs'))); return; }
        if (request.url === '/offer') { response.end(JSON.stringify(opened.offer)); return; }
        if (request.method !== 'POST') { response.setHeader('Content-Type', 'text/html; charset=utf-8'); response.end(html); return; }
        let raw = ''; for await (const bytes of request) { raw += bytes; if (Buffer.byteLength(raw) > 128 * 1024) throw new Error('Device fixture payload too large'); }
        if (request.url === '/answer') await connection.answer(opened.id, JSON.parse(raw));
        else if (request.url === '/sign') { response.end(connection.sign(opened.id, raw)); return; }
        else if (request.url === '/paint') paints.push(JSON.parse(raw));
        else if (request.url === '/result') results.push(JSON.parse(raw));
        else if (request.url === '/error') throw new Error(raw);
        response.end('{}');
      } catch (error) { if (!connection.signal.aborted) faults.push(error); response.statusCode = 400; response.end(String(error)); }
    });
    const currentServer = server;
    await new Promise<void>(resolve => currentServer.listen(0, '127.0.0.1', resolve));
    const address = currentServer.address(); assert.ok(address && typeof address !== 'string');
    browser = spawn(process.env.GUGU_TEST_CHROMIUM!, ['--headless=new', '--autoplay-policy=no-user-gesture-required', '--disable-dev-shm-usage',
      `--user-data-dir=${path.join(app.getPath('userData'), 'device-projection-viewer')}`, `http://127.0.0.1:${address.port}`], { stdio: ['ignore', 'ignore', 'pipe'] });
    browser.stderr?.on('data', bytes => { stderr = (stderr + bytes).slice(-4096); });
    browserExit = new Promise<void>(resolve => {
      browser!.once('error', error => { faults.push(error); }); browser!.once('close', () => { exited = true; resolve(); });
    });
    const until = async (check: () => boolean) => {
      const deadline = Date.now() + 12_000;
      while (!check()) {
        if (faults.length) throw faults[0]; if (exited) throw new Error('Device fixture browser exited: ' + stderr);
        if (Date.now() > deadline) throw new Error('Device fixture timed out: ' + stderr);
        await new Promise(resolve => setTimeout(resolve, 20));
      }
    };
    await until(() => paints.length >= 1 && results.length >= 1);
    assert.deepEqual(results[0], { type: 'input-result', generation: (results[0] as { generation: string }).generation, sequence: 1, status: 'applied' });
    assert.equal(inputCalls, 1); assert.equal(await source.webContents.executeJavaScript('document.querySelector("textarea").value'), '设备中文🙂');
    await source.webContents.executeJavaScript('document.body.style.background="rgb(190,40,26)";new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))');
    await capture(); await until(() => paints.some(frame => frame.sequence === 2));
    for (const [index, wanted] of [[26, 96, 190], [190, 40, 26]].entries()) {
      const actual = paints.find(frame => frame.sequence === index + 1)!;
      assert.ok(Number.isInteger(actual.rtpTimestamp));
      wanted.forEach((value, channel) => assert.ok(Math.abs(actual.rgb[channel]! - value) < 12, JSON.stringify(actual)));
    }
    bridge.closePage(viewer.webContents.id);
    assert.equal(connection.signal.aborted, true);
    assert.throws(() => connection.sign(opened.id, '{}'), /page changed/);
    await connection.close(); await host.dispose(); assert.ok(disconnected > 0); assert.equal(inputCalls, 1);
    assert.equal(faults.length, 0, faults.map(String).join('; '));
    return { signedInputs: inputCalls, paints: paints.length, retargetClosed: true, privateKeysHidden: true };
  } finally {
    try { await client?.close(); await host.dispose(); }
    finally {
      sourceIdentity.dispose(); viewerIdentity.dispose();
      if (!exited) browser?.kill('SIGTERM'); await browserExit;
      if (server) { server.closeAllConnections(); const current = server; await new Promise<void>(resolve => current.close(() => resolve())); }
      await publisher?.close(); bridge.closePage(program.pageId); bridge.closePage(viewer.webContents.id); source.destroy(); viewer.destroy();
    }
  }
}

const html = `<!doctype html><meta charset="utf-8"><video autoplay muted playsinline></video><canvas width="128" height="96"></canvas><script type="module">
import {openProjectionVideo} from '/viewer.mjs';
(async()=>{
 let generation, sent=false;
 const post=async(url,body)=>{const response=await fetch(url,{method:'POST',body});if(!response.ok)throw new Error(await response.text());return response};
 const video=document.querySelector('video'), ctx=document.querySelector('canvas').getContext('2d');
 const media=await openProjectionVideo({video,offer:await(await fetch('/offer')).json(),
 answer:async sdp=>{await post('/answer',JSON.stringify(sdp))},
 prepareControl:async(raw,signal)=>{const response=await fetch('/sign',{method:'POST',body:raw,signal});if(!response.ok)throw new Error(await response.text());return response.text()},
 onControl:raw=>{const value=JSON.parse(raw);if(value.type==='projection-generation')generation=value.generation;
 else if(value.type==='input-result')void post('/result',raw)},
 onFrame:(frame,send)=>{if(!frame||!generation)return;ctx.drawImage(video,0,0,128,96);const p=ctx.getImageData(110,80,1,1).data;
 void send(JSON.stringify({type:'ack',generation,frame:frame.sequence}));
 void post('/paint',JSON.stringify({...frame,rgb:[p[0],p[1],p[2]]}));
 if(!sent){sent=true;void send(JSON.stringify({type:'input',generation,frame:frame.sequence,sequence:1,input:{kind:'text',text:'设备中文🙂'}}))}}
 });
 void media.closed.catch(()=>{});
})().catch(error=>fetch('/error',{method:'POST',body:String(error)}));
</script>`;
