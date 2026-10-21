import { describe, expect, it } from 'vitest';
import { askOpener, chooseOpener, displayNameOf, fileOpenersFor, openWithKey } from './file-openers';
import { EXTENSION_API_VERSION, parseExtensionManifest, safeParseExtensionManifest } from './manifest';

/**
 * 「打开方式」 by context (真源 §2.4, 主人 09-29): an App offers to open a file only where its
 * manifest said so, by context: a session's working copy, a group's workspace.
 */

function app(id: string, opensFiles: unknown) {
  return {
    id,
    name: id,
    version: '1.0.0',
    apiVersion: EXTENSION_API_VERSION,
    entry: 'index.html',
    contributes: { tabs: [{ name: 'main', title: id, opensFiles }] },
  };
}

const ids = (path: string, installed: ReturnType<typeof parseExtensionManifest>[], context?: 'session' | 'chat') =>
  fileOpenersFor(path, installed, context).map((c) => c.extensionId);

describe('opensFiles by context', () => {
  it('a plain array is refused: an App says where its files are (apiVersion 2)', () => {
    expect(safeParseExtensionManifest(app('grid', ['.CSV'])).ok).toBe(false);
    const grid = parseExtensionManifest(app('grid', { session: ['.CSV'] }));
    expect(ids('data/report.csv', [grid])).toEqual(['grid']);
    expect(ids('data/report.csv', [grid], 'session')).toEqual(['grid']);
    expect(ids('report.csv', [grid], 'chat')).toEqual([]);
  });

  it('the object form declares each context on its own', () => {
    const workspace = parseExtensionManifest(app('workspace', { chat: ['.md', '.json'] }));
    const both = parseExtensionManifest(app('both', { session: ['.csv'], chat: ['.CSV'] }));
    expect(ids('notes.md', [workspace], 'chat')).toEqual(['workspace']);
    expect(ids('notes.md', [workspace], 'session')).toEqual([]); // the session's .md is untouched
    expect(ids('a.csv', [workspace, both], 'session')).toEqual(['both']);
    expect(ids('a.csv', [workspace, both], 'chat')).toEqual(['both']);
  });

  it('refuses an object that declares no context, or one that is not known', () => {
    const issues = (opensFiles: unknown) => {
      const result = safeParseExtensionManifest(app('claims', opensFiles));
      return result.ok ? '' : result.issues.join(' ');
    };
    expect(issues({})).toMatch(/at least one context/);
    // `group` is not a context: refused like any unknown key, naming the two there are.
    expect(issues({ group: ['.md'] })).toContain('say where the files are: {"session":[…]} or {"chat":[…]}');
    expect(issues({ group: ['.md'] })).not.toContain('is now');
    expect(issues({ chat: ['md'] })).toMatch(/dot-led lowercase suffix/);
    // The plain list is gone (apiVersion 2); control: the one form parses, for either context.
    expect(issues(['.md'])).toMatch(/say where the files are/);
    expect(issues({ session: ['.md'] })).toBe('');
    expect(issues({ chat: ['.md'] })).toBe('');
  });
});

