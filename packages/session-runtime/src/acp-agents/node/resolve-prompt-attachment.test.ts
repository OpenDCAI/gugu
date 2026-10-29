import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { LocalAttachmentStore } from './local-attachment-store';
import { createPromptAttachmentResolver } from './resolve-prompt-attachment';

it('retains path-carried image bytes across source deletion and runtime restart', async () => {
  const root = await mkdtemp(join(tmpdir(), 'prompt-image-'));
  try {
    const source = join(root, 'photo.png'), directory = join(root, 'attachments');
    await writeFile(source, new Uint8Array([1, 2, 3]));
    const resolved = await createPromptAttachmentResolver(new LocalAttachmentStore(directory))({ type: 'local-file', originalPath: source, name: 'photo.png', mimeType: 'image/png' });
    expect(resolved).toMatchObject({ data: 'AQID', ref: { name: 'photo.png', mimeType: 'image/png' } });
    await rm(source);
    const ref = resolved.ref!;
    expect(await createPromptAttachmentResolver(new LocalAttachmentStore(directory))({ type: 'attachment', id: ref.id, mimeType: ref.mimeType })).toEqual(resolved);
  } finally { await rm(root, { recursive: true, force: true }); }
});
