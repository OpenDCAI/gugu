import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { app, BrowserWindow, ipcMain } from 'electron';
import { extensionProjections as bridge } from '../extension-projection-bridge';
import { extensionsService } from '../extensions-root';
import { EXTENSION_API_VERSION } from '@shared/extensions/manifest';
import { revokeExtensionProgramAccess } from '../extension-program-access';
import { projectionSources, type ProjectionHost, type ProjectionDriver } from '../../../../../../src/session/app-runtime/projection-source';
import type { BridgeCaller } from '../extension-bridge';
import type { ProjectionInput, ProjectionSourceEvent, ProjectionHostPacket } from '@shared/extensions/projection-protocol';

app.setPath('userData', process.env.GUGU_USER_DATA_DIR!);
process.on('uncaughtException', error => { process.stderr.write(String(error) + '\n'); app.exit(1); });
process.on('unhandledRejection', error => { process.stderr.write(String(error) + '\n'); app.exit(1); });
const cases: Record<string, { passed: boolean; error?: string }> = {};
async function check(name: string, work: () => Promise<void>) {
  try { await work(); cases[name] = { passed: true }; }
  catch (error) { cases[name] = { passed: false, error: String(error) }; }
}
const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));
async function until(work: () => Promise<boolean>) {
  const end = Date.now() + 5000;
  while (Date.now() < end) { if (await work()) return; await sleep(20); }
  throw new Error('Native projection did not become ready within 5s');
}

