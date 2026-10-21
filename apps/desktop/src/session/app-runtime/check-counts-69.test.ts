import { describe, expect, it, vi } from 'vitest';
import { loadPage, until } from './fake-file-service';

/**
 * 摩擦单 F69 (L5 S16), owner 10-14: `app_check`'s page works its files as anywhere — by whoever works it, so what it
 * writes reaches the file and its presence shows. What it does is counted for the check: S16 wrote 59.8 times a second.
 */

type TextFile = {
  readonly text: string;
  insert(index: number, text: string): void;
  presence: { set(state: unknown): void };
  close(): void;
};
type JsonFile = { data: Record<string, unknown>; close(): void };

const DOC = 'item-1@1';
const settle = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const reportOf = (host: unknown) => (host as { checkPage: { report: ReturnType<typeof vi.fn> } }).checkPage.report;

describe('the check’s page works its files as anywhere, and is counted (摩擦单 F69, owner 10-14)', () => {
  it('its write reaches the file service and its presence goes out; how often each was done is reported', async () => {
    const { service, host, open } = await loadPage<TextFile>('text', { checkPage: true });
    service.write(DOC, 'shared ');
    const file = await open();
    await until(() => file.text === 'shared ');
    await settle(120);
    const presenceBefore = service.awareness.length;
    file.insert(file.text.length, 'mine');
    file.presence.set({ x: 1 });
    await until(() => service.text(DOC).includes('mine'));
    await settle(400);
    expect(service.awareness.length).toBeGreaterThan(presenceBefore);
    expect(reportOf(host)).toHaveBeenLastCalledWith({ writes: 1, writesPerSecond: 1, presenceSets: 1, presencePerSecond: 1, opens: 1, opensSettled: 1 });
    file.close();
  });

  it('a JSON file: what the App assigns is the file’s; the peak rate over any second is what is reported', async () => {
    const { service, host, open } = await loadPage<JsonFile>('json', { checkPage: true });
    const file = await open();
    await settle(120);
    for (let turn = 0; turn < 30; turn += 1) file.data.turn = turn;
    file.data.votes = { a: 1 };
    await until(() => service.docOf(DOC).getMap('root').get('turn') === 29);
    await settle(400);
    expect(reportOf(host)).toHaveBeenLastCalledWith(expect.objectContaining({ writes: 31, writesPerSecond: 31, presenceSets: 0 }));
    file.close();
  });
});

describe('the check waits for the page’s opens (摩擦单 F5, through F69)', () => {
  it('each files.open is counted when called and when it settles — a refused one too — and a settle is said at once', async () => {
    const { host, open } = await loadPage<{ close(): void }>('text', { checkPage: true });
    host.appFiles.open.mockRejectedValueOnce(Object.assign(new Error('No such file in this chat'), { code: 'not-found' }));
    // Said at once — not on the next 250 ms beat: with the clock standing still the beat cannot fire, so a report that
    // has the settle is the settle's own.
    vi.useFakeTimers();
    try {
      await expect(open()).rejects.toMatchObject({ code: 'not-found' });
      expect(reportOf(host)).toHaveBeenLastCalledWith(expect.objectContaining({ opens: 1, opensSettled: 1 }));
    } finally {
      vi.useRealTimers();
    }
    const file = await open();
    expect(reportOf(host)).toHaveBeenLastCalledWith(expect.objectContaining({ opens: 2, opensSettled: 2 }));
    file.close();
  });
});
