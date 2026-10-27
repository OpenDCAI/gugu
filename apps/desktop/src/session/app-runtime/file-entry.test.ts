import { afterEach, expect, it, vi } from 'vitest';
import { fileOpened, loadPage, until } from './fake-file-service';
import type { AppFileEntry } from '@shared/extensions/app-runtime-protocol';

afterEach(() => vi.unstubAllGlobals());

it('requests decoration after two frames and updates the entry without a document edit', async () => {
  const frames: FrameRequestCallback[] = [];
  vi.stubGlobal('requestAnimationFrame', (fn: FrameRequestCallback) => { frames.push(fn); return frames.length; });
  const { host, service, open } = await loadPage<{
    entry: AppFileEntry; text: string; close(): void; onChange(fn: (event: unknown) => void): void;
  }>();
  const opened = fileOpened('text');
  opened.entry.detailsPending = true;
  opened.entry.canDelete = false;
  host.appFiles.open.mockResolvedValueOnce(opened);
  const messages = vi.spyOn(service, 'fromPage');
  const file = await open();
  const changed = vi.fn();
  file.onChange(changed);
  expect(messages.mock.calls.map(([m]) => m)).not.toContainEqual({ t: 'entry', docName: opened.docName });
  frames.shift()!(0);
  expect(messages.mock.calls.map(([m]) => m)).not.toContainEqual({ t: 'entry', docName: opened.docName });
  frames.shift()!(0);
  await until(() => messages.mock.calls.some(([m]) => (m as { t?: string }).t === 'entry'));
  const { detailsPending: _pending, ...entry } = opened.entry;
  service.toPage!({ data: { t: 'entry', docName: opened.docName, entry: { ...entry, canDelete: true } } });
  expect(file.entry.canDelete).toBe(true);
  expect(file.entry).not.toHaveProperty('detailsPending');
  expect(file.text).toBe('');
  expect(changed).toHaveBeenCalledExactlyOnceWith({ local: false, entry: true });
  file.close();
});