void app.whenReady().then(async () => {
  const service = extensionsService();
  for (const id of ['native-projection-a', 'native-projection-b']) {
    const bundle = path.join(app.getPath('userData'), 'fixture-sources', id);
    fs.mkdirSync(bundle, { recursive: true });
    fs.writeFileSync(path.join(bundle, 'index.html'), '<body>Projection fixture</body>');
    fs.writeFileSync(path.join(bundle, 'fixture.mjs'), 'process.stdin.resume();');
    fs.writeFileSync(path.join(bundle, 'manifest.json'), JSON.stringify({ id, name: id, version: '1.0.0', apiVersion: EXTENSION_API_VERSION, defaultLocale: 'en',
      platforms: ['desktop'], entry: 'index.html', permissions: { capabilities: ['agents:tools'], network: [] },
      contributes: { instructions: 'Projection fixture tools.', tabs: [{ name: 'main', title: 'Projection' }], mcpServers: [{ name: 'fixture', command: 'node', args: ['fixture.mjs'] }] },
    }));
    service.installFromDirectory(bundle, service.inspectDirectory(bundle).manifestDigest, 'folder');
  }
  const windows: BrowserWindow[] = [];
  const source = new BrowserWindow({ show: false, width: 640, height: 480, webPreferences: { backgroundThrottling: false } });
  const other = new BrowserWindow({ show: false, webPreferences: { backgroundThrottling: false } });
  windows.push(source, other);
  const html = `<body style="background:#184e91"><textarea id="native" style="width:80%;height:200px"></textarea><script>native.focus();window.held={key:false,mouse:false};addEventListener('keydown',e=>{if(e.key==='Shift')held.key=true});addEventListener('keyup',e=>{if(e.key==='Shift')held.key=false});addEventListener('mousedown',()=>held.mouse=true);addEventListener('mouseup',()=>held.mouse=false)</script>`;
  await source.loadURL(`data:text/html,${encodeURIComponent(html)}`);
  await other.loadURL(`data:text/html,${encodeURIComponent(html)}`);
  const program = (extensionId: string, pageId: number) => {
    let receive: (event: ProjectionSourceEvent) => void = () => {};
    const caller = { kind: 'program', extensionId, pageId, callingSession: 'task-a', binding: null,
      hear: (event: { type: string; event: ProjectionSourceEvent }) => { if (event.type === 'projectionSource') receive(event.event); },
    } as unknown as BridgeCaller;
    const call = (method: string, args: Record<string, unknown>) => bridge.call(caller, method, args);
    const host: ProjectionHost = {
      projection: {
        create: args => call('projectionCreate', args) as Promise<{ id: string }>,
        publish: args => call('projectionPublish', args) as Promise<void>, close: args => call('projectionClose', args) as Promise<void>,
        closed: args => call('projectionClosed', args) as Promise<void>, inputResult: args => call('projectionInputResult', args) as Promise<void>,
        watch: async () => {}, unwatch: async () => {}, send: async () => {},
      },
      onProjectionSource: callback => { receive = callback; return () => {}; },
    };
    return { runtime: projectionSources(host), caller };
  };
  const a = program('native-projection-a', -1), b = program('native-projection-b', -2);
  const inputs: ProjectionInput[] = [];
  let captures = 0, stopped = false;
  const held = new Map<string, { target: BrowserWindow; key: boolean; mouse: boolean }>();
  const driver = (target: BrowserWindow, capture: () => Promise<void>): ProjectionDriver => ({
    refresh: capture,
    disconnect: async viewer => {
      const state = held.get(viewer);
      if (!state) return;
      if (state.key) state.target.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Shift' });
      if (state.mouse) state.target.webContents.sendInputEvent({ type: 'mouseUp', button: 'left', x: 30, y: 30, clickCount: 1 });
      await until(() => state.target.webContents.executeJavaScript('!held.key && !held.mouse'));
      held.delete(viewer);
    },
    close: () => { assert.equal(held.size, 0); if (target === source) stopped = true; },
    input: async (input, { signal, viewer }) => {
      signal.throwIfAborted();
      if (target === source) inputs.push(input);
      if (input.kind === 'text') await target.webContents.insertText(input.text);
      if (input.kind === 'key') {
        const state = held.get(viewer) ?? { target, key: false, mouse: false };
        state.key = input.action === 'down'; held.set(viewer, state);
        target.webContents.sendInputEvent({ type: input.action === 'down' ? 'keyDown' : 'keyUp', keyCode: input.key });
      }
      if (input.kind === 'pointer' && input.action !== 'move') {
        const state = held.get(viewer) ?? { target, key: false, mouse: false };
        state.mouse = input.action === 'down'; held.set(viewer, state);
        target.webContents.sendInputEvent({ type: input.action === 'down' ? 'mouseDown' : 'mouseUp', button: input.button, x: 30, y: 30, clickCount: 1 });
      }
      signal.throwIfAborted();
    },
  });
  await check('native-installed-app-grants', async () => {
    service.setPermissionGranted('native-projection-a', 'agents:tools', false);
    await assert.rejects(a.runtime.create(driver(source, async () => {})), /revoked/);
    service.setPermissionGranted('native-projection-a', 'agents:tools', true);
    service.setEnabled('native-projection-b', false);
    await assert.rejects(b.runtime.create(driver(other, async () => {})), /revoked/);
    service.setEnabled('native-projection-b', true);
  });
  const publisher = await a.runtime.create(driver(source, async () => {
    const image = await source.webContents.capturePage();
    assert.equal(image.isEmpty(), false);
    const { width, height } = image.getSize();
    captures++;
    await publisher.publish({ width, height, mime: 'image/png', data: image.toPNG().toString('base64') });
  }));
  const second = await b.runtime.create(driver(other, async () => {}));
  const packets: ProjectionHostPacket[] = [];
  const viewer = new BrowserWindow({ show: false, width: 500, height: 500, webPreferences: {
    preload: path.join(__dirname, 'preload.cjs'), backgroundThrottling: false,
  } });
  windows.push(viewer);
  const page = { kind: 'page', extensionId: a.caller.extensionId, pageId: viewer.webContents.id, binding: { sessionId: 'task-a' },
    hear: (event: { type: string; watchId: string; packet: ProjectionHostPacket }) => {
      if (event.type === 'projection') { packets.push(event.packet); viewer.webContents.send('projection', event.watchId, event.packet); }
    },
  } as unknown as BridgeCaller;
  ipcMain.handle('projection', (event, method: string, args: Record<string, unknown>) => {
    assert.equal(event.sender.id, viewer.webContents.id);
    const verbs: Record<string, string> = { watch: 'projectionWatch', unwatch: 'projectionUnwatch', send: 'projectionSend' };
    assert.ok(verbs[method]);
    return bridge.call(page, verbs[method]!, args);
  });
  await viewer.loadFile(path.join(__dirname, 'viewer.html'), { query: { id: publisher.id } });
  const value = (window: BrowserWindow) => window.webContents.executeJavaScript('document.getElementById("native").value') as Promise<string>;
  await check('native-capture-and-render', async () => {
    await until(() => viewer.webContents.executeJavaScript('window.projectionState.value === "live"'));
    assert.ok(captures >= 1);
    assert.ok(packets.some(packet => packet.type === 'frame' && packet.frame.data.length > 100));
    assert.equal(await viewer.webContents.executeJavaScript('document.querySelector("img").naturalWidth > 0 && !document.querySelector("textarea").disabled'), true);
  });
  await check('native-unicode-once-and-fixture-routing', async () => {
    await viewer.webContents.executeJavaScript(`(() => {
      const input = document.querySelector('textarea');
      input.dispatchEvent(new CompositionEvent('compositionstart'));
      input.value = '中文';
      input.dispatchEvent(new CompositionEvent('compositionend', {data:'中文'}));
      input.value = '中文';
      input.dispatchEvent(new InputEvent('input', {inputType:'insertFromComposition',data:'中文'}));
      input.dispatchEvent(new KeyboardEvent('keydown', {key:'v',ctrlKey:true}));
      const clipboard = new DataTransfer(); clipboard.setData('text/plain', '粘贴\\n第二行');
      input.dispatchEvent(new ClipboardEvent('paste', {clipboardData:clipboard,cancelable:true}));
      input.dispatchEvent(new KeyboardEvent('keyup', {key:'v',ctrlKey:true}));
    })()`);
    await until(async () => await value(source) === '中文粘贴\n第二行');
    assert.deepEqual(inputs, [{ kind: 'text', text: '中文', source: 'ime' }, { kind: 'text', text: '粘贴\n第二行', source: 'paste' }]);
    assert.equal(await value(other), '');
    for (const forged of [{ ...page, binding: { ...page.binding!, sessionId: 'task-b' } }, { ...page, extensionId: b.caller.extensionId }]) {
      await assert.rejects(bridge.call(forged, 'projectionWatch', { id: publisher.id, watchId: 'forged' }), /not in this App session/);
    }
  });
  await check('native-app-revocation', async () => {
    const snapshot = await value(source);
    const generation = packets[0]!.generation;
    await bridge.call(page, 'projectionSend', { watchId: (await viewer.webContents.executeJavaScript('window.fixtureWatchId')) as string,
      packet: { type: 'input', generation, frame: 1, sequence: 100, input: { kind: 'key', action: 'down', key: 'Shift' } } });
    await bridge.call(page, 'projectionSend', { watchId: (await viewer.webContents.executeJavaScript('window.fixtureWatchId')) as string,
      packet: { type: 'input', generation, frame: 1, sequence: 101, input: { kind: 'pointer', action: 'down', button: 'left', x: 0.5, y: 0.5 } } });
    await until(() => source.webContents.executeJavaScript('held.key && held.mouse'));
    service.setPermissionGranted(a.caller.extensionId, 'agents:tools', false);
    await assert.rejects(publisher.publish({ width: 1, height: 1, mime: 'image/png', data: 'YQ==' }), /revoked/);
    revokeExtensionProgramAccess(a.caller.extensionId);
    await until(() => viewer.webContents.executeJavaScript('document.querySelector("textarea").disabled'));
    await until(async () => stopped);
    await assert.rejects(publisher.publish({ width: 1, height: 1, mime: 'image/png', data: 'YQ==' }), /closed|revoked/i);
    assert.equal(await value(source), snapshot);
    assert.deepEqual(await source.webContents.executeJavaScript('held'), { key: false, mouse: false });
    assert.equal(bridge.count(b.caller.pageId), 1);
    await second.publish({ width: 1, height: 1, mime: 'image/png', data: 'YQ==' });
    await second.close();
  });
  bridge.closePage(page.pageId);
  bridge.closePage(a.caller.pageId);
  bridge.closePage(b.caller.pageId);
  for (const window of windows) window.destroy();
  process.stdout.write('PROJECTION_RESULT=' + JSON.stringify({ cases }) + '\n');
  app.exit(0);
});
