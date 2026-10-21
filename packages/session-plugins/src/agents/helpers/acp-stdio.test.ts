import { PassThrough, Readable } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';

import { nodeReadableToWeb } from './acp-stdio';

describe('nodeReadableToWeb', () => {
  it('drives delayed Node stdout without relying on Readable.toWeb flowing mode', async () => {
    const source = new PassThrough();
    const toWeb = vi.spyOn(Readable, 'toWeb').mockImplementation(() => {
      throw new Error('Readable.toWeb must not own ACP stdout flow');
    });
    const reader = nodeReadableToWeb(source).getReader();

    const first = reader.read();
    source.write('{"id":1}\n');

    await expect(first).resolves.toEqual({
      done: false,
      value: Uint8Array.from(Buffer.from('{"id":1}\n')),
    });
    source.end();
    await expect(reader.read()).resolves.toEqual({ done: true, value: undefined });
    expect(toWeb).not.toHaveBeenCalled();
  });

  it('propagates child stdout errors to the web reader', async () => {
    const source = new PassThrough();
    const reader = nodeReadableToWeb(source).getReader();
    const failure = new Error('adapter stdout failed');

    source.destroy(failure);

    await expect(reader.read()).rejects.toThrow('adapter stdout failed');
  });
});
