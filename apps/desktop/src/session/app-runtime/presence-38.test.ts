import * as decoding from 'lib0/decoding';
import { describe, expect, it } from 'vitest';
import { loadPage, until } from './fake-file-service';

/**
 * 摩擦单 F38 (L5 S2): a snake set in presence every 140 ms arrived unevenly. On the wire, each `presence.set` was two
 * awareness frames (who, then what) — twice what the file service's per-connection presence limit counts, and one frame
 * the others applied for nothing. One set, one frame.
 */

type PresenceFile = { presence: { set(state: unknown): void }; close(): void };

/** The states in one awareness frame (`y-protocols/awareness` encoding: count, then clientID, clock, JSON each). */
function statesIn(frame: Uint8Array): unknown[] {
  const decoder = decoding.createDecoder(frame);
  const states: unknown[] = [];
  for (let n = decoding.readVarUint(decoder); n > 0; n -= 1) {
    decoding.readVarUint(decoder);
    decoding.readVarUint(decoder);
    states.push(JSON.parse(decoding.readVarString(decoder)));
  }
  return states;
}

const settle = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe('presence on the wire (摩擦单 F38)', () => {
  it('one presence.set is one awareness frame, carrying who and what together', async () => {
    const { service, open } = await loadPage<PresenceFile>('text');
    const file = await open();
    // Past the first publish at open.
    await settle(120);
    const before = service.awareness.length;
    file.presence.set({ seq: 1 });
    await until(() => service.awareness.length > before);
    await settle(120);
    const sent = service.awareness.slice(before);
    // Control: the same test on e66bb6a6d sends 2 (`user`, then `s`).
    expect(sent).toHaveLength(1);
    expect(statesIn(sent[0]!)).toEqual([expect.objectContaining({ s: { seq: 1 }, user: expect.objectContaining({ id: expect.any(String) }) })]);
    file.close();
  });
});
