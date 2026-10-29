import { describe, expect, it } from 'vitest';
import { APP_FRAME_MARKER } from '@shared/extensions/app-runtime-protocol';

// Chats are named by their id (编号 18: placeOf refuses anything else).
const CHAT = '0c4a7e10-0000-4000-8000-000000000001';

/**
 * F16: an App's MCP program gets the same `gugu` as its pages, over the IPC channel main opened for it —
 * requests and answers as the phone's frame does, file sync traffic as `{ t: 'sync' }` on the same channel.
 * A fake channel, never the test process's own: vitest's workers talk to their runner over `process.send`.
 */
async function program() {
  const { startProgramGugu } = await import('./program-host');
  const sent: { t?: string; id?: number; method?: string }[] = [];
  const listeners: ((message: unknown) => void)[] = [];
  const gugu = startProgramGugu({
    send: (message: unknown) => {
      sent.push(message as { t?: string });
      return true;
    },
    on: (_event: 'message', listener: (message: unknown) => void) => listeners.push(listener),
  }) as Record<string, unknown> & { files: Record<string, (...args: unknown[]) => Promise<unknown>> };
  const deliver = (message: unknown) => listeners.forEach((listener) => listener(message));
  /** The next call the program sent, once it has (a files verb loads its module first). */
  const nextCall = async (after: number) => {
    for (let i = 0; i < 50; i += 1) {
      const call = sent.slice(after).find((message) => message.t === 'call');
      if (call) return call as { id: number; method: string };
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    throw new Error('no call was sent');
  };
  return { gugu, sent, deliver, nextCall };
}

describe('gugu in a program', () => {
  it('is the same gugu — files and the host verbs — without a page’s editor', async () => {
    const { gugu } = await program();
    expect(typeof gugu.files.open).toBe('function');
    expect(typeof gugu.files.list).toBe('function');
    expect(gugu.codemirror).toBeUndefined();
    expect(gugu.bind).toBeUndefined();
    expect(gugu.program).toBeUndefined(); // a host flag, not part of the API
    expect(gugu.onProjection).toBeUndefined();
    expect(gugu.onProjectionSource).toBeUndefined();
  });

  it('asks main over its channel, and main’s answer settles the call', async () => {
    const { gugu, sent, deliver, nextCall } = await program();
    const listing = gugu.files.list({ chat: CHAT });
    const call = await nextCall(sent.length);
    expect(call).toMatchObject({ m: APP_FRAME_MARKER, method: 'filesList', args: { place: { chat: CHAT } } });
    deliver({ m: APP_FRAME_MARKER, t: 'result', id: call.id, ok: true, value: [{ id: 'item-1', name: 'a.md' }] });
    await expect(listing).resolves.toEqual([{ id: 'item-1', name: 'a.md' }]);
  });

  it('exposes projection sources and keeps later capture outside the finished calling agent scope', async () => {
    const { gugu, sent, deliver, nextCall } = await program();
    const { programCall } = await import('./program-call');
    const api = gugu.projection as { create(driver: { input(): Promise<void>; disconnect(): Promise<void>; refresh(): void; close(): void }): Promise<{
      id: string; publish(frame: unknown): Promise<void>;
    }> };
    let refreshes = 0;
    const created = programCall.run('projection-tool-call', () => api.create({ input: async () => {}, disconnect: async () => {},
      refresh: () => { refreshes++; }, close() {},
    }));
    const creation = await nextCall(0);
    expect(creation).toMatchObject({ method: 'projectionCreate', call: 'projection-tool-call' });
    deliver({ m: APP_FRAME_MARKER, t: 'result', id: creation.id, ok: true, value: { id: 'projection-resource' } });
    const source = await created;
    deliver({ m: APP_FRAME_MARKER, t: 'event', event: { type: 'projectionSource', event: { type: 'refresh', id: source.id } } });
    await Promise.resolve();
    expect(refreshes).toBe(1);
    const before = sent.length;
    const published = source.publish({ width: 1, height: 1, mime: 'image/png', data: 'YQ==' });
    const publication = await nextCall(before);
    expect(publication).toMatchObject({ method: 'projectionPublish', args: { id: 'projection-resource', frame: { sequence: 1 } } });
    expect(publication).not.toHaveProperty('call');
    deliver({ m: APP_FRAME_MARKER, t: 'result', id: publication.id, ok: true });
    await published;
  });

  it('keeps file sync frames apart from calls: a sync frame is never taken for an answer', async () => {
    const { gugu, sent, deliver, nextCall } = await program();
    const before = sent.length;
    const listing = gugu.files.list({ chat: CHAT });
    const call = await nextCall(before);
    deliver({ m: APP_FRAME_MARKER, t: 'sync', data: { t: 'up' } });
    // Control: still waiting after a sync frame; the answer settles it.
    await expect(Promise.race([listing, new Promise((resolve) => setTimeout(() => resolve('still waiting'), 20))])).resolves.toBe('still waiting');
    deliver({ m: APP_FRAME_MARKER, t: 'result', id: call.id, ok: false, code: 'denied', message: 'no' });
    await expect(listing).rejects.toMatchObject({ code: 'denied' });
  });

  // play4 10-13: Codex's edit, 42 ms after Claude's read of the same deck, was saved as Claude's — main had to guess which
  // call a verb was for. Now the verb says it: the tool call it was made in (program-call.ts), or none.
  it('a verb made inside a tool call says which call it is; one made outside every call says none', async () => {
    const { gugu, sent, deliver, nextCall } = await program();
    const { programCall } = await import('./program-call');
    const before = sent.length;
    const inCall = programCall.run('call-7', () => gugu.files.list({ chat: CHAT }));
    const first = await nextCall(before);
    expect(first).toMatchObject({ m: APP_FRAME_MARKER, method: 'filesList', call: 'call-7' });
    deliver({ m: APP_FRAME_MARKER, t: 'result', id: first.id, ok: true, value: [] });
    await inCall;
    const after = sent.length;
    const outside = gugu.files.list({ chat: CHAT });
    const second = await nextCall(after);
    expect(second).not.toHaveProperty('call');
    deliver({ m: APP_FRAME_MARKER, t: 'result', id: second.id, ok: true, value: [] });
    await outside;
  });
});
