import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { BrowserWindow, type WebContents } from 'electron';
import { createPageProtocol } from '../page-protocol';
import { withinDeadline } from './page-protocol-deadline';

type Check = (name: string, body: () => Promise<void>) => Promise<void>;

export async function pageProtocolBoundaryChecks(url: string, check: Check) {
  const withPage = async (body: (contents: WebContents, commands: string[]) => Promise<void>) => {
    const window = new BrowserWindow({ show: false, webPreferences: { sandbox: true } });
    const contents = window.webContents, commands: string[] = [];
    const nativeSend = contents.debugger.sendCommand.bind(contents.debugger);
    contents.debugger.sendCommand = ((...args: Parameters<typeof nativeSend>) => {
      commands.push(args[0]); return nativeSend(...args);
    }) as typeof nativeSend;
    try { await contents.loadURL(url + 'cookie-check'); await body(contents, commands); }
    finally { window.destroy(); }
  };
  await check('websocket-cookie-events', () => withPage(async contents => {
    await contents.loadURL(url + 'cookie-set');
    await contents.loadURL(url + 'cookie-check');
    const lease = createPageProtocol(contents), visible: unknown[] = [];
    let privateRawHeaders = false;
    let handshake: unknown;
    const observe = (_event: unknown, method: string, params: { response?: { requestHeadersText?: string } }) => {
      if (method === 'Network.webSocketHandshakeResponseReceived') {
        handshake = params;
        privateRawHeaders = params.response?.requestHeadersText?.includes('private-page-value') === true;
      }
    };
    contents.debugger.on('message', observe);
    lease.onMessage((method, params) => { if (method.startsWith('Network.webSocket')) visible.push(params); });
    try {
      await lease.send('Network.enable');
      await withinDeadline(contents.executeJavaScript(`new Promise((resolve, reject) => {
        const socket = new WebSocket(${JSON.stringify(url.replace('http:', 'ws:') + 'socket')});
        socket.onopen = () => { socket.close(); resolve(true); };
        socket.onerror = () => reject(new Error('fixture WebSocket handshake failed'));
      })`), 'WebSocket handshake');
      await new Promise<void>(resolve => setImmediate(resolve));
      assert.equal(await contents.executeJavaScript('document.cookie'), '');
      assert.ok(privateRawHeaders, 'the native WebSocket requestHeadersText must carry the fake HttpOnly cookie: ' + JSON.stringify(handshake));
      assert.ok(visible.length > 0);
      assert.ok(!JSON.stringify(visible).includes('private-page-value'), 'the App must not receive WebSocket handshake credentials');
    } finally { lease.close(); contents.debugger.removeListener('message', observe); }
  }));

  const file = path.join(process.env.GUGU_HOME!, 'owned-navigation-file.txt');
  writeFileSync(file, 'owned native navigation fixture');
  for (const [name, target] of [
    ['file', 'fi\nle://' + file], ['chrome', 'chro\nme://gpu'],
    ['devtools', 'devt\tools://devtools/bundled/inspector.html'],
  ]) await check('navigation-control-' + name, () => withPage(async (contents, commands) => {
    const lease = createPageProtocol(contents), before = commands.length;
    try {
      await assert.rejects(lease.send('Page.navigate', { url: target }), /unsupported navigation/);
      assert.equal(commands.length, before, 'control-character navigation must never reach native CDP');
      assert.equal(contents.getURL(), url + 'cookie-check');
    } finally { lease.close(); }
  }));

  await check('navigation-history-policy', () => withPage(async (contents, commands) => {
    await contents.loadURL(url + 'history-before');
    await contents.loadURL('chrome://gpu');
    await contents.loadURL(url + 'history-after');
    contents.debugger.attach('1.3');
    const history = await contents.debugger.sendCommand('Page.getNavigationHistory') as { entries: Array<{ id: number; url: string }> };
    contents.debugger.detach();
    const lease = createPageProtocol(contents);
    try {
      const internal = history.entries.find(entry => entry.url.startsWith('chrome://gpu'));
      const allowed = history.entries.find(entry => entry.url === url + 'history-before');
      assert.ok(internal && allowed, 'fixture must contain both internal and ordinary history entries');
      const before = commands.filter(command => command === 'Page.navigateToHistoryEntry').length;
      await assert.rejects(lease.send('Page.navigateToHistoryEntry', { entryId: internal.id }), /unsupported navigation/);
      assert.equal(commands.filter(command => command === 'Page.navigateToHistoryEntry').length, before);
      assert.equal(contents.getURL(), url + 'history-after');
      const loaded = new Promise<void>(resolve => contents.once('did-finish-load', () => resolve()));
      await lease.send('Page.navigateToHistoryEntry', { entryId: allowed.id });
      await withinDeadline(loaded, 'ordinary history navigation');
      assert.equal(contents.getURL(), allowed.url, 'ordinary browser back/forward must still work');
    } finally { lease.close(); }
  }));
}
