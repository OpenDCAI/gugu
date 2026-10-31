import { describe, expect, it } from 'vitest';
import { appListingProblems } from './app-listing';

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52, 0, 0, 0, 1, 0, 0, 0, 1]);
const listing = (manifest: Record<string, unknown>, more: Record<string, unknown> = {}) => appListingProblems({
  manifest: { subtitle: 'A probe', defaultLocale: 'en', engines: { gugu: '>=0.3.1' }, ...manifest },
  about: { en: 'Probe probes.' },
  screenshots: [{ name: '1.png', bytes: PNG }],
  whatsNew: 'First release.',
  icon: PNG,
  ...more,
});

describe('what a listed version needs (app-listing.ts)', () => {
  it('a complete listing has no problems', () => {
    expect(listing({})).toEqual([]);
  });

  it('every subtitle fits one line, the localized ones too (the client refuses a manifest whose subtitle is longer)', () => {
    expect(listing({ localized: { 'zh-CN': { subtitle: '探针' } } }, { about: { en: 'Probe.', 'zh-CN': '探针。' } })).toEqual([]);
    expect(listing({ localized: { 'zh-CN': { subtitle: '探针' }, de: { subtitle: 'x'.repeat(31) } } }, { about: { en: 'Probe.', 'zh-CN': '探针。', de: 'Sonde.' } }))
      .toEqual(['localized.de.subtitle: 1–30 characters']);
  });

  it('about is text only, in every language the manifest is written in', () => {
    expect(listing({}, { about: { en: 'See ![x](a.png)' } })).toEqual(['store/about.md: text only — screenshots go in store/screenshots/']);
    expect(listing({ localized: { fr: { name: 'Sonde' } } })).toEqual(['store/about.fr.md: missing — the product page\'s 关于 in every language the manifest is written in']);
  });
});
