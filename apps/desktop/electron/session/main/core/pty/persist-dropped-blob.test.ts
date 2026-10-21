import { mkdtemp, mkdir, stat, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  cleanupExpiredDroppedBlobs,
  DROPPED_BLOB_DIRECTORY_NAME,
  DROPPED_BLOB_MAX_AGE_MS,
  inferDroppedBlobExtension,
  isHeicLike,
  sanitizeDroppedBlobName,
} from './persist-dropped-blob';

const roots: string[] = [];

afterEach(async () => {
  const { rm } = await import('node:fs/promises');
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('persist-dropped-blob', () => {
  it('sanitizes unsafe file names', () => {
    expect(sanitizeDroppedBlobName('../../evil name!.png')).toBe('evil_name_.png');
  });

  it('infers extension from mime type', () => {
    expect(inferDroppedBlobExtension(undefined, 'image/heic')).toBe('.heic');
    expect(inferDroppedBlobExtension('photo.PNG', undefined)).toBe('.png');
  });

  it('detects HEIC-like inputs', () => {
    expect(isHeicLike({ name: 'shot.heic' })).toBe(true);
    expect(isHeicLike({ mimeType: 'image/heif' })).toBe(true);
    expect(isHeicLike({ name: 'shot.png', mimeType: 'image/png' })).toBe(false);
  });

  it('cleans only expired files inside the owned temp directory', async () => {
    const root = await mkdtemp(join(tmpdir(), 'gugu-dropped-blob-cleanup-'));
    roots.push(root);
    const owned = join(root, DROPPED_BLOB_DIRECTORY_NAME);
    const unrelated = join(root, 'unrelated.tmp');
    const expired = join(owned, 'expired.png');
    const fresh = join(owned, 'fresh.png');
    const now = Date.now();

    await mkdir(owned);
    await Promise.all([
      writeFile(unrelated, 'unrelated'),
      writeFile(expired, 'expired'),
      writeFile(fresh, 'fresh'),
    ]);
    const expiredAt = new Date(now - DROPPED_BLOB_MAX_AGE_MS - 1);
    await utimes(expired, expiredAt, expiredAt);

    await cleanupExpiredDroppedBlobs(now, root);

    await expect(stat(expired)).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(stat(fresh)).resolves.toBeDefined();
    await expect(stat(unrelated)).resolves.toBeDefined();
  });
});
