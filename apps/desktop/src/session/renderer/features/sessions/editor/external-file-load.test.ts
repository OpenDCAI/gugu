import { describe, expect, it, vi } from 'vitest';

vi.mock('@renderer/lib/monaco/monaco-model-registry', () => ({
  modelRegistry: {
    dirtyUris: new Set<string>(),
    toDiskUri: (uri: string) => uri.replace(/^file:\/\//, 'disk://'),
  },
}));

import {
  applyExternalFileLoad,
  readExternalFileForTab,
  type ExternalFileReaders,
} from './external-file-load';
import { FileTabResource } from './stores/file-tab-resource';

type ImageRead = Awaited<ReturnType<ExternalFileReaders['readImage']>>;
type TextRead = Awaited<ReturnType<ExternalFileReaders['readExternalFile']>>;

const DATA_URL = 'data:image/png;base64,iVBORw0KGgo=';
const MAX_BYTES = 1024;

function imageRead(read: unknown): ExternalFileReaders['readImage'] {
  return vi.fn(async () => read as ImageRead);
}

function textRead(read: unknown): ExternalFileReaders['readExternalFile'] {
  return vi.fn(async () => read as TextRead);
}

function readers(overrides: Partial<ExternalFileReaders> = {}): ExternalFileReaders {
  return {
    readImage: imageRead({
      success: true,
      data: { success: true, dataUrl: DATA_URL, mimeType: 'image/png', size: 8 },
    }),
    // What the text read says about any png: binary. Reaching it for an image is the bug.
    readExternalFile: textRead({
      success: true,
      data: { content: '', binary: true, truncated: false, totalSize: 8 },
    }),
    ...overrides,
  };
}

function externalTab(path: string): FileTabResource {
  return new FileTabResource({ path, isExternal: true });
}

/**
 * #6455: an image outside the workspace was read as text, came back `binary`, and the tab
 * drew「不支持的文件格式」—— every image an agent opened for someone from its scratch space.
 */
describe('readExternalFileForTab', () => {
  it('reads an image outside the workspace as an image, never as text', async () => {
    const r = readers();
    const load = await readExternalFileForTab('image', '/Users/me/shot.png', MAX_BYTES, r);

    expect(load).toEqual({ kind: 'image', dataUrl: DATA_URL });
    expect(r.readImage).toHaveBeenCalledWith('/Users/me/shot.png');
    expect(r.readExternalFile).not.toHaveBeenCalled();
  });

  it('says why an image could not be read', async () => {
    const tooLarge = readers({
      readImage: imageRead({
        success: true,
        data: { success: false, error: 'Image too large: 12000000 bytes (max 10485760)' },
      }),
    });
    expect(await readExternalFileForTab('image', '/Users/me/big.png', MAX_BYTES, tooLarge)).toEqual({
      kind: 'image-error',
      message: 'Image too large: 12000000 bytes (max 10485760)',
    });

    const missing = readers({
      readImage: imageRead({ success: false, error: { type: 'fs_error', message: 'ENOENT' } }),
    });
    expect(await readExternalFileForTab('image', '/Users/me/gone.png', MAX_BYTES, missing)).toEqual({
      kind: 'image-error',
      message: 'ENOENT',
    });
  });

  it('keeps a text file outside the workspace on the text read', async () => {
    const r = readers({
      readExternalFile: textRead({
        success: true,
        data: { content: 'hello', binary: false, truncated: false, totalSize: 5 },
      }),
    });
    const load = await readExternalFileForTab('text', '/Users/me/notes.txt', MAX_BYTES, r);

    expect(load).toEqual({ kind: 'text', content: 'hello' });
    expect(r.readExternalFile).toHaveBeenCalledWith('/Users/me/notes.txt', MAX_BYTES);
    expect(r.readImage).not.toHaveBeenCalled();
  });

  it('still reports a non-image binary and a truncated read as before', async () => {
    expect(await readExternalFileForTab('binary', '/Users/me/a.zip', MAX_BYTES, readers())).toEqual({
      kind: 'binary',
    });

    const truncated = readers({
      readExternalFile: textRead({
        success: true,
        data: { content: 'x', binary: false, truncated: true, totalSize: 9_000_000 },
      }),
    });
    expect(await readExternalFileForTab('text', '/Users/me/big.log', MAX_BYTES, truncated)).toEqual({
      kind: 'too-large',
      totalSize: 9_000_000,
    });
  });
});

describe('applyExternalFileLoad', () => {
  it('draws an image outside the workspace instead of the unsupported-format card', async () => {
    const tab = externalTab('/Users/me/shot.png');
    expect(tab.isLoading).toBe(true);

    applyExternalFileLoad(tab, await readExternalFileForTab(tab.fileKind, tab.path, MAX_BYTES, readers()));

    expect(tab.contentType).toBe('image');
    expect(tab.content).toBe(DATA_URL);
    expect(tab.isLoading).toBe(false);
  });

  it('shows the file-error card for an unreadable image, not an empty image', () => {
    const tab = externalTab('/Users/me/big.png');

    applyExternalFileLoad(tab, { kind: 'image-error', message: 'Image too large' });

    expect(tab.contentType).toBe('file-error');
    expect(tab.externalError).toBe('Image too large');
    expect(tab.isLoading).toBe(false);
  });
});
