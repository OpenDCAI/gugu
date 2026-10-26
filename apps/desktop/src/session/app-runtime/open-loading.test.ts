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

it('settles a fast metadata refusal and reports it even while the runtime is still loading', async () => {
  let loaded!: (module: FilesModule) => void;
  const runtime = new Promise<FilesModule>((resolve) => { loaded = resolve; });
  const report = vi.fn(async () => undefined);
  const gugu = createGugu({
    appFiles: { open: async () => { throw Object.assign(new Error('gone'), { code: 'not-found' }); } },
    reportError: vi.fn(), checkPage: { report },
  } as never, { files: () => runtime }) as { files: { open(file: unknown): Promise<object> } };
  await expect(gugu.files.open({ id: 'file' })).rejects.toMatchObject({ code: 'not-found' });
  expect(report).toHaveBeenLastCalledWith(expect.objectContaining({ opens: 1, opensSettled: 1 }));
  loaded({ openFile: async (_host: unknown, requested: Promise<object>) => requested } as unknown as FilesModule);
});
