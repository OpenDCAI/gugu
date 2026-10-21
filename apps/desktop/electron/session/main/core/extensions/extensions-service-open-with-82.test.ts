import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({ app: { getPath: () => tmpdir() } }));

const { ExtensionsService } = await import('./extensions-service');

/** 摩擦单 F82: a claim may be a file name, so 「始终用它」 is kept under one too (`<context>:<claim>`). */
let dir: string;
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('「始终用它」 for a file-name claim (摩擦单 F82)', () => {
  it('is kept like a suffix’s; what is no claim is still refused', () => {
    dir = mkdtempSync(path.join(tmpdir(), 'gugu-f82-open-with-'));
    const service = new ExtensionsService(dir);
    service.setOpenWithDefault('session:todo.md', 'board.main');
    service.setOpenWithDefault('session:todo-*.md', 'journal.main');
    service.setOpenWithDefault('chat:.csv', 'grid.main');
    expect(service.openWithDefaults()).toEqual({ 'session:todo.md': 'board.main', 'session:todo-*.md': 'journal.main', 'chat:.csv': 'grid.main' });
    expect(() => service.setOpenWithDefault('session:../x', 'a.main')).toThrow();
    // A chat's files are `chat:` (#6913); a `group:` key, as Beta builds wrote it, is no context any more.
    expect(() => service.setOpenWithDefault('group:.csv', 'a.main')).toThrow();
    // Control: the key rule before F82 refused a name, so 「始终用它」 on TODO.md was never kept.
    expect(/^(session|group):\.[a-z0-9][a-z0-9.+-]*$/.test('session:todo.md')).toBe(false);
  });
});

/**
 * #6913: a chat's files are `chat:` now. A file a Beta build wrote still holds `group:<claim>` — that one choice is made
 * again (owner 10-05, no migration); the rest of the file still reads, and picking again writes `chat:` in its place.
 */
describe('「始终用它」 written as group: by a build before #6913', () => {
  it('is left out as it is read; every other choice holds, and picking again keeps the new key only', () => {
    dir = mkdtempSync(path.join(tmpdir(), 'gugu-6913-open-with-'));
    writeFileSync(path.join(dir, '.open-with-defaults.json'), JSON.stringify({ 'group:.vote.json': 'poll.main', 'session:.csv': 'grid.main' }));
    const service = new ExtensionsService(dir);
    expect(service.openWithDefaults()).toEqual({ 'session:.csv': 'grid.main' });
    service.setOpenWithDefault('chat:.vote.json', 'vote.main');
    expect(JSON.parse(readFileSync(path.join(dir, '.open-with-defaults.json'), 'utf8'))).toEqual({ 'session:.csv': 'grid.main', 'chat:.vote.json': 'vote.main' });
  });
});
