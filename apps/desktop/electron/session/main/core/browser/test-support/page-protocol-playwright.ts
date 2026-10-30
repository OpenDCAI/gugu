import { app, BrowserWindow, WebContentsView } from 'electron';
import '../../../../../page-navigation-bootstrap';
import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import path from 'node:path';
import { writeFileSync } from 'node:fs';
import assert from 'node:assert/strict';
import { BrowserPageRuntime } from '../browser-page-runtime';
import { createPaneTransport, agentCursorArrived, agentBrowserToolStarting, agentBrowserToolFinished } from '../agent-browser';
import { createBrowserAppProgram } from '../../../../../browser-agent-mcp';
import { createPageProtocol } from '../page-protocol';
import { pageProtocolBoundaryChecks } from './page-protocol-boundary-checks';
import { pageProtocolHistoryChecks } from './page-protocol-history-checks';
import { pageProtocolLoadingChecks } from './page-protocol-loading-checks';
import { pageProtocolNavigationEventChecks } from './page-protocol-navigation-event-checks';

const cases: Record<string, { passed: boolean; error?: string }> = {};
const commands: string[] = [];
const globals = globalThis as typeof globalThis & { pageProbeEvent?: (_channel: unknown, event: { kind?: string; moveId?: number }) => void };
globals.pageProbeEvent = (_channel, event) => {
  if (event.kind === 'move' && event.moveId) queueMicrotask(() => agentCursorArrived(event.moveId!));
};
app.commandLine.appendSwitch('site-per-process');
process.on('uncaughtException', error => { process.stderr.write(String(error) + '\n'); app.exit(1); });
process.on('unhandledRejection', error => { process.stderr.write(String(error) + '\n'); app.exit(1); });

