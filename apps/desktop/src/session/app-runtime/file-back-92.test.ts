import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import { fileOpened, loadPage, until } from './fake-file-service';

/**
 * 摩擦单 F92 (L6 S23): `rm TODO.md`, then `git checkout -- TODO.md`. The built-in editor had the file back; the App page
 * stayed `gone` for good — a task's file is its path, and once put back on the disk it is the same file. Main now says
 * `back` for it (local-files.test.ts covers main's side); here, what the page does with that.
 */

type TextFile = {
  text: string;
  status: string;
  insert(index: number, text: string): void;
  close(): void;
  onChange(handler: (event: unknown) => void): () => boolean;
  onStatus(handler: (status: string) => void): () => boolean;
};

type TextField = { text: string; onChange(handler: (event: { local: boolean }) => void): () => void };
type JsonFile = {
  data: Record<string, unknown>;
  status: string;
  saved: boolean;
  textAt(path: (string | number)[]): TextField;
  onChange(handler: (event: unknown) => void): () => boolean;
};

const page = () => loadPage<TextFile>('text');

describe('a task file deleted on the disk and put back (摩擦单 F92)', () => {
  it('gone, then online again on the next generation with what came back — and writable there', async () => {
    const { service, host, open } = await page();
    const file = await open();
    service.write('item-1@1', 'before');
    await until(() => file.text === 'before');
    const statuses: string[] = [];
    const changes: unknown[] = [];
    file.onStatus((status) => statuses.push(status));
    file.onChange((event) => changes.push(event));

    // As a deletion reaches the page in the app: the service's Close (`deleted`), then main's `revoked`.
    service.closeDocument('item-1@1', 'deleted');
    service.control({ t: 'revoked', docName: 'item-1@1', reason: 'deleted' });
    await until(() => file.status === 'gone');
    expect(() => file.insert(0, 'x')).toThrow(expect.objectContaining({ code: 'failed' }));

    // Put back: main's reopen grants the next generation, built from the disk.
    service.write('item-1@2', 'restored');
    host.appFiles.reopen.mockResolvedValueOnce({ ...fileOpened('text'), docName: 'item-1@2' });
    service.control({ t: 'back', docName: 'item-1@1' });
    // Control (a888c82a6): `gone` for good; reopen never asked. So too at 7b894fea5, measured in the app: the Close came
    // first and made it gone with no reason, and the `revoked` that said `deleted` was not heard.
    await until(() => file.status === 'online');
    expect(host.appFiles.reopen).toHaveBeenCalledWith({ ref: { chat: 'chat-1', id: 'item-1' } });
    expect(file.text).toBe('restored');
    expect(statuses.indexOf('gone')).toBeLessThan(statuses.lastIndexOf('online'));
    // One change says what came back, as after a swap — filling the new replica is not a change of its own.
    expect(changes).toHaveLength(1);
    file.insert(file.text.length, '!');
    await until(() => service.text('item-1@2') === 'restored!');
    file.close();
  });

  // L3's review: a field handle (`f.textAt`) follows the file back as it follows a swap — reads what came back from the
  // disk, and hears it once, as someone else's change. Control (5b3631114: the new replica filled in the open, then the
  // swap's word on top): the App hears the file come back twice.
  it('a textAt handle reads its field as it came back, and hears that once ({ local: false })', async () => {
    const { service, host, open } = await loadPage<JsonFile>('json');
    const file = await open();
    file.data.note = { $text: 'before' };
    await until(() => file.saved);
    const note = file.textAt(['note']);
    const heard: { local: boolean }[] = [];
    note.onChange((event) => heard.push(event));
    let changes = 0;
    file.onChange(() => (changes += 1));

    service.closeDocument('item-1@1', 'deleted');
    service.control({ t: 'revoked', docName: 'item-1@1', reason: 'deleted' });
    await until(() => file.status === 'gone');
    // The next generation, built from the disk: the field holds what the file says now.
    service.docOf('item-1@2').getMap('root').set('note', new Y.Text('restored'));
    host.appFiles.reopen.mockResolvedValueOnce({ ...fileOpened('json'), docName: 'item-1@2' });
    service.control({ t: 'back', docName: 'item-1@1' });

    await until(() => file.status === 'online');
    expect(note.text).toBe('restored');
    expect(heard.map((event) => event.local)).toEqual([false]);
    expect(changes).toBe(1);
  });

  // L3's review: what the App writes while its file comes back — offline, before the new replica has synced — is its own:
  // heard as a local change, kept by a will (the page may go now), and in the file once synced. Control (the whole
  // reconnect under `swapping`): nothing heard, no will.
  it('written while it comes back, before the new replica has synced: heard as its own, kept by a will, then in the file', async () => {
    const { service, host, open } = await page();
    const file = await open();
    service.write('item-1@1', 'before');
    await until(() => file.text === 'before');
    const heard: boolean[] = [];
    file.onChange((event) => heard.push((event as { local: boolean }).local));
    service.closeDocument('item-1@1', 'deleted');
    service.control({ t: 'revoked', docName: 'item-1@1', reason: 'deleted' });
    await until(() => file.status === 'gone');

    service.write('item-1@2', 'restored');
    service.holdSync = true;
    host.appFiles.reopen.mockResolvedValueOnce({ ...fileOpened('text'), docName: 'item-1@2' });
    service.control({ t: 'back', docName: 'item-1@1' });
    await until(() => file.status === 'offline');
    file.insert(0, 'mine ');
    expect(heard).toEqual([true]);
    await until(() => service.wills.some((will) => will.docName === 'item-1@2'));

    service.releaseSync();
    await until(() => file.status === 'online');
    await until(() => service.text('item-1@2').includes('mine ') && service.text('item-1@2').includes('restored'));
    expect(file.text).toBe(service.text('item-1@2'));
    file.close();
  });

  it('closed while gone: `back` finds nobody, and nothing is opened again', async () => {
    const { service, host, open } = await page();
    const file = await open();
    service.closeDocument('item-1@1', 'deleted');
    service.control({ t: 'revoked', docName: 'item-1@1', reason: 'deleted' });
    await until(() => file.status === 'gone');
    file.close();
    service.control({ t: 'back', docName: 'item-1@1' });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(host.appFiles.reopen).not.toHaveBeenCalled();
    expect(file.status).toBe('gone');
  });

  it('taken back for another reason (a group, a permission): never waits to come back', async () => {
    const { service, host, open } = await page();
    const file = await open();
    service.closeDocument('item-1@1', 'removed-from-group');
    service.control({ t: 'revoked', docName: 'item-1@1', reason: 'removed-from-group' });
    await until(() => file.status === 'gone');
    service.control({ t: 'back', docName: 'item-1@1' });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(host.appFiles.reopen).not.toHaveBeenCalled();
    expect(file.status).toBe('gone');
  });
});
