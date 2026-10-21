import { afterEach, describe, expect, it, vi } from 'vitest';
import { loadPage, until } from './fake-file-service';

/**
 * 摩擦单 F46: the workspace App opened the file it was handed twice (its context came twice) and closed the
 * first — which was the second too. Nothing synced, the page read `online` and "Saving" for good, and its
 * empty socket kept main's connection spinning. The platform holds: every `files.open(…)` is a handle of
 * its own on one replica, `close()` counts, a stall or a refusal is said out loud, and an idle page rests.
 *
 * The page's port here reaches a small in-test file service speaking the Hocuspocus 4.7 frames the real one
 * does (Auth → Authenticated; SyncStep1 → SyncStep2 + its own SyncStep1; an update → SyncStatus, and to
 * everyone else on the file). Each case loads the runtime afresh: one page, its own module state.
 */

type TextFile = {
  text: string;
  status: string;
  saved: boolean;
  insert(index: number, text: string): void;
  close(): void;
  onChange(handler: (event: unknown) => void): () => boolean;
  onStatus(handler: (status: string) => void): () => boolean;
};

const page = () => loadPage<TextFile>('text');

afterEach(() => {
  vi.useRealTimers();
});

describe('the same file opened twice on one page (摩擦单 F46)', () => {
  it('concurrent opens: closing one handle leaves the other syncing both ways', async () => {
    const { service, host, open } = await page();
    const [first, second] = await Promise.all([open(), open()]);
    first.close();
    second.insert(0, 'hello');
    // Control (d9c459cfb): the two were one object; closing it took the provider, and this never arrived.
    await until(() => service.text('item-1@1') === 'hello');
    await until(() => second.saved);
    service.write('item-1@1', ' world');
    await until(() => second.text === 'hello world');
    expect(second.status).toBe('online');
    expect(first).not.toBe(second);
    expect(first.status).toBe('gone');
    expect(host.appFiles.close).not.toHaveBeenCalled();
    second.close();
    expect(host.appFiles.close).toHaveBeenCalledTimes(1);
  });

  it('an open after the first was ready: the same replica, and closing the first leaves it', async () => {
    const { service, host, open } = await page();
    const first = await open();
    const second = await open();
    first.close();
    second.insert(0, 'later');
    await until(() => service.text('item-1@1') === 'later');
    expect(host.appFiles.close).not.toHaveBeenCalled();
    second.close();
    expect(host.appFiles.close).toHaveBeenCalledTimes(1);
  });

  it('a closed handle stops its own handlers and says so when used; the others are untouched', async () => {
    const { service, open } = await page();
    const [first, second] = await Promise.all([open(), open()]);
    const heard = { first: 0, second: 0 };
    first.onChange(() => (heard.first += 1));
    second.onChange(() => (heard.second += 1));
    first.close();
    service.write('item-1@1', 'x');
    await until(() => second.text === 'x');
    expect(heard).toEqual({ first: 0, second: 1 });
    expect(() => first.insert(0, 'y')).toThrow(expect.objectContaining({ code: 'failed' }));
    expect(() => first.onChange(() => undefined)).toThrow(expect.objectContaining({ code: 'failed' }));
    second.close();
  });
});

describe('a file that stops moving is said out loud (摩擦单 F46)', () => {
  it('no confirmation for STALL_MS: offline, onStatus, an error naming what it waited for — then it connects again and the change lands', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const { service, host, open, STALL_MS } = await page();
    const file = await open();
    const statuses: string[] = [];
    file.onStatus((status) => statuses.push(status));
    service.silent = true;
    file.insert(0, 'unanswered');
    await vi.advanceTimersByTimeAsync(STALL_MS + 100);
    // Control (d9c459cfb): `online` and unsaved for good, nothing reported.
    expect(file.status).toBe('offline');
    expect(statuses).toContain('offline');
    expect(host.reportError).toHaveBeenCalledWith(expect.stringContaining('waiting for: confirmation of a change'));
    service.silent = false;
    await vi.advanceTimersByTimeAsync(1500);
    await until(() => file.status === 'online' && file.saved);
    expect(service.text('item-1@1')).toBe('unanswered');
    expect(host.reportError).toHaveBeenCalledTimes(1);
    file.close();
  });

  it('main refusing the file while it opens ends open() with the reason, not the 10 s deadline', async () => {
    const { service, open } = await page();
    service.refuseAuth = true;
    // Main's reason, not the deadline: the deadline names what the page waited for, never why main refused.
    const refused = open();
    await expect(refused).rejects.toMatchObject({ code: 'file-unavailable', message: expect.stringContaining('key-in-use') });
    await expect(refused).rejects.not.toMatchObject({ message: expect.stringContaining('did not answer within') });
  });

  it('main refusing an open file: gone, and reported — never still `online`', async () => {
    const { service, host, open } = await page();
    const file = await open();
    const key = [...service.keys][0]!;
    service.toPage?.({ data: { t: 'denied', key, reason: 'key-in-use' } });
    await until(() => file.status === 'gone');
    expect(host.reportError).toHaveBeenCalledWith(expect.stringContaining('key-in-use'));
  });
});

describe('a page with nothing open rests its socket (摩擦单 F46)', () => {
  it('after the last close, main’s `down` brings no `hello`; the next open wakes it and syncs', async () => {
    const { service, open } = await page();
    const file = await open();
    file.close();
    const hellos = service.hellos;
    service.toPage?.({ data: { t: 'down', code: 4408, reason: 'Connection Timeout' } });
    // The provider's retry delay is 500 ms: past it, twice over.
    await new Promise((resolve) => setTimeout(resolve, 1200));
    // Control (d9c459cfb): a `hello` every time — main reopened its connection for an empty page, every 30 s.
    expect(service.hellos).toBe(hellos);
    const again = await open();
    expect(service.hellos).toBe(hellos + 1);
    again.insert(0, 'awake');
    await until(() => service.text('item-1@1') === 'awake');
    again.close();
  });
});
