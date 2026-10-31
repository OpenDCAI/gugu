import { describe, expect, it } from 'vitest';
import { pickForHost, type MarketHost } from './market';

/**
 * apiVersion 6 (10-19, #7478 `chat:read` / `gugu.messages`). The 0.2.57 Betas before #7478 and after it share x.y.z, and
 * the market compares only x.y.z (`appSatisfies`) — so `engines` cannot keep an App that reads messages away from a
 * client that has no `chat:read` in its schema. The interface number does: a host that knows only 5 is handed the App's
 * last version for 5 (`compatOf` → needs-newer-app), never the new one. (The manifest-side gate is gone with apiVersion 24,
 * below which nothing runs; the market's choice by number is what stays.)
 */

describe('the market hands a host that knows only 5 the last version for 5', () => {
  const rows = [
    { version: '0.1.1', apiVersion: 5, minAppVersion: '0.2.57' },
    { version: '0.2.0', apiVersion: 6, minAppVersion: '0.2.57' },
  ];
  const host = (apiVersionMax: number): MarketHost => ({ platform: 'desktop' as const, appVersion: '0.2.57-beta.103.1', apiVersionMin: 3, apiVersionMax });

  it('api 5: stays on 0.1.1 and is told a newer one needs a newer gugu', () => {
    const { chosen, newerNeedsApp } = pickForHost(rows, host(5));
    expect(chosen?.version).toBe('0.1.1');
    expect(chosen?.compat).toBeNull();
    expect(newerNeedsApp).toBe('0.2.0');
  });

  it('api 6: gets 0.2.0', () => {
    const { chosen, newerNeedsApp } = pickForHost(rows, host(6));
    expect(chosen?.version).toBe('0.2.0');
    expect(newerNeedsApp).toBeNull();
  });
});
