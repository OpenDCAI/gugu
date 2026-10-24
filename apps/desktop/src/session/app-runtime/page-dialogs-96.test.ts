// @vitest-environment jsdom
import { EXTENSION_API_VERSION } from '@shared/extensions/bridge-protocol';
import { beforeAll, describe, expect, it } from 'vitest';
import { noPageDialog } from '@shared/extensions/app-runtime-protocol';

/**
 * 摩擦单 F96: an App page has no `alert` / `confirm` / `prompt`. The runtime — the first script of every App page, on
 * the desktop and in the phone's frame — makes each throw what to do instead, the sentence `app_check` says of a
 * bundle that calls one; a call from a click is the App's error, recorded like any other; an App's own `alert` is its own.
 * (Control: the parent commit, where the page keeps the browser's own and nothing is recorded.)
 */

const reported: string[] = [];

beforeAll(async () => {
  (window as unknown as { __guguHost: unknown }).__guguHost = {
    apiVersion: EXTENSION_API_VERSION,
    reportError: async (message: string) => {
      reported.push(message);
    },
    onFilesChanged: () => () => undefined,
    appFiles: {},
  };
  await import('./gugu-entry');
});

const settle = () => new Promise((resolve) => setTimeout(resolve, 10));

describe('no page dialogs in an App page (摩擦单 F96)', () => {
  it('alert, confirm and prompt throw what to do instead, pointing at the guide', () => {
    expect(() => window.alert('saved')).toThrow(noPageDialog('alert'));
    expect(() => window.confirm('delete?')).toThrow(noPageDialog('confirm'));
    expect(() => window.prompt('name?')).toThrow(noPageDialog('prompt'));
    expect(noPageDialog('confirm')).toContain('use gugu.modal.open({ entry, title }) (guide: apps-page)');
  });

  it('called from a click, it is the App’s error: recorded, where it happened', async () => {
    const button = document.createElement('button');
    button.addEventListener('click', () => window.confirm('really?'));
    document.body.append(button);
    button.click();
    await settle();
    expect(reported).toEqual([expect.stringContaining(`Uncaught Error: ${noPageDialog('confirm')}`)]);
  });

  it('an App’s own `alert` (a toast of its own) is its own: only the dialog that stops the page is gone', () => {
    const shown: string[] = [];
    window.alert = (message?: unknown) => void shown.push(String(message));
    window.alert('saved');
    expect(shown).toEqual(['saved']);
  });
});
