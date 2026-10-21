import { afterEach, describe, expect, it, vi } from 'vitest';
import { loadPage } from './fake-file-service';

/**
 * 摩擦单 F62 (L5): an App kept its turn clock in the file — written ~4.7 times a second with nobody playing. Nothing is
 * refused; its author hears it once, in the App's error record (`app_check` reads it back): per-frame state goes in
 * presence, the file gets events.
 *
 * 摩擦单 F84 (S19): "show my stroke as I draw it" went into the file every ~40 ms (`liveStrokes[me]`) and the hint stayed
 * silent — it counted only with nobody at the keys, and a person drawing keeps the page's user activation on. What the
 * hint is about is one position of the JSON overwritten frame after frame, whoever is there. Typing (collaborative text)
 * is never it. Not covered: an App replacing a whole text file every frame.
 */

type TextField = { insert(index: number, text: string): void };
type JsonFile = { data: Record<string, unknown>; textAt(path: (string | number)[]): TextField; close(): void };

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

async function writing(perSecond: number, seconds: number, write: (file: JsonFile, tick: number) => void, before?: (file: JsonFile) => void) {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  const { open, host, STALL_MS } = await loadPage<JsonFile>('json');
  expect(STALL_MS).toBeGreaterThan(0);
  const file = await open();
  before?.(file);
  for (let tick = 0; tick < perSecond * seconds; tick += 1) {
    write(file, tick);
    await vi.advanceTimersByTimeAsync(1000 / perSecond);
  }
  const calls = host.reportError.mock.calls as unknown as [string, { level?: string } | undefined][];
  const hinted = calls.filter(([message]) => String(message).includes('times a second'));
  // A hint for the author, not a sign the App is broken: no red dot on the slot (统筹 03:50).
  for (const [, options] of hinted) expect(options).toEqual({ level: 'hint' });
  file.close();
  return hinted.map(([message]) => message);
}

const clock = (file: JsonFile, tick: number) => {
  file.data.clock = tick;
};

describe('one position of the file written frame after frame gets one hint (摩擦单 F62 / F84)', () => {
  it('a clock in the file, 5 writes a second for 12 s: one hint, naming it, with the rate and where frame state goes', async () => {
    const hints = await writing(5, 12, clock);
    expect(hints).toHaveLength(1);
    expect(hints[0]).toMatch(/: `clock` written [\d.]+ times a second: keep what changes every frame in f\.presence/);
    // The rate over the last 10 s (the first second counted from its first write).
    expect(Number(/written ([\d.]+) times/.exec(hints[0]!)![1])).toBeGreaterThanOrEqual(4.5);
  });

  it('control: 2 writes a second (a person’s pace, events): no hint', async () => {
    expect(await writing(2, 12, clock)).toEqual([]);
  });

  it('F84: a stroke drawn into the file each frame while the person holds the pointer (user activation on): one hint', async () => {
    vi.stubGlobal('navigator', { userActivation: { isActive: true } });
    const points: number[][] = [];
    const hints = await writing(
      25,
      11,
      (file, tick) => {
        points.push([tick, tick * 2]);
        (file.data.liveStrokes as Record<string, unknown>)['user:u1'] = [...points]; // merges into the array there
      },
      (file) => {
        file.data.liveStrokes = {};
      }
    );
    expect(hints).toHaveLength(1);
    expect(hints[0]).toMatch(/: `liveStrokes\.user:u1` written/);
  });

  it('control: many positions, each written once (votes coming in fast): no hint', async () => {
    expect(await writing(5, 12, (file, tick) => ((file.data.votes as Record<string, unknown>)[`user:${tick}`] = 1), (file) => (file.data.votes = {}))).toEqual([]);
  });

  it('control: typing fast in collaborative text ($text) is what text is for: no hint', async () => {
    expect(await writing(8, 12, (file) => file.textAt(['note']).insert(0, 'x'), (file) => (file.data.note = { $text: '' }))).toEqual([]);
  });
});
