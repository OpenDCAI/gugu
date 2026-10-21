import { describe, expect, it } from 'vitest';
import { archiveRefusal, bundleProblems, unpackedTooMuch } from './bundle-checks';
import { MAX_BUNDLE_ENTRIES, MAX_BUNDLE_UNPACKED_BYTES } from './market';

// The rules main's unpackBundle / validateExtensionBundle apply and the phone's App store applies to the same package
// (L9). Their own suites (market-catalog, extension-validate, extension-archive) run unchanged on top of these.

describe('archiveRefusal: before the first byte is unpacked', () => {
  it('passes an ordinary package', () => {
    expect(archiveRefusal(['manifest.json', 'index.html', 'assets/', 'assets/app.js'])).toBeNull();
  });

  it('refuses the whole package for one bad path, or too many entries', () => {
    expect(archiveRefusal(['manifest.json', '../outside.js'])).toBe('Refusing to unpack this bundle — path escapes the bundle: ../outside.js');
    expect(archiveRefusal(['manifest.json', '_gugu/1/gugu.js'])).toContain('reserved path');
    expect(archiveRefusal(Array.from({ length: MAX_BUNDLE_ENTRIES + 1 }, (_, i) => `f${i}.js`))).toBe(
      `Bundle has too many entries: ${MAX_BUNDLE_ENTRIES + 1} > ${MAX_BUNDLE_ENTRIES}`,
    );
  });
});

describe('unpackedTooMuch: counted as the bytes come', () => {
  it('stops just past the limit', () => {
    expect(unpackedTooMuch(MAX_BUNDLE_UNPACKED_BYTES)).toBeNull();
    expect(unpackedTooMuch(MAX_BUNDLE_UNPACKED_BYTES + 1)).toBe(`Bundle unpacks to more than ${MAX_BUNDLE_UNPACKED_BYTES} bytes`);
  });
});

describe('bundleProblems: what a package holds', () => {
  it('has none for files and folders within the limits', () => {
    expect(
      bundleProblems([
        { path: 'manifest.json', kind: 'file', bytes: 300 },
        { path: 'assets', kind: 'directory', bytes: 0 },
        { path: 'assets/app.js', kind: 'file', bytes: 4000 },
      ]),
    ).toEqual([]);
  });

  it('says every problem in walk order: a bad path (a folder too), a link, then count and size', () => {
    const each = Math.ceil(MAX_BUNDLE_UNPACKED_BYTES / MAX_BUNDLE_ENTRIES);
    expect(
      bundleProblems([
        { path: '_gugu', kind: 'directory', bytes: 0 },
        { path: 'notes.txt', kind: 'link', bytes: 0 },
        ...Array.from({ length: MAX_BUNDLE_ENTRIES + 1 }, (_, i) => ({ path: `f${i}.js`, kind: 'file' as const, bytes: each })),
      ]),
    ).toEqual([
      'reserved path (the platform runtime lives there): _gugu',
      'symbolic link: notes.txt',
      `too many files: ${MAX_BUNDLE_ENTRIES + 1} > ${MAX_BUNDLE_ENTRIES}`,
      `too large: ${(MAX_BUNDLE_ENTRIES + 1) * each} bytes > ${MAX_BUNDLE_UNPACKED_BYTES}`,
    ]);
  });
});
