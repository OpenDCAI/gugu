import { describe, expect, it } from 'vitest';
import { EXTENSION_API_VERSION } from './manifest';
import { pickForHost, type MarketHost } from './market';

/**
 * apiVersion 7 (10-19): a link in a session's chat to a working-copy file carries a place (`path#k=v`, classifyFileLink),
 * handed to the App that opens it as `onLink`. Before it such a link opened nothing ("Could not find <path>#… in this
 * workspace"), and 0.2.57 Betas before and after share x.y.z — so an App whose agents cite such links says 7, and a host
 * that knows only 6 is handed its last version for 6.
 */
describe('the market hands a host that knows only 6 the last version for 6', () => {
  const rows = [
    { version: '0.2.0', apiVersion: 6, minAppVersion: '0.2.57' },
    { version: '0.3.0', apiVersion: 7, minAppVersion: '0.2.57' },
  ];
  const host = (apiVersionMax: number): MarketHost => ({ appVersion: '0.2.57-beta.107.1', apiVersionMin: 3, apiVersionMax });

  it('this build knows 7', () => {
    expect(EXTENSION_API_VERSION).toBeGreaterThanOrEqual(7);
  });

  it('api 6: stays on 0.2.0 and is told a newer one needs a newer gugu', () => {
    const { chosen, newerNeedsApp } = pickForHost(rows, host(6));
    expect(chosen?.version).toBe('0.2.0');
    expect(newerNeedsApp).toBe('0.3.0');
  });

  it('api 7: gets 0.3.0', () => {
    const { chosen, newerNeedsApp } = pickForHost(rows, host(7));
    expect(chosen?.version).toBe('0.3.0');
    expect(newerNeedsApp).toBeNull();
  });
});
