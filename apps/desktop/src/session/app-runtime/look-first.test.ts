// @vitest-environment jsdom
import { beforeAll, describe, expect, it } from 'vitest';
import { APP_RUNTIME_UI_CSS, APP_RUNTIME_UI_JS } from '@shared/extensions/app-runtime-protocol';

/**
 * gugu.js (the first script of every App page, put there by the host) writes gugu's look into the page right after
 * itself: ui.css, then ui.js — into the parser's stream, so both come before anything of the App's own, the first paint
 * already has the look, and ui.js finds `window.gugu`. (Control: the parent commit, which writes nothing.)
 *
 * And the theme first: the host's `theme` is on `<html>` before the look is written, so that first paint is in gugu's
 * theme, not the OS's (control: the parent commit, where `<html>` had none until the context came, after the paint).
 */

const written: string[] = [];
const themeWhenWritten: (string | undefined)[] = [];

beforeAll(async () => {
  (window as unknown as { __guguHost: unknown }).__guguHost = {
    apiVersion: 1,
    theme: 'light',
    reportError: async () => undefined,
    onFilesChanged: () => () => undefined,
    appFiles: {},
  };
  // The parser is still reading the page when the host's first script runs.
  Object.defineProperty(document, 'readyState', { configurable: true, get: () => 'loading' });
  document.write = (...markup: string[]) => {
    written.push(markup.join(''));
    themeWhenWritten.push(document.documentElement.dataset.guguTheme);
  };
  await import('./gugu-entry');
});

describe('gugu\'s look, first in every App page', () => {
  it('writes ui.css then ui.js once, absolute against the page (a phone frame\'s base is about:blank)', () => {
    expect(written).toHaveLength(1);
    const css = new URL(APP_RUNTIME_UI_CSS, location.href).href;
    const js = new URL(APP_RUNTIME_UI_JS, location.href).href;
    expect(written[0]).toBe(`<link rel="stylesheet" href="${css}"><script src="${js}"></script>`);
  });

  it('after window.gugu exists: ui.js reads it', () => {
    expect((window as unknown as { gugu?: unknown }).gugu).toBeDefined();
  });

  it('puts the host\'s theme on <html> before the look, and not on window.gugu (the App reads it from its context)', () => {
    expect(themeWhenWritten).toEqual(['light']);
    expect('theme' in (window as unknown as { gugu: object }).gugu).toBe(false);
  });
});
