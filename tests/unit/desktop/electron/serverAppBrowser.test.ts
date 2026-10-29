import { describe, expect, it } from 'vitest';
import { findAppBrowser, type ChromeFs } from '../../../../apps/desktop/electron/server/app-browser';

const files = (...paths: string[]): ChromeFs => ({ statSync: (file: string) => {
  if (!paths.includes(file)) throw new Error('not found');
  return { isFile: () => true };
} } as ChromeFs);

describe('the browser for generic App background HTML', () => {
  it('uses the explicitly configured executable and refuses an invalid pin instead of choosing another browser', () => {
    expect(findAppBrowser({ GUGU_APP_BROWSER_CHROME: '/pinned/chrome', PATH: '/bin' }, files('/pinned/chrome', '/bin/chromium'))).toBe('/pinned/chrome');
    expect(findAppBrowser({ GUGU_APP_BROWSER_CHROME: '/missing', PATH: '/bin' }, files('/bin/chromium'))).toBeNull();
  });
  it('uses a locally installed browser from PATH when there is no pin, or reports it absent', () => {
    expect(findAppBrowser({ PATH: '/bin' }, files('/bin/chromium'))).toBe('/bin/chromium');
    expect(findAppBrowser({ PATH: '/bin' }, files())).toBeNull();
  });
});
