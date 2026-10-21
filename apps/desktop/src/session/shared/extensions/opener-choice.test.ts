import { describe, expect, it } from 'vitest';
import { askOpener, chooseOpener, claimantOf, fileOpenersFor, openerAhead, openerChoice, openWithKey } from './file-openers';
import { EXTENSION_API_VERSION, parseExtensionManifest, type ExtensionManifest } from './manifest';

// `openerChoice` / `claimantOf` are the composition main (app-files.ts) and the phone's host (phoneAppHost.ts) each
// wrote out before (L9). Control: that inline composition, as it stood, gives the same answer on every file here.

function app(id: string, claims: string[]): ExtensionManifest {
  return parseExtensionManifest({
    id,
    name: id.toUpperCase(),
    version: '1.0.0',
    apiVersion: EXTENSION_API_VERSION,
    entry: 'index.html',
    contributes: { tabs: [{ name: 'main', title: id, opensFiles: { chat: claims } }] },
  });
}

const apps = [app('workspace', ['.md', '.json']), app('vote', ['.vote.json']), app('poll', ['.vote.json']), app('board', ['todo.md'])];
const files = ['notes.md', 'x.json', 'lunch.vote.json', 'todo.md', 'photo.png'];

/** The composition as main and the phone each had it inline. */
function before(fileName: string, remembered: Record<string, string>, ask: boolean) {
  const openers = fileOpenersFor(fileName, apps, 'chat');
  return ask ? askOpener(openers) : chooseOpener(openers, (suffix) => remembered[openWithKey('chat', suffix)] ?? null);
}

describe('openerChoice: who opens a group file here', () => {
  const rememberedCases: Record<string, string>[] = [{}, { 'chat:.vote.json': 'poll.main' }];
  for (const remembered of rememberedCases) {
    for (const ask of [false, true]) {
      it(`matches the inline composition (remembered ${JSON.stringify(remembered)}, ask ${ask})`, () => {
        for (const file of files) expect(openerChoice(file, apps, 'chat', (key) => remembered[key] ?? null, ask)).toEqual(before(file, remembered, ask));
      });
    }
  }

  it('reads 「始终用它」 under the context and the matched claim', () => {
    const keys: string[] = [];
    openerChoice('lunch.vote.json', apps, 'chat', (key) => (keys.push(key), null));
    expect(keys).toEqual(['chat:.vote.json']);
  });
});

describe('claimantOf: the App a file is shown as belonging to', () => {
  it('is the one a tap opens, else the first in line, else nobody', () => {
    expect(claimantOf('notes.md', apps, 'chat', () => null)?.extensionId).toBe('workspace');
    expect(claimantOf('todo.md', apps, 'chat', () => null)?.extensionId).toBe('board');
    expect(claimantOf('lunch.vote.json', apps, 'chat', () => null)?.extensionId).toBe('poll');
    expect(claimantOf('lunch.vote.json', apps, 'chat', (key) => (key === 'chat:.vote.json' ? 'vote.main' : null))?.extensionId).toBe('vote');
    expect(claimantOf('photo.png', apps, 'chat', () => null)).toBeNull();
  });
});

describe('openerAhead: a shared App that would open the file ahead of the installed ones (摩擦单 F15, L11 C5)', () => {
  const installed = [app('workspace', ['.md']), app('todos', ['todo*.md']), app('vote', ['.vote.json'])];
  const shared = [app('kanban', ['.kanban.md']), app('avote', ['.vote.json'])];
  /** Control: the rule as it stood — the longer claim wins, whatever kind of claim it is. */
  function before(fileName: string) {
    const best = fileOpenersFor(fileName, shared, 'chat')[0];
    const here = fileOpenersFor(fileName, installed, 'chat')[0];
    return !best || (here && here.suffix.length >= best.suffix.length) ? null : best;
  }

  it('an installed name pattern outranks a longer shared suffix, as a tap ranks them — nothing is offered', () => {
    expect(openerAhead('todo.kanban.md', installed, shared, 'chat')).toBeNull();
    expect(openerChoice('todo.kanban.md', [...installed, ...shared], 'chat', () => null)).toMatchObject({ kind: 'one', candidate: { extensionId: 'todos' } });
    // Control: the old rule offered kanban here, which installed would not have been the one a tap opens.
    expect(before('todo.kanban.md')?.extensionId).toBe('kanban');
  });

  it('a shared claim more specific than any installed one is offered; the same claim as an installed App is not', () => {
    expect(openerAhead('plan.kanban.md', installed, shared, 'chat')?.extensionId).toBe('kanban');
    expect(before('plan.kanban.md')?.extensionId).toBe('kanban');
    // avote sorts ahead of vote, but vote makes the same claim and is installed: it opens the file already.
    expect(openerAhead('lunch.vote.json', installed, shared, 'chat')).toBeNull();
    expect(openerAhead('photo.png', installed, shared, 'chat')).toBeNull();
  });
});
