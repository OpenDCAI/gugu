import { mkdtemp, mkdir, readFile, rm, stat, truncate, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { TimelineArchive } from '@gugu/session-core/session-record';

const state = vi.hoisted(() => ({ root: '' }));
vi.mock('electron', () => ({ app: { getPath: () => state.root } }));
vi.mock('@main/lib/logger', () => ({ log: { warn: vi.fn(), info: vi.fn() } }));
const io = vi.hoisted(() => ({ readFile: vi.fn() }));
vi.mock('node:fs/promises', async (original) => {
  const fs = await original<typeof import('node:fs/promises')>();
  io.readFile.mockImplementation(fs.readFile);
  return { ...fs, readFile: io.readFile };
});

import { loadTimelineArchive, saveTimelineArchive } from './archive-store';

const archive = (extra: Record<string, unknown> = {}) => ({ epoch: 'epoch', sourceBytes: 0, ...extra }) as unknown as TimelineArchive;
const file = (id: string) => join(state.root, 'session-timeline-archive', `${id}.json`);

beforeEach(async () => {
  if (!state.root) state.root = await mkdtemp(join(tmpdir(), 'gugu-archive-budget-'));
  await mkdir(join(state.root, 'session-timeline-archive'), { recursive: true });
  io.readFile.mockClear();
});
afterEach(async () => {
  vi.restoreAllMocks();
  await rm(join(state.root, 'session-timeline-archive'), { recursive: true, force: true });
});
afterAll(async () => { await rm(state.root, { recursive: true, force: true }); });

describe('timeline archive disk budget', () => {
  it('round trips a small archive through the real disk path', async () => {
    const one = archive({ seq: 2, seenKeys: ['one'] });
    await saveTimelineArchive('small', one);
    expect(JSON.parse(await readFile(file('small'), 'utf8'))).toEqual(one);
    expect(await loadTimelineArchive('small')).toEqual(one);
  });

  it.each([64 * 1024 * 1024 + 1, 596_177_689])('skips a %i-byte sparse cache before read or parse', async (size) => {
    await writeFile(file('large'), '');
    await truncate(file('large'), size);
    expect((await stat(file('large'))).size).toBe(size);
    const parse = vi.spyOn(JSON, 'parse');
    expect(await loadTimelineArchive('large')).toBeNull();
    expect(io.readFile).not.toHaveBeenCalled();
    expect(parse).not.toHaveBeenCalled();
  });

  it('does not stringify when consumed source bytes exceed the cap', async () => {
    const huge = 'x'.repeat(128 * 1024 * 1024);
    const encode = vi.spyOn(JSON, 'stringify');
    await saveTimelineArchive('large-text', archive({ sourceBytes: 600 * 1024 * 1024, text: huge }));
    await saveTimelineArchive('many', archive({ sourceBytes: 8 * 1024 * 1024 + 1, seenKeys: new Array(1_000_000) }));
    expect(encode).not.toHaveBeenCalled();
    await expect(stat(file('large-text'))).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(stat(file('many'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('keeps the 64 MiB read ceiling for legacy caches without source byte metadata', async () => {
    await writeFile(file('legacy'), JSON.stringify({ epoch: 'legacy', text: 'x'.repeat(128 * 1024) }));
    expect((await loadTimelineArchive('legacy'))?.epoch).toBe('legacy');
  });

  it('treats a missing or corrupt cache as a cache miss', async () => {
    expect(await loadTimelineArchive('missing')).toBeNull();
    await writeFile(file('corrupt'), '{');
    expect(await loadTimelineArchive('corrupt')).toBeNull();
    await expect(stat(file('corrupt'))).rejects.toMatchObject({ code: 'ENOENT' });
  });
});
