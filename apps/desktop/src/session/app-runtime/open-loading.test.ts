import { expect, it, vi } from 'vitest';
import { createGugu, type FilesModule } from './create-gugu';

it('starts the authorized file request while its runtime loads, and hands that same request to the replica', async () => {
  let loaded!: (module: FilesModule) => void;
  const runtime = new Promise<FilesModule>((resolve) => { loaded = resolve; });
  const requested = { entry: { id: 'file' } };
  const open = vi.fn(async () => requested);
  const gugu = createGugu({ appFiles: { open }, reportError: vi.fn() } as never, { files: () => runtime }) as {
    files: { open(file: unknown, options?: { readOnly: boolean }): Promise<object> };
  };
  const result = gugu.files.open({ id: 'file' }, { readOnly: true });
  expect(open).toHaveBeenCalledExactlyOnceWith({ ref: { id: 'file' }, readOnly: true });
  const handle = {};
  const openFile = vi.fn(async (_host: unknown, answer: Promise<unknown>) => {
    expect(await answer).toBe(requested);
    return handle;
  });
  loaded({ openFile } as unknown as FilesModule);
  expect(await result).toBe(handle);
  expect(openFile).toHaveBeenCalledOnce();
});
