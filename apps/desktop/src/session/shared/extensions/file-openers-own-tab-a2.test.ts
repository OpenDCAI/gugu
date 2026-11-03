import { describe, expect, it } from 'vitest';
import * as openers from './file-openers';
import { EXTENSION_API_VERSION, parseExtensionManifest } from './manifest';

/**
 * A2 (data-lens 评审): `gugu.files.openWith(file, { tab })` opens a chat file in one of the caller's own tabs — the one
 * the page names, if it claims the file here — never the person's pick. `ownTabChoice` is that answer, beside
 * `openerChoice`, for the desktop's main and the phone's outer page alike. The extension is the bound caller's, never
 * the page's to say: a tab name is spliced onto it, so no name reaches another App's tab.
 */

type OwnTabChoice = (fileName: string, apps: readonly ReturnType<typeof parseExtensionManifest>[], context: 'chat' | 'session', extensionId: string, tab: string) => unknown;
const ownTabChoice = (...args: Parameters<OwnTabChoice>) => (openers as unknown as { ownTabChoice: OwnTabChoice }).ownTabChoice(...args);

const dataLens = parseExtensionManifest({
  id: 'data-lens', name: 'Data Lens', version: '1.0.0', apiVersion: EXTENSION_API_VERSION, defaultLocale: 'en', entry: 'index.html',
  contributes: { tabs: [
    { name: 'card', title: 'Data Lens', entry: 'card.html' },
    { name: 'explore', title: 'Data Lens', entry: 'explore.html', opensFiles: { chat: ['.csv', '.tsv', '.xlsx', '.xls', '.ods', '.sqlite', '.sqlite3', '.db'] } },
  ] },
});
const office = parseExtensionManifest({
  id: 'office', name: '咕咕办公', version: '1.0.0', apiVersion: EXTENSION_API_VERSION, defaultLocale: 'en', entry: 'index.html',
  contributes: { tabs: [{ name: 'sheet', title: 'Office', entry: 'sheet.html', opensFiles: { chat: ['.xlsx', '.pptx'] } }] },
});
const apps = [dataLens, office];

describe('ownTabChoice: the caller\'s own tab that claims the file (A2 T1/T2)', () => {
  it('T1: its own claiming tab opens it — one, no choosing, even where another App claims the same suffix', () => {
    expect(ownTabChoice('sales.xlsx', apps, 'chat', 'data-lens', 'explore')).toMatchObject({
      kind: 'one', candidate: { extensionId: 'data-lens', tabKind: 'data-lens.explore', suffix: '.xlsx' },
    });
    // Control: the ordinary answer is a tie the person settles.
    expect(openers.openerChoice('sales.xlsx', apps, 'chat', () => null)).toMatchObject({ kind: 'choose' });
  });

  it('T2: its own tab that does not claim it, a tab it does not have, another App\'s tab by any spelling — none', () => {
    expect(ownTabChoice('sales.xlsx', apps, 'chat', 'data-lens', 'card')).toBeNull();
    expect(ownTabChoice('sales.xlsx', apps, 'chat', 'data-lens', 'nope')).toBeNull();
    expect(ownTabChoice('sales.xlsx', apps, 'chat', 'data-lens', 'office.sheet')).toBeNull();
    expect(ownTabChoice('sales.xlsx', apps, 'chat', 'data-lens', 'sheet')).toBeNull();
    // A file its tab does not claim, and a context it did not declare.
    expect(ownTabChoice('deck.pptx', apps, 'chat', 'data-lens', 'explore')).toBeNull();
    expect(ownTabChoice('sales.xlsx', apps, 'session', 'data-lens', 'explore')).toBeNull();
  });
});
