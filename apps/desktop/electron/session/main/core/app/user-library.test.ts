import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readUserLibrary, readUserLibraryEntry, readUserLibraryVolume, writeUserLibraryEntry, setUserLibraryOwner } from './user-library';

let home: string;
beforeEach(async () => { home = await mkdtemp(join(tmpdir(), 'gugu-library-')); });
afterEach(async () => { setUserLibraryOwner(null); vi.unstubAllEnvs(); await rm(home, { recursive: true, force: true }); });
const note = { kind: 'capabilities' as const, name: 'Calendar', description: 'Personal appointments', group: 'Work', content: '# Calendar\nUse the connected account.' };

describe('Gugu built-in structured library', () => {
  it('works in a clean profile without any AutoLibrary installation or configuration', async () => {
    const library = await readUserLibrary(home);
    expect(library.root).toBe(join(home, 'library'));
    expect(library.volumes.map(volume => volume.kind)).toEqual(['capabilities', 'devices']);
    expect((await readUserLibraryVolume('capabilities', home)).items).toEqual([]);
    await mkdir(join(home, '.claude'));
    await writeFile(join(home, '.claude/autolibrary.json'), 'broken external configuration must be ignored');
    expect((await readUserLibraryVolume('devices', home)).items).toEqual([]);
    expect(JSON.stringify(library)).not.toMatch(/autolibrary|workspace|ideas/);
  });
  it('persists each independent entry and derives the total index from its latest content', async () => {
    const created = await writeUserLibraryEntry(note, home);
    expect(await readUserLibraryEntry('capabilities', created.id, home)).toEqual(created);
    const before = await readUserLibraryVolume('capabilities', home);
    expect(before.items).toEqual([expect.objectContaining({ id: created.id, name: 'Calendar', group: 'Work', description: note.description })]);
    expect(before.content).toContain(`- [Calendar](${created.id})`);
    const edited = await writeUserLibraryEntry({ ...note, id: created.id, name: 'My calendar', expectedModifiedAt: created.modifiedAt }, home);
    expect(edited.modifiedAt).not.toBe(created.modifiedAt);
    expect((await readUserLibraryVolume('capabilities', home)).content).toContain('[My calendar]');
    expect((await readUserLibraryVolume('capabilities', home)).content).not.toContain('[Calendar]');
  });
  it('rejects stale/concurrent edits and retains the accepted change after a second read', async () => {
    const created = await writeUserLibraryEntry(note, home);
    const edits = await Promise.allSettled(['first', 'second'].map(name => writeUserLibraryEntry({ ...note, id: created.id, name, expectedModifiedAt: created.modifiedAt }, home)));
    expect(edits.map(result => result.status)).toEqual(['fulfilled', 'rejected']);
    expect((await readUserLibraryEntry('capabilities', created.id, home)).name).toBe('first');
    await expect(writeUserLibraryEntry({ ...note, id: created.id }, home)).rejects.toThrow(/changed/);
  });
  it('does not turn corrupt or unreadable storage into an empty catalogue', async () => {
    const created = await writeUserLibraryEntry(note, home);
    await writeFile(created.index, 'invalid json');
    await expect(readUserLibraryVolume('capabilities', home)).rejects.toThrow();
    await expect(writeUserLibraryEntry({ ...note, id: created.id }, home)).rejects.toThrow();
  });
  it('rejects traversal, symlink escape and foreign resource kinds without writing outside the library', async () => {
    await mkdir(join(home, 'library/capabilities'), { recursive: true });
    const outside = join(home, 'outside'); await mkdir(outside);
    await writeFile(join(outside, 'index.json'), 'untouched');
    await symlink(outside, join(home, 'library/capabilities/escape'));
    await expect(readUserLibraryEntry('capabilities', '../outside', home)).rejects.toThrow(/ID/);
    await expect(readUserLibraryEntry('capabilities', 'escape', home)).rejects.toThrow(/outside/);
    await expect(writeUserLibraryEntry({ ...note, id: 'escape' }, home)).rejects.toThrow(/outside/);
    await expect(readUserLibraryVolume('workspace' as never, home)).rejects.toThrow(/Unknown/);
    expect(await readFile(join(outside, 'index.json'), 'utf8')).toBe('untouched');
  });
  it('keeps profiles independent and validates entry metadata', async () => {
    const created = await writeUserLibraryEntry(note, home);
    expect((await readUserLibraryVolume('capabilities', join(home, 'other-profile'))).items).toEqual([]);
    await expect(writeUserLibraryEntry({ ...note, name: ' ' }, home)).rejects.toThrow(/Invalid/);
    const file = JSON.parse(await readFile(created.index, 'utf8')); file.id = 'wrong';
    await writeFile(created.index, JSON.stringify(file));
    await expect(readUserLibraryEntry('capabilities', created.id, home)).rejects.toThrow(/Invalid/);
  });
  it('scopes host requests to the current account and rejects requests while signed out', async () => {
    vi.stubEnv('GUGU_HOME', home);
    let current: string | null = 'owner-a';
    setUserLibraryOwner(async () => current);
    const created = await writeUserLibraryEntry(note);
    expect(created.path).toContain(join(home, 'users/owner-a/library'));
    current = 'owner-b';
    expect((await readUserLibraryVolume('capabilities')).items).toEqual([]);
    current = null;
    await expect(readUserLibrary()).rejects.toThrow(/account/);
    current = 'owner-a';
    expect((await readUserLibraryVolume('capabilities')).items[0]?.id).toBe(created.id);
  });

});
