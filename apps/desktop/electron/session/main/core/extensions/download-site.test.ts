import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DownloadSiteMarketBackend } from './download-site';

// 161 10-16 (owner「只要保证初次用户体验稳定就行」): a download fails only when nothing new comes for 30 s — never because the
// whole file takes longer. Before, the whole file had 30 s: 咕咕办公's 1.09 MB below ~36 kB/s (a weak phone signal) never came
// down, and the first-run set only ever said 「next start」. The line is a stream the test feeds; time is the fake clock.

const OFFICE_BYTES = 1_091_655;

/** An answer whose bytes come when the test says. */
function line() {
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  const body = new ReadableStream<Uint8Array>({ start: (c) => void (controller = c) });
  return { body, push: (bytes: number) => controller.enqueue(new Uint8Array(bytes)), end: () => controller.close() };
}
const siteOf = (answer: () => Promise<Response>) => new DownloadSiteMarketBackend('https://download.test/market/', 30_000, answer as unknown as typeof fetch);
/** Whether the read has ended either way yet. */
function watched<T>(promise: Promise<T>) {
  const state = { settled: false };
  promise.then(() => (state.settled = true), () => (state.settled = true));
  return state;
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe('reading the download site: only a stall fails, never a slow line', () => {
  it('咕咕办公 at 20 kB/s — 55 s, past the 30 s the whole file used to get — comes down whole', async () => {
    const l = line();
    const got = siteOf(async () => new Response(l.body, { status: 200 })).download('bundles/office/0.1.1.zip', { expectedBytes: OFFICE_BYTES });
    const state = watched(got);
    for (let sent = 0; sent < OFFICE_BYTES; sent += 20_000) {
      l.push(Math.min(20_000, OFFICE_BYTES - sent));
      await vi.advanceTimersByTimeAsync(1_000);
    }
    expect(state.settled, 'still coming after 55 s: not cut off').toBe(false);
    l.end();
    await expect(got).resolves.toHaveLength(OFFICE_BYTES);
  });

  it('nothing new for 30 s part way through: fails, and says so — 29 s of silence is still waiting', async () => {
    const l = line();
    const got = siteOf(async () => new Response(l.body, { status: 200 })).download('bundles/office/0.1.1.zip', { expectedBytes: OFFICE_BYTES });
    const state = watched(got);
    l.push(400_000);
    await vi.advanceTimersByTimeAsync(29_000);
    expect(state.settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1_000);
    await expect(got).rejects.toThrow('market bundles/office/0.1.1.zip: nothing came for 30 s');
  });

  it('no answer at all for 30 s (the request hangs): fails the same way', async () => {
    const got = siteOf(() => new Promise<Response>(() => undefined)).readText('index.json');
    const state = watched(got);
    await vi.advanceTimersByTimeAsync(29_000);
    expect(state.settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1_000);
    await expect(got).rejects.toThrow('market index.json: nothing came for 30 s');
  });

  it('more than the index recorded stops at once; the index itself reads as text', async () => {
    const big = line();
    const tooMuch = siteOf(async () => new Response(big.body, { status: 200 })).download('bundles/x.zip', { expectedBytes: 10 });
    big.push(11);
    await expect(tooMuch).rejects.toThrow('Bundle size mismatch: expected 10 bytes, got more than that');
    await expect(siteOf(async () => new Response('{"apps":[]}', { status: 200 })).readText('index.json')).resolves.toBe('{"apps":[]}');
    await expect(siteOf(async () => new Response('gone', { status: 404 })).readText('index.json')).rejects.toThrow('market index.json: HTTP 404');
  });
});
