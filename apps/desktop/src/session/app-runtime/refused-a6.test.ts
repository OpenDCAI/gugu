import { describe, expect, it } from 'vitest';
import { loadPage, until } from './fake-file-service';

/**
 * L11 A6: a change the file service refused is said in one place — by the runtime, into the App's error record (the
 * slot's red dot, 摩擦单 F63), for every App alike; `onRefused` stays for an App that wants to say more. Too large goes
 * the way a rate limit already went.
 * 摩擦单 F108: one plain line naming the file and why — pinned by what it does (once, naming the file), not its words.
 */

type TextFile = { insert(index: number, text: string): void; close(): void; text: string; saved: boolean };

describe('a change the file service refused is said by the runtime (L11 A6, 摩擦单 F108)', () => {
  it("too large: the App's error record hears it once, naming the file, whether or not the App listens to onRefused", async () => {
    const { service, host, open } = await loadPage<TextFile>('text');
    const file = await open();
    file.insert(0, 'a');
    await until(() => service.text('item-1@1') === 'a');
    service.closeDocument('item-1@1', 'too-large');
    const said = () => host.reportError.mock.calls.filter(([message]) => message.includes('notes.md'));
    await until(() => said().length > 0);
    expect(said()).toHaveLength(1);
    file.close();
  });

  it('rate-limited: said once for the file however often it comes, and the writes still land after reconnecting', async () => {
    const { service, host, open } = await loadPage<TextFile>('text');
    const file = await open();
    for (let round = 1; round <= 2; round += 1) {
      file.insert(file.text.length, `round ${round} `);
      await until(() => service.text('item-1@1') === file.text);
      service.closeDocument('item-1@1', 'rate-limited');
      file.insert(file.text.length, `offline ${round} `);
      // Back after the runtime's step back (1 s, then 2 s).
      await until(() => file.saved && service.text('item-1@1') === file.text, 10_000);
    }
    expect(host.reportError.mock.calls.filter(([message]) => message.includes('notes.md'))).toHaveLength(1);
    expect(service.text('item-1@1')).toBe('round 1 offline 1 round 2 offline 2 ');
    file.close();
  });
});
