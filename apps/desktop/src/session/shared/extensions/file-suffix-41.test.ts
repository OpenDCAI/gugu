import { describe, expect, it } from 'vitest';
import { fileSuffixOf, typedFileName } from './app-runtime-protocol';
import { chooseOpener, fileOpenersFor } from './file-openers';
import { EXTENSION_API_VERSION, parseExtensionManifest } from './manifest';

/**
 * 摩擦单 F41: what kind of file this is has one answer. A file whose content type names a suffix goes by it, a title
 * with a dot in it too; only stored bytes go by their name; the file is never renamed.
 */
const app = (id: string, group: string[]) =>
  parseExtensionManifest({
    id,
    name: id,
    version: '1.0.0',
    apiVersion: EXTENSION_API_VERSION, defaultLocale: 'en',
    entry: 'index.html',
    contributes: { tabs: [{ name: 'main', title: id, opensFiles: { chat: group } }] },
  });
const workspace = app('workspace', ['.md', '.json']);
const board = app('board', ['.json']);
const opener = (file: { name: string; contentType: string }, apps: ReturnType<typeof app>[]) =>
  chooseOpener(fileOpenersFor(typedFileName(file), apps, 'chat'), () => null);

describe('a file without a suffix', () => {
  it('a markdown document goes to the workspace App, to be edited there', () => {
    const doc = { name: '限流 PR 逐行评审', contentType: 'text/markdown' };
    expect(fileSuffixOf(doc)).toBe('.md');
    expect(typedFileName(doc)).toBe('限流 PR 逐行评审.md');
    expect(opener(doc, [workspace])).toMatchObject({ kind: 'one', candidate: { tabKind: 'workspace.main' } });
    // Control: without the content type's answer nobody opens it — what S7 / S9 / L7-m saw.
    expect(fileOpenersFor(doc.name, [workspace], 'chat')).toEqual([]);
  });

  it('a JSON document goes to an App that claims .json', () => {
    const data = { name: 'Collaboration Overview', contentType: 'application/json; charset=utf-8' };
    expect(fileSuffixOf(data)).toBe('.json');
    expect(opener(data, [board])).toMatchObject({ kind: 'one', candidate: { tabKind: 'board.main' } });
  });

  it('a title with a dot in it is still a markdown document', () => {
    for (const name of ['栖页 2.0 发布页', 'v2.3 计划', 'Q3.5 复盘', 'Q3.5']) {
      const doc = { name, contentType: 'text/markdown' };
      expect(fileSuffixOf(doc)).toBe('.md');
      expect(opener(doc, [workspace])).toMatchObject({ kind: 'one', candidate: { tabKind: 'workspace.main' } });
      // Control: the title alone reads `.0 发布页` / `.5` as a suffix nobody claims.
      expect(fileOpenersFor(name, [workspace], 'chat')).toEqual([]);
    }
  });

  it('the content type wins over the name; a name ending in it keeps its longer suffix; bytes go by their name', () => {
    expect(typedFileName({ name: 'friday.dinner-vote.json', contentType: 'application/json' })).toBe('friday.dinner-vote.json');
    expect(fileSuffixOf({ name: 'Friday.VOTE.json', contentType: 'text/plain' })).toBe('.txt');
    expect(typedFileName({ name: 'rows.csv', contentType: 'application/json' })).toBe('rows.csv.json');
    expect(fileSuffixOf({ name: 'shot.PNG', contentType: 'image/png' })).toBe('.png');
    expect(typedFileName({ name: 'rows.csv', contentType: 'application/octet-stream' })).toBe('rows.csv');
    expect(fileSuffixOf({ name: 'blob', contentType: 'application/octet-stream' })).toBe('');
    expect(typedFileName({ name: 'blob', contentType: 'application/octet-stream' })).toBe('blob');
    // A leading dot is a hidden file, not a suffix.
    expect(fileSuffixOf({ name: '.env', contentType: 'text/plain' })).toBe('.txt');
  });
});