describe('choosing who opens it', () => {
  const grid = parseExtensionManifest(app('grid', { session: ['.csv'], chat: ['.csv'] }));
  const sheet = parseExtensionManifest(app('sheet', { session: ['.csv'] }));
  const gz = parseExtensionManifest(app('gz', { session: ['.gz'] }));
  const tgz = parseExtensionManifest(app('tgz', { session: ['.tar.gz'] }));
  const none = () => null;

  it('one App claims it: opened straight away; nobody: none', () => {
    expect(chooseOpener(fileOpenersFor('a.csv', [grid, sheet], 'chat'), none)).toMatchObject({ kind: 'one', candidate: { extensionId: 'grid' } });
    expect(chooseOpener(fileOpenersFor('a.png', [grid, sheet], 'chat'), none)).toEqual({ kind: 'none' });
  });

  it('several: the person picks — unless they said 「始终用它」 for that suffix, and that App still claims it', () => {
    const both = fileOpenersFor('a.csv', [grid, sheet], 'session');
    expect(chooseOpener(both, none)).toMatchObject({ kind: 'choose', suffix: '.csv', candidates: [{ extensionId: 'grid' }, { extensionId: 'sheet' }] });
    expect(chooseOpener(both, (suffix) => (suffix === '.csv' ? 'sheet.main' : null))).toMatchObject({ kind: 'one', candidate: { extensionId: 'sheet' } });
    // Control: a remembered App that no longer claims it does not count.
    expect(chooseOpener(both, () => 'gone.main')).toMatchObject({ kind: 'choose' });
    expect(openWithKey('session', '.csv')).toBe('session:.csv');
  });

  it('the most specific suffix decides who is in the running', () => {
    expect(chooseOpener(fileOpenersFor('x.tar.gz', [gz, tgz]), none)).toMatchObject({ kind: 'one', candidate: { extensionId: 'tgz' } });
  });
});

describe('a group file, as a file manager opens it (摩擦单 F2, 真源 §2.6)', () => {
  const workspace = parseExtensionManifest(app('workspace', { chat: ['.md', '.json'] }));
  const vote = parseExtensionManifest(app('dinner-vote', { chat: ['.vote.json'] }));
  const none = () => null;
  const openers = (name: string) => fileOpenersFor(name, [workspace, vote], 'chat');

  it('a click: .vote.json goes to the App that declared .vote.json, not to whoever opens any .json', () => {
    expect(chooseOpener(openers('friday-dinner.vote.json'), none)).toMatchObject({ kind: 'one', candidate: { tabKind: 'dinner-vote.main' } });
    // Control: a plain .json (and .md) is the workspace App's own — it opens them on the same path.
    expect(chooseOpener(openers('board.json'), none)).toMatchObject({ kind: 'one', candidate: { tabKind: 'workspace.main' } });
    expect(chooseOpener(openers('notes.md'), none)).toMatchObject({ kind: 'one', candidate: { tabKind: 'workspace.main' } });
  });

  it('「始终用它」 for the file’s kind wins — even when it picked a less specific claim', () => {
    const always = (suffix: string) => (suffix === '.vote.json' ? 'workspace.main' : null);
    expect(chooseOpener(openers('friday-dinner.vote.json'), always)).toMatchObject({ kind: 'one', candidate: { tabKind: 'workspace.main' } });
    // Control: remembered for another kind of file does not reach this one.
    expect(chooseOpener(openers('friday-dinner.vote.json'), (s) => (s === '.json' ? 'workspace.main' : null))).toMatchObject({ candidate: { tabKind: 'dinner-vote.main' } });
  });

  it('「用别的 App 打开」 lists every App that opens it, most specific first, each once', () => {
    expect(askOpener(openers('friday-dinner.vote.json'))).toMatchObject({
      kind: 'choose',
      suffix: '.vote.json',
      candidates: [{ tabKind: 'dinner-vote.main' }, { tabKind: 'workspace.main' }],
    });
    expect(askOpener(openers('photo.png'))).toEqual({ kind: 'none' });
  });
});

describe('「用哪个打开」 names Apps (摩擦单 F26)', () => {
  it('each candidate carries its App’s name, and whether that App has just this tab', () => {
    const md = parseExtensionManifest(app('wysiwyg', { chat: ['.md'] }));
    const two = parseExtensionManifest({
      ...app('notes', { chat: ['.md'] }),
      name: 'Notes',
      contributes: { tabs: [{ name: 'main', title: 'Markdown', opensFiles: { chat: ['.md'] } }, { name: 'raw', title: 'Source' }] },
    });
    expect(fileOpenersFor('a.md', [md, two], 'chat')).toMatchObject([
      { tabKind: 'notes.main', app: { name: 'Notes' }, tabTitle: 'Markdown', onlyTab: false },
      { tabKind: 'wysiwyg.main', app: { name: 'wysiwyg' }, onlyTab: true },
    ]);
  });
});

