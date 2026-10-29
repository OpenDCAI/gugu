import assert from 'node:assert/strict';
import { once } from 'node:events';
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { createServer } from 'node:http';
import { BrowserWindow } from 'electron';
import { createPageProtocol } from '../page-protocol';
import { isSupportedBrowserNavigationUrl } from '../browser-navigation';
import { withinDeadline } from './page-protocol-deadline';

type Check = (name: string, body: () => Promise<void>) => Promise<void>;

export async function pageProtocolLoadingChecks(url: string, check: Check) {
  await check('navigation-http-slow-resource', async () => {
    const window = new BrowserWindow({ show: false, webPreferences: { sandbox: true } });
    let arrived!: () => void;
    const slow = new Promise<void>(resolve => { arrived = resolve; });
    const server = createServer((request, response) => {
      if (request.url === '/slow.png') { arrived(); return; }
      response.setHeader('Content-Type', 'text/html');
      response.end('<body>normal HTTP page<img src="/slow.png"></body>');
    });
    server.on('error', error => { process.stderr.write(String(error)); window.destroy(); });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const address = server.address() as { port: number };
    const contents = window.webContents;
    try {
      const loading = contents.loadURL(`http://127.0.0.1:${address.port}/`);
      void loading.catch(() => {});
      await withinDeadline(slow, 'slow resource requested');
      assert.equal(contents.isLoading(), true);
      const lease = createPageProtocol(contents);
      try {
        await withinDeadline(lease.send('Runtime.enable'), 'HTTP page protocol attach');
        assert.equal(lease.attached, true);
        assert.equal(contents.isLoading(), true);
      } finally { lease.close(); }
    } finally { window.destroy(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
  });

  const file = path.join(process.env.GUGU_HOME!, 'owned-loading-race.html');
  writeFileSync(file, `<body>owned-navigation-race-secret<script>
    console.log(document.body.firstChild.textContent);
    if (typeof raceSecret === 'function') raceSecret(document.body.firstChild.textContent);
  </script></body>`);
  for (const api of ['url', 'file']) await check(api === 'url' ? 'navigation-already-loading' : 'navigation-already-loading-file-api', async () => {
    const window = new BrowserWindow({ show: false, webPreferences: { sandbox: true, partition: 'navigation-loading-race-' + api } });
    const contents = window.webContents, profile = contents.session;
    let release!: () => void, enter!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const entered = new Promise<void>(resolve => { enter = resolve; });
    try {
      await contents.loadURL(url);
      profile.protocol.handle('file', async () => {
        enter(); await gate;
        return new Response(readFileSync(file, 'utf8'), { headers: { 'Content-Type': 'text/html' } });
      });
      const started = once(contents, 'did-start-navigation');
      const loading = api === 'url' ? contents.loadURL('file://' + file) : contents.loadFile(file);
      void loading.catch(() => {});
      await withinDeadline(Promise.all([started, entered]), 'file navigation start');
      assert.equal(contents.isLoading(), true);
      assert.equal(contents.getURL(), url);
      const lease = createPageProtocol(contents), visible: unknown[] = [];
      let closed = '';
      lease.onClose(reason => { closed = reason; });
      lease.onMessage((method, params) => {
        if (method === 'Runtime.bindingCalled' || method === 'Runtime.consoleAPICalled') visible.push(params);
      });
      const opening = Promise.allSettled([lease.send('Page.enable'), lease.send('Runtime.enable'), lease.send('Runtime.addBinding', { name: 'raceSecret' }),
        lease.send('Page.addScriptToEvaluateOnNewDocument', { source: 'globalThis.__leaseInjected = true' })]);
      try {
        await new Promise(resolve => setTimeout(resolve, 400));
        const attachedDuringLoad = contents.debugger.isAttached();
        release();
        await withinDeadline(loading, 'file navigation commit');
        const result = await withinDeadline(opening, 'pending lease opening');
        const fileEventLeaked = JSON.stringify(visible).includes('owned-navigation-race-secret');
        const fileScriptRan = await contents.executeJavaScript('globalThis.__leaseInjected === true');
        process.stdout.write('LOADING_RACE_OBSERVATION=' + JSON.stringify({ api, attachedDuringLoad, fileEventLeaked, fileScriptRan, closed }) + '\n');
        assert.equal(attachedDuringLoad, false, 'an already-loading document must not receive a debugger lease');
        assert.equal(fileEventLeaked, false, 'file console and binding contents must not reach the App');
        assert.equal(fileScriptRan, false, 'App new-document scripts must not execute in the pending file page');
        assert.ok(result.every(item => item.status === 'rejected'));
        assert.match(closed, /unsupported navigation/);
      } finally { lease.close(); }
    } finally { release(); profile.protocol.unhandle('file'); window.destroy(); }
  });

  await check('navigation-forward-file-history', async () => {
    const window = new BrowserWindow({ show: false, webPreferences: { sandbox: true } });
    const contents = window.webContents;
    try {
      for (const target of [url + 'forward-before', 'file://' + file, url + 'forward-after']) await contents.loadURL(target);
      const history = contents.navigationHistory;
      const before = history.getAllEntries().findIndex(entry => entry.url === url + 'forward-before');
      const loadedBefore = once(contents, 'did-finish-load');
      history.goToIndex(before);
      await withinDeadline(loadedBefore, 'forward fixture start');
      assert.ok(history.getAllEntries().some((entry, index) => index > history.getActiveIndex() && entry.url.startsWith('file:')));
      const lease = createPageProtocol(contents);
      try {
        await lease.send('Runtime.enable');
        const loadedAfter = once(contents, 'did-finish-load');
        await lease.send('Runtime.evaluate', { expression: 'history.go(1)' });
        await withinDeadline(loadedAfter, 'ordinary forward navigation');
        assert.equal(contents.getURL(), url + 'forward-after');
        assert.ok(history.getAllEntries().every(entry => isSupportedBrowserNavigationUrl(entry.url)));
      } finally { lease.close(); }
    } finally { window.destroy(); }
  });
}
