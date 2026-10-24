import { describe, expect, it } from 'vitest';
import { autoUpdatesFrom, marketUpdatesFrom, pinsAutoUpdate } from './market-entries';

// owner 10-19 (market Apps update by themselves, as VS Code's do): which version each App goes to, and when installing one
// pins it. Shared by main (auto-update-apps.ts) and the phone (phoneApps.ts).
const summary = (parts: Partial<Parameters<typeof autoUpdatesFrom>[0]>) => ({ checkedAt: '', updates: {}, yanked: {}, deprecated: {}, ...parts });

describe('autoUpdatesFrom', () => {
  it("goes to the market's version when it is newer, a withdrawn one's replacement included", () => {
    const s = summary({
      updates: { radar: { version: '1.1.0', releaseNotes: '' } },
      yanked: { office: { reason: 'broke', installable: '0.3.0' } },
    });
    expect(autoUpdatesFrom(s, [{ id: 'radar', version: '1.0.0' }, { id: 'office', version: '0.2.0' }])).toEqual([
      { id: 'radar', from: '1.0.0', version: '1.1.0' },
      { id: 'office', from: '0.2.0', version: '0.3.0' },
    ]);
  });

  it('never back to an older version, and not for an App left out by the caller', () => {
    const s = summary({ updates: { radar: { version: '1.1.0', releaseNotes: '' } }, yanked: { office: { reason: 'broke', installable: '0.1.0' } } });
    expect(autoUpdatesFrom(s, [{ id: 'office', version: '0.2.0' }])).toEqual([]);
    expect(autoUpdatesFrom(s, [])).toEqual([]);
  });
});

describe('pinsAutoUpdate', () => {
  it('pins an older version than the one offered; not the offered one, nor one the market does not offer', () => {
    expect(pinsAutoUpdate('1.0.0', '1.1.0')).toBe(true);
    expect(pinsAutoUpdate('1.1.0', '1.1.0')).toBe(false);
    expect(pinsAutoUpdate('1.0.0', null)).toBe(false);
  });
});

describe('marketUpdatesFrom: an App no longer in the market', () => {
  it('one installed from the market and absent from the index is gone; one from a folder or a chat never was in it', () => {
    const host = { platform: 'desktop' as const, appVersion: '0.2.60', apiVersionMin: 1, apiVersionMax: 99 };
    const told = marketUpdatesFrom({ apps: [] }, host, [{ id: 'radar', version: '1.0.0', fromMarket: true }, { id: 'mine', version: '0.1.0', fromMarket: false }], '');
    expect(told.gone).toEqual(['radar']);
    expect(told.updates).toEqual({});
  });
});