describe('a file name as a person reads it (摩擦单 F39, F73: the list and the picker alike)', () => {
  it('without the suffix it is claimed by, whatever its case; the whole name when that would leave nothing or it does not end so', () => {
    expect(displayNameOf('friday-dinner.vote.json', '.vote.json')).toBe('friday-dinner');
    expect(displayNameOf('Friday.VOTE.json', '.vote.json')).toBe('Friday');
    expect(displayNameOf('.vote.json', '.vote.json')).toBe('.vote.json');
    expect(displayNameOf('notes.md', '.vote.json')).toBe('notes.md');
  });
});

describe('claiming a file by its name (摩擦单 F82, S23: a board App took every .md to have TODO.md)', () => {
  const markdown = () => parseExtensionManifest(app('markdown', { session: ['.md'], chat: ['.md'] }));
  const board = () => parseExtensionManifest(app('board', { session: ['TODO.md'], chat: ['todo.md'] }));
  const journal = () => parseExtensionManifest(app('journal', { session: ['todo-*.md'] }));

  it('a name claims that file only, whatever its case, and is more specific than any suffix', () => {
    expect(ids('repo/TODO.md', [markdown(), board()])).toEqual(['board', 'markdown']);
    expect(ids('repo/README.md', [markdown(), board()])).toEqual(['markdown']);
    expect(ids('todo.md', [markdown(), board()], 'chat')).toEqual(['board', 'markdown']);
    // So 「始终用它」 on TODO.md is kept under the name, and every other .md still opens as before.
    expect(chooseOpener(fileOpenersFor('TODO.md', [markdown(), board()]), () => null)).toMatchObject({ kind: 'one', candidate: { extensionId: 'board', suffix: 'todo.md' } });
    expect(chooseOpener(fileOpenersFor('notes.md', [markdown(), board()]), () => null)).toMatchObject({ kind: 'one', candidate: { extensionId: 'markdown', suffix: '.md' } });
  });

  it('`*` is any run of characters; a name beats a pattern, a pattern beats a suffix', () => {
    expect(ids('todo-2026-09.md', [markdown(), journal()])).toEqual(['journal', 'markdown']);
    expect(ids('todo.md', [markdown(), journal()])).toEqual(['markdown']);
    expect(ids('notes/TODO-x.MD', [journal()])).toEqual(['journal']);
    const exact = parseExtensionManifest(app('exact', { session: ['todo-2026-09.md'] }));
    expect(ids('todo-2026-09.md', [markdown(), journal(), exact])).toEqual(['exact', 'journal', 'markdown']);
  });

  it('the manifest takes names and patterns; "*.x" is the suffix ".x" and is refused with that; no paths, not only "*"', () => {
    expect(safeParseExtensionManifest(app('claims', { session: ['TODO.md', 'Meeting notes.md', 'todo-*.md', 'dockerfile'] })).ok).toBe(true);
    const refused = (claim: string) => {
      const result = safeParseExtensionManifest(app('claims', { session: [claim] }));
      return result.ok ? null : JSON.stringify(result);
    };
    expect(refused('*.md')).toContain('is the suffix \\".md\\"');
    expect(refused('docs/todo.md')).toContain('no slashes');
    expect(refused('*')).toContain('more than');
    expect(refused('md')).toContain('needs its dot'); // a suffix missing its dot, not a file named "md"
    expect(refused('.MD')).toBeNull(); // lowercased, still a suffix
    // Control: before F82 a claim had to be a dot-led suffix — "TODO.md" was refused.
    expect(/^\.[a-z0-9][a-z0-9.+-]*$/.test('todo.md')).toBe(false);
  });
});
