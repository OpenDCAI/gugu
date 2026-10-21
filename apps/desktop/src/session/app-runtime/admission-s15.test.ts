import { describe, expect, it } from 'vitest';
import * as decoding from 'lib0/decoding';
import { loadPage, until } from './fake-file-service';

/**
 * S15 (统筹 10:20, 真源原则 9 / §2.4): what the page itself does with the file service's word about who it is and whether
 * it may still be there. Its identity in presence is the one the service stamps on its connection (`{t:'self'}`, 摩擦单
 * F9), never what the page had before; closed as `removed-from-group`, the file is over at once — `gone`, and nothing
 * written after reaches the service.
 */

type TextFile = {
  text: string;
  insert(index: number, text: string): void;
  readonly status: string;
  readonly presence: { readonly self: { userId: string; name: string; color: string }; set(state: unknown): void };
  close(): void;
};

/** The states in a `y-protocols/awareness` update, in order. */
function statesOf(update: Uint8Array): { user?: { id?: string; color?: string } }[] {
  const decoder = decoding.createDecoder(update);
  const states: { user?: { id?: string; color?: string } }[] = [];
  for (let count = decoding.readVarUint(decoder); count > 0; count -= 1) {
    decoding.readVarUint(decoder);
    decoding.readVarUint(decoder);
    states.push(JSON.parse(decoding.readVarString(decoder)) as { user?: { id?: string; color?: string } });
  }
  return states;
}

const settle = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe("the page's identity is the file service's stamp (S15, F9)", () => {
  it("takes the service's self for its presence — before it, main's word, with no colour of its own", async () => {
    const { service, open } = await loadPage<TextFile>('text');
    const file = await open();
    // Control: before the service has said who this connection is.
    expect(file.presence.self).toMatchObject({ userId: 'user:a', color: '' });
    const framesBefore = service.awareness.length;
    service.say('item-1@1', { t: 'self', user: { id: 'b0000000-0000-4000-8000-00000000000b', name: 'Stamped', color: '#123456' } });
    await until(() => file.presence.self.color === '#123456');
    expect(file.presence.self).toMatchObject({ userId: 'user:b0000000-0000-4000-8000-00000000000b', name: 'Stamped' });
    // And the presence it sends from then on carries the stamp.
    file.presence.set({ cursor: 1 });
    await until(() => service.awareness.length > framesBefore);
    const sent = statesOf(service.awareness.at(-1)!).at(-1);
    expect(sent?.user).toMatchObject({ id: 'user:b0000000-0000-4000-8000-00000000000b', color: '#123456' });
    file.close();
  });
});

describe('a file the person may no longer have (S15, 原则 9)', () => {
  it('closed as removed-from-group: gone at once, and a write after is refused out loud and goes nowhere', async () => {
    const { service, open } = await loadPage<TextFile>('text');
    const file = await open();
    file.insert(0, 'a');
    await until(() => service.text('item-1@1') === 'a');
    service.closeDocument('item-1@1', 'removed-from-group');
    await until(() => file.status === 'gone');
    expect(() => file.insert(1, 'b')).toThrow('no longer available');
    await settle(1500);
    expect(service.text('item-1@1')).toBe('a');
    file.close();
  });

  it('control: closed as rate-limited it is not over — it comes back and the write lands', async () => {
    const { service, open } = await loadPage<TextFile>('text');
    const file = await open();
    file.insert(0, 'a');
    await until(() => service.text('item-1@1') === 'a');
    service.closeDocument('item-1@1', 'rate-limited');
    file.insert(1, 'b');
    await until(() => service.text('item-1@1') === 'ab', 8000);
    expect(file.status).not.toBe('gone');
    file.close();
  });
});
