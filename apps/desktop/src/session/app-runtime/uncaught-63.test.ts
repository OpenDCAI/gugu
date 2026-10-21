// @vitest-environment jsdom
import { EXTENSION_API_VERSION } from '@shared/extensions/bridge-protocol';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';

/**
 * 摩擦单 F63 (L7-s): an App's 「提交」 threw a TypeError nobody caught; nothing said so, and `app_check` read the
 * App as fine. Whatever an App page does not catch goes to its error record, the way `gugu.reportError` does.
 * One page per file (`window.gugu` is installed once, for good): the host's answer is switched between cases.
 */

const reported: string[] = [];
let failing = false;

beforeAll(async () => {
  (window as unknown as { __guguHost: unknown }).__guguHost = {
    apiVersion: EXTENSION_API_VERSION,
    reportError: async (message: string) => {
      reported.push(message);
      if (failing) throw new Error('host gone');
    },
    onFilesChanged: () => () => undefined,
    appFiles: {},
  };
  await import('./gugu-entry');
});

beforeEach(() => {
  reported.length = 0;
  failing = false;
});

const settle = () => new Promise((resolve) => setTimeout(resolve, 10));

describe('an App page’s uncaught errors are its errors (摩擦单 F63)', () => {
  it('an uncaught exception: recorded with where it happened, once however often it recurs', async () => {
    const thrown = () =>
      window.dispatchEvent(
        new ErrorEvent('error', { error: new TypeError('submit is not a function'), message: 'Uncaught TypeError', filename: 'gugu-ext://l7-review/app.js', lineno: 42 }),
      );
    thrown();
    thrown();
    await settle();
    expect(reported).toEqual(['Uncaught TypeError: submit is not a function (app.js:42)']);
  });

  it('thrown by the runtime for the App’s call (F96’s confirm()): where is the App’s line that called it, not the runtime’s', async () => {
    const error = new Error('confirm() does not exist in an App page');
    error.stack = [
      'Error: confirm() does not exist in an App page',
      '    at window.confirm (gugu-ext://board/_gugu/1/gugu.js:1:2045)',
      '    at HTMLButtonElement.submit (gugu-ext://board/app.js:42:7)',
    ].join('\n');
    window.dispatchEvent(new ErrorEvent('error', { error, message: 'Uncaught Error', filename: 'gugu-ext://board/_gugu/1/gugu.js', lineno: 1 }));
    await settle();
    // Control (the parent commit): «(gugu.js:1)» — the runtime's line, nothing the author can act on.
    expect(reported).toEqual(['Uncaught Error: confirm() does not exist in an App page (app.js:42)']);
  });

  it('a promise the App let reject unhandled: recorded too', async () => {
    window.dispatchEvent(Object.assign(new Event('unhandledrejection'), { reason: new Error('Could not open votes.json: not-found') }));
    await settle();
    expect(reported).toEqual(['Unhandled rejection: Error: Could not open votes.json: not-found']);
  });

  // App作用域 10-05 (9857): app.js imported a ./glue.js its bundle did not have — a blank page, and app_check said ok.
  it('a script that cannot load, or a module it imports: recorded, though its error stays on the element', async () => {
    const script = Object.assign(document.createElement('script'), { type: 'module', src: 'gugu-ext://gugu-2048/app.js' });
    const sheet = Object.assign(document.createElement('link'), { rel: 'stylesheet', href: 'gugu-ext://gugu-2048/style.css' });
    document.body.append(script, sheet);
    // As the browser fires it: on the element, not bubbling. Control (the parent commit): nothing recorded.
    script.dispatchEvent(new Event('error'));
    sheet.dispatchEvent(new Event('error'));
    document.body.append(Object.assign(document.createElement('img'), { src: 'https://example.invalid/a.png' }));
    document.body.lastElementChild!.dispatchEvent(new Event('error'));
    await settle();
    expect(reported).toEqual([
      'Could not load app.js (or a module it imports): it did not run. Is a file missing from the App?',
      'Could not load style.css. Is a file missing from the App?',
    ]);
  });

  it('a reportError that itself fails does not loop back as another unhandled rejection', async () => {
    failing = true;
    window.dispatchEvent(new ErrorEvent('error', { error: new Error('boom'), message: 'boom' }));
    await settle();
    expect(reported).toEqual(['Uncaught Error: boom']);
  });
});
