import assert from 'node:assert/strict';
import { BrowserWindow } from 'electron';
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createPageProtocol } from '../page-protocol';
import { withinDeadline } from './page-protocol-deadline';

type Check = (name: string, body: () => Promise<void>) => Promise<void>;

export async function pageProtocolNavigationEventChecks(url: string, check: Check) {
  await check('navigation-early-file-event', async () => {
    const window = new BrowserWindow({ show: false, webPreferences: { sandbox: true } });
    const contents = window.webContents;
    const file = path.join(process.env.GUGU_HOME!, 'owned-early-navigation.html');
    writeFileSync(file, '<title>Owned navigation event fixture</title>');
    const target = pathToFileURL(file).href;
    const native: Array<{ url: string; beforeStart: boolean }> = [], visible: string[] = [];
    let started = false;
    const onStarted = () => { started = true; };
    const onNative = (_event: unknown, method: string, params: { url?: string }) => {
      if (method === 'Page.frameStartedNavigating' && params.url === target) native.push({ url: params.url, beforeStart: !started });
    };
    try {
      await contents.loadURL(url);
      const lease = createPageProtocol(contents);
      lease.onMessage((method, params) => {
        if (method === 'Page.frameStartedNavigating' && typeof params.url === 'string') visible.push(params.url);
      });
      try {
        await lease.send('Page.enable');
        contents.debugger.prependListener('message', onNative);
        contents.prependListener('did-start-navigation', onStarted);
        await withinDeadline(contents.loadFile(file), 'owned early navigation');
        assert.ok(native.some(event => event.beforeStart), 'the fixture must receive the real file URL event before main navigation starts');
        assert.ok(!visible.includes(target), 'an early unsupported URL must not reach the App');
        assert.equal(lease.attached, false);
      } finally { lease.close(); }
    } finally {
      contents.debugger.removeListener('message', onNative);
      contents.removeListener('did-start-navigation', onStarted);
      window.destroy();
    }
  });
}