async function run() {
  assert.ok(process.env.GUGU_HOME && process.env.GUGU_USER_DATA_DIR);
  app.setPath('userData', process.env.GUGU_USER_DATA_DIR!);
  await app.whenReady();
  assert.equal(app.getPath('userData'), process.env.GUGU_USER_DATA_DIR);
  let port = 0;
  let receivedPrivateCookie = false;
  const server = createServer((request, response) => {
    response.setHeader('Content-Type', 'text/html');
    if (request.url === '/cookie-set') response.setHeader('Set-Cookie', 'page_secret=private-page-value; HttpOnly; Path=/');
    if (request.url === '/cookie-check') receivedPrivateCookie = request.headers.cookie?.includes('page_secret=private-page-value') === true;
    response.end(request.url?.startsWith('/frame')
      ? '<!doctype html><button id="inside" onclick="document.body.dataset.clicked=\'yes\'">Inside frame</button>'
      : `<!doctype html><title>Scoped browser protocol</title>
        <iframe id="same" src="/frame" title="same origin"></iframe>
        <iframe id="cross" src="http://localhost:${port}/frame" title="cross site"></iframe>
        <div id="drag" draggable="true" style="padding:30px;width:120px" ondragstart="event.dataTransfer.setData('text/plain','fixture')">Drag me</div>
        <div id="drop" style="padding:40px;width:160px" ondragover="event.preventDefault()" ondrop="event.preventDefault();document.body.dataset.dropped=event.dataTransfer.getData('text/plain')">Drop here</div>`);
  });
  server.on('error', error => {
    process.stderr.write(`page protocol fixture server failed: ${String(error)}\n`);
    app.exit(1);
  });
  server.on('upgrade', (request, socket) => {
    const accept = createHash('sha1').update(request.headers['sec-websocket-key'] + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
    socket.on('error', () => socket.destroy());
    socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
    socket.once('data', () => socket.end(Buffer.from([0x88, 0])));
  });
  await new Promise<void>(resolve => server.listen(0, resolve));
  port = (server.address() as { port: number }).port;
  const window = new BrowserWindow({ width: 1100, height: 800, show: false });
  const view = new WebContentsView({ webPreferences: { sandbox: true, partition: 'persist:page-protocol-probe' } });
  const runtime = new BrowserPageRuntime(view);
  runtime.moveTo(window); runtime.layout({ x: 0, y: 0, width: 1080, height: 760 }, true);
  await runtime.navigate(`http://127.0.0.1:${port}/`);
  const contents = view.webContents;
  const nativeSend = contents.debugger.sendCommand.bind(contents.debugger);
  contents.debugger.sendCommand = ((...args: Parameters<typeof nativeSend>) => {
    commands.push(args[0]); return nativeSend(...args);
  }) as typeof nativeSend;
  const program = { extensionId: 'native-page-protocol-test', server: 'browser-use', native: 'browser-use' as const,
    digest: 'test', command: 'test', args: [], env: {}, cwd: process.env.PAGE_PROBE_REPO!, dataDir: process.env.GUGU_HOME! };
  const check = async (name: string, body: () => Promise<void>) => {
    try { await body(); cases[name] = { passed: true }; }
    catch (error) { cases[name] = { passed: false, error: String(error) }; }
  };
  for (const frame of ['same', 'cross']) await check(frame + '-iframe-click', async () => {
    const provider = createBrowserAppProgram(() => ({
      openTransport: async (sid, signal) => createPaneTransport(sid, sid, contents, signal), toolStarting: agentBrowserToolStarting,
      toolFinished: agentBrowserToolFinished, setInitialUrl() {}, workspaceRoot: async () => program.cwd,
    }));
    const sid = 'iframe-' + frame;
    try {
      const result = await provider.call(program, { name: 'browser_click', arguments: {
        target: `#${frame} >> internal:control=enter-frame >> #inside`,
      }, _meta: { 'gugu/sessionId': sid } }, new AbortController().signal);
      assert.notEqual(result.isError, true, JSON.stringify(result));
      assert.ok(commands.includes('DOM.getFrameOwner'));
      // Read the native child frame itself, including the cross-site OOPIF.
      const nativeFrame = contents.mainFrame.frames.find(child => child.url.includes(frame === 'same' ? '127.0.0.1' : 'localhost'));
      assert.ok(nativeFrame);
      assert.equal(await nativeFrame.executeJavaScript('document.body.dataset.clicked'), 'yes');
    } finally { await provider.retire(program.extensionId); }
  });
  await check('html-drag', async () => {
    const provider = createBrowserAppProgram(() => ({
      openTransport: async (sid, signal) => createPaneTransport(sid, sid, contents, signal), toolStarting: agentBrowserToolStarting,
      toolFinished: agentBrowserToolFinished, setInitialUrl() {}, workspaceRoot: async () => program.cwd,
    }));
    try {
      const result = await provider.call(program, { name: 'browser_drag', arguments: { startTarget: '#drag', endTarget: '#drop' },
        _meta: { 'gugu/sessionId': 'drag' } }, new AbortController().signal);
      assert.notEqual(result.isError, true, JSON.stringify(result));
      assert.equal(await contents.executeJavaScript('document.body.dataset.dropped'), 'fixture');
      assert.ok(commands.includes('Input.setInterceptDrags') && commands.includes('Input.dispatchDragEvent'));
    } finally { await provider.retire(program.extensionId); }
  });
  const requireHere = createRequire(path.join(process.env.PAGE_PROBE_REPO!, 'package.json'));
  const { chromium } = createRequire(requireHere.resolve('@playwright/mcp'))('playwright-core') as typeof import('playwright-core');
  for (const cause of ['surface failed', 'the page debugger is already in use']) await check(cause, async () => {
    const failureView = new WebContentsView({ webPreferences: { sandbox: true } });
    const failurePage = new BrowserPageRuntime(failureView);
    failurePage.moveTo(window);
    const visible = failureView.setVisible.bind(failureView);
    if (cause === 'surface failed') failureView.setVisible = () => { throw new Error(cause); };
    else failureView.webContents.debugger.attach('1.3');
    const transport = createPaneTransport('early-' + cause, 'failure', failureView.webContents);
    await new Promise<void>(resolve => setImmediate(resolve));
    failureView.setVisible = visible;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const error = await Promise.race([
        chromium.connectOverCDP(transport).then(() => '', error => String(error)),
        new Promise<string>(resolve => { timer = setTimeout(() => resolve('lost close: still waiting'), 2000); }),
      ]);
      assert.ok(error.includes(cause), error);
      assert.equal(failureView.webContents.debugger.isAttached(), cause !== 'surface failed');
    } finally { clearTimeout(timer); transport.close(); failurePage.close(); }
  });
  await check('http-only-cookie-events', async () => {
    const lease = createPageProtocol(contents);
    const visible: unknown[] = [];
    let privateRequest = false, privateResponse = false;
    const observeNative = (_event: unknown, method: string, params: unknown) => {
      const raw = JSON.stringify(params);
      if (method === 'Network.requestWillBeSentExtraInfo' && raw.includes('private-page-value')) privateRequest = true;
      if (method === 'Network.responseReceivedExtraInfo' && raw.includes('private-page-value')) privateResponse = true;
    };
    contents.debugger.on('message', observeNative);
    lease.onMessage((method, params) => { if (method.startsWith('Network.')) visible.push(params); });
    try {
      await lease.send('Network.enable');
      for (const route of ['/cookie-set', '/cookie-check']) {
        const loaded = new Promise<void>(resolve => contents.once('did-finish-load', () => resolve()));
        await lease.send('Page.navigate', { url: `http://127.0.0.1:${port}${route}` });
        await loaded;
      }
      assert.equal(await contents.executeJavaScript('document.cookie'), '');
      assert.ok(receivedPrivateCookie && privateRequest && privateResponse, 'fixture must actually receive and expose HttpOnly cookie events');
      assert.ok(visible.length > 0);
      assert.ok(!JSON.stringify(visible).includes('private-page-value'), 'the App must not receive the raw cookie value');
    } finally { lease.close(); contents.debugger.removeListener('message', observeNative); }
  });
  await check('navigation-schemes', async () => {
    const lease = createPageProtocol(contents);
    const before = commands.length;
    try {
      for (const url of ['chrome://gpu', 'devtools://devtools/bundled/inspector.html']) {
        await assert.rejects(lease.send('Page.navigate', { url }), /unsupported navigation/);
      }
      assert.equal(commands.length, before, 'unsupported navigation must never reach the native debugger');
    } finally { lease.close(); }
  });
  await check('drag-files', async () => {
    const lease = createPageProtocol(contents);
    const file = path.join(process.env.GUGU_HOME!, 'owned-file.txt');
    writeFileSync(file, 'owned native drag fixture');
    const before = commands.length;
    try {
      await assert.rejects(lease.send('Input.dispatchDragEvent', { type: 'dragEnter', x: 1, y: 1,
        data: { files: [file], items: [], dragOperationsMask: 1 } }), /local files/);
      assert.equal(commands.length, before, 'local file drag must never reach the native debugger');
    } finally { lease.close(); }
  });
  await pageProtocolBoundaryChecks(`http://127.0.0.1:${port}/`, check);
  await pageProtocolHistoryChecks(`http://127.0.0.1:${port}/`, check);
  await pageProtocolLoadingChecks(`http://127.0.0.1:${port}/`, check);
  await pageProtocolNavigationEventChecks(`http://127.0.0.1:${port}/`, check);
  process.stdout.write('PAGE_PROTOCOL_RESULT=' + JSON.stringify({ cases, commands }) + '\n');
  runtime.close(); window.destroy(); server.closeAllConnections(); server.close();
}
void run().then(() => app.exit(0), error => { process.stderr.write(String(error) + '\n'); app.exit(1); });
