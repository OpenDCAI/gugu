import { describe, expect, it, vi } from 'vitest';
import { createGugu } from './create-gugu';
import type { GuguHost } from './host';
import type { ExtensionFileChangeBatch } from '@shared/extensions/bridge-protocol';

describe('file subscriptions at the same place', () => {
  it('registers and delivers each subscription separately, then cancels only its handler', () => {
    let changed!: Parameters<GuguHost['onFilesChanged']>[0];
    const watch = vi.fn(async (_args: Parameters<GuguHost['appFiles']['watch']>[0]) => undefined);
    const gugu = createGugu({
      appFiles: { watch }, reportError: vi.fn(),
      onFilesChanged: (fn: typeof changed) => { changed = fn; return () => undefined; },
    } as never, {} as never) as unknown as { files: { onChanged: (place: unknown, handler: (change: ExtensionFileChangeBatch) => void) => () => void } };
    const place = { chat: '0b000000-0000-4000-8000-000000000001' };
    const owner = vi.fn(), agent = vi.fn();
    const stopOwner = gugu.files.onChanged(place, owner);
    const stopAgent = gugu.files.onChanged(place, agent);
    expect(watch.mock.calls).toEqual([
      [{ watchId: '1', place, on: true }], [{ watchId: '2', place, on: true }],
    ]);
    const batch: ExtensionFileChangeBatch = { kind: 'entries', entries: [], gone: ['removed'] };
    changed('1', batch);
    expect(owner).toHaveBeenCalledWith(batch);
    expect(agent).not.toHaveBeenCalled();
    stopOwner(); stopOwner();
    changed('1', batch); changed('2', batch);
    expect(owner).toHaveBeenCalledTimes(1);
    expect(agent).toHaveBeenCalledTimes(1);
    expect(watch.mock.calls.at(-1)).toEqual([{ watchId: '1', place, on: false }]);
    stopAgent();
    expect(watch.mock.calls.at(-1)).toEqual([{ watchId: '2', place, on: false }]);
  });
});
