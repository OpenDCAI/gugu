import { describe, expect, it } from 'vitest';
import { EXTENSION_API_VERSION } from './manifest';
import { pickForHost, type MarketHost } from './market';

/**
 * apiVersion 10 (10-23): `gugu.compose(text)` may name no place — the host asks the person where. A client before it
 * refuses that call (`Say where`), so an App that leaves the place to the host says 10, and a host that knows only 9 is
 * handed its last version for 9 (Paper Club 0.3.3, which draws its own list), never one whose ask would fail.
 */
describe('the market hands a host that knows only 9 the last version for 9', () => {
  const rows = [
    { version: '0.3.3', apiVersion: 8, minAppVersion: '0.2.57' },
    { version: '0.3.4', apiVersion: 10, minAppVersion: '0.2.57' },
  ];
  const host = (apiVersionMax: number): MarketHost => ({ appVersion: '0.2.58', apiVersionMin: 3, apiVersionMax });

  it('this build knows 10', () => {
    expect(EXTENSION_API_VERSION).toBeGreaterThanOrEqual(10);
  });

  it('api 9: stays on 0.3.3 and is told a newer one needs a newer gugu', () => {
    const { chosen, newerNeedsApp } = pickForHost(rows, host(9));
    expect(chosen?.version).toBe('0.3.3');
    expect(newerNeedsApp).toBe('0.3.4');
  });

  it('api 10: gets 0.3.4', () => {
    const { chosen, newerNeedsApp } = pickForHost(rows, host(10));
    expect(chosen?.version).toBe('0.3.4');
    expect(newerNeedsApp).toBeNull();
  });
});
