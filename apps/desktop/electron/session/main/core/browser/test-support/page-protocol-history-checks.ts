import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { BrowserWindow } from 'electron';
import { createPageProtocol } from '../page-protocol';
import { isSupportedBrowserNavigationUrl } from '../browser-navigation';
import { withinDeadline } from './page-protocol-deadline';

export async function pageProtocolHistoryChecks(url: string, check: (name: string, body: () => Promise<void>) => Promise<void>) {
  const file = path.join(process.env.GUGU_HOME!, 'owned-history-secret.txt');
  writeFileSync(file, 'owned history fixture');
  for (const timing of ['current', 'owner-navigation']) await check('history-file-' + timing, async () => {
    const window = new BrowserWindow({ show: false, webPreferences: { sandbox: true } });
    const contents = window.webContents;
    try {
      await withinDeadline(contents.loadURL(timing === 'current' ? 'file://' + file : url), 'history current-page fixture');
      const lease = createPageProtocol(contents);
      let closed = '';
      lease.onClose(reason => { closed = reason; });
      try {
        if (timing === 'owner-navigation') {
          await lease.send('Runtime.enable');
          await withinDeadline(contents.loadURL('file://' + file), 'owner navigation');
          assert.match(closed, /unsupported navigation/, 'native main navigation must revoke the borrowed connection');
        }
        await assert.rejects(lease.send('Runtime.evaluate', { expression: 'document.body.innerText' }), /unsupported navigation/);
        assert.equal(contents.debugger.isAttached(), false);
        assert.equal(contents.getURL(), 'file://' + file, 'the person still owns the original page');
      } finally { lease.close(); }
    } finally { window.destroy(); }
  });
  for (const [scheme, target] of [['file', 'file://' + file], ['chrome', 'chrome://gpu']]) {
    for (const input of ['script', 'alt-left', 'mouse-back']) await check('history-' + scheme + '-' + input, async () => {
      const window = new BrowserWindow({ show: false, webPreferences: { sandbox: true } });
      const contents = window.webContents;
      try {
        for (const page of [url + 'history-safe-before', target!, url + 'history-safe-current']) {
          await withinDeadline(contents.loadURL(page), 'history fixture navigation');
        }
        assert.ok(contents.navigationHistory.getAllEntries().some(entry => entry.url.startsWith(scheme + ':')), 'fixture must contain a forbidden history entry');
        const lease = createPageProtocol(contents);
        try {
          await lease.send('Runtime.enable');
          if (input === 'script') await withinDeadline(lease.send('Runtime.evaluate', { expression: 'history.go(-1)' }), 'history script');
          else if (input === 'alt-left') {
            for (const type of ['keyDown', 'keyUp']) await lease.send('Input.dispatchKeyEvent', {
              type, modifiers: 1, key: 'ArrowLeft', code: 'ArrowLeft', windowsVirtualKeyCode: 37,
            });
          } else {
            for (const type of ['mousePressed', 'mouseReleased']) await lease.send('Input.dispatchMouseEvent', {
              type, button: 'back', buttons: type === 'mousePressed' ? 8 : 0, x: 20, y: 20, clickCount: 1,
            });
          }
          await new Promise(resolve => setTimeout(resolve, 150));
          process.stdout.write('HISTORY_INPUT_OBSERVATION=' + JSON.stringify({ scheme, input, landedUrl: contents.getURL() }) + '\n');
          assert.ok(isSupportedBrowserNavigationUrl(contents.getURL()), 'history input reached an unsupported URL: ' + contents.getURL());
          const entries = contents.navigationHistory.getAllEntries();
          assert.ok(entries.every(entry => isSupportedBrowserNavigationUrl(entry.url)), 'no input path may retain a forbidden history target');
          assert.ok(entries.some(entry => entry.url === url + 'history-safe-before'), 'ordinary prior history must remain');
          if (input === 'script') assert.equal(contents.getURL(), url + 'history-safe-before');
        } finally { lease.close(); }
      } finally { window.destroy(); }
    });
  }
}
