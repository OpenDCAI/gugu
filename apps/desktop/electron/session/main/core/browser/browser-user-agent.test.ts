import { describe, expect, it } from 'vitest';
import { stripEmbeddedBrowserTokens } from './browser-user-agent';

// Shape Electron builds: `<prefix> <AppName>/<ver> Chrome/<ver> Electron/<ver> Safari/537.36`.
const PREFIX =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko)';
const CHROME = 'Chrome/152.0.7977.54';
const SAFARI = 'Safari/537.36';

describe('stripEmbeddedBrowserTokens', () => {
  it('strips the app-name and Electron tokens', () => {
    expect(
      stripEmbeddedBrowserTokens(
        `${PREFIX} 咕咕/0.2.55 ${CHROME} Electron/44.0.0 ${SAFARI}`,
        '咕咕'
      )
    ).toBe(`${PREFIX} ${CHROME} ${SAFARI}`);
  });

  // #7270: Electron drops spaces from the app name in the UA token, so 「咕咕 Beta」 shows up as `咕咕Beta/…`.
  it('strips the app-name token when the app name contains spaces', () => {
    expect(
      stripEmbeddedBrowserTokens(
        `${PREFIX} 咕咕Beta/0.2.55-beta.84.1 ${CHROME} Electron/44.0.0 ${SAFARI}`,
        '咕咕 Beta'
      )
    ).toBe(`${PREFIX} ${CHROME} ${SAFARI}`);
  });
});
