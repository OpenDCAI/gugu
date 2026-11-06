import { describe, expect, it } from 'vitest';
import { fileOpenersFor, openerChoice } from './file-openers';
import { EXTENSION_API_VERSION, parseExtensionManifest } from './manifest';

const app = (id: string, session: string[]) => parseExtensionManifest({
  id, name: id, version: '1.0.0', apiVersion: EXTENSION_API_VERSION, defaultLocale: 'en', entry: 'index.html',
  contributes: { tabs: [{ name: 'file', title: id, opensFiles: { session } }] },
});
const anyFile = app('anyfile', ['*']);
const csv = app('sheet', ['.csv']);
const named = app('maker', ['makefile']);

describe('a claim on any file', () => {
  it('takes what no suffix can: no suffix at all, a leading dot', () => {
    for (const name of ['Makefile', '.gitignore', 'a.ts', '.env.local']) {
      expect(fileOpenersFor(name, [anyFile]).map((c) => c.tabKind)).toEqual(['anyfile.file']);
    }
  });

  it('gives way to every other claim', () => {
    const apps = [anyFile, csv, named];
    const choice = (name: string) => openerChoice(name, apps, 'session', () => null);
    expect(choice('a.csv')).toMatchObject({ kind: 'one', candidate: { tabKind: 'sheet.file' } });
    expect(choice('Makefile')).toMatchObject({ kind: 'one', candidate: { tabKind: 'maker.file' } });
    expect(choice('a.ts')).toMatchObject({ kind: 'one', candidate: { tabKind: 'anyfile.file' } });
  });

  it('still refuses a name that is only stars', () => {
    expect(() => app('stars', ['**'])).toThrow();
  });
});
