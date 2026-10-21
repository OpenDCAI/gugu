import { describe, expect, it, vi } from 'vitest';
import { createGugu } from './create-gugu';

/**
 * `gugu.files.search({ query, suffixes, limit })` and `gugu.files.recent({ limit })` (gugu-supabase 20261017002319): what
 * they name is checked on the page — suffixes lowercased, a limit of 1-200 — and anything else is `invalid` before the host
 * is asked.
 */
describe('gugu.files.search / recent: what they ask for', () => {
  const host = () => {
    const search = vi.fn(async () => []);
    const recent = vi.fn(async () => []);
    const gugu = createGugu(
      { appFiles: { search, recent, watch: vi.fn(async () => undefined) }, reportError: vi.fn(async () => undefined) } as never,
      { files: () => import('./files-entry') as never },
    ) as unknown as { files: { search: (options?: unknown) => Promise<unknown>; recent: (options?: unknown) => Promise<unknown> } };
    return { gugu, search, recent };
  };

  it('to the host as named, suffixes in lower case; nothing named, nothing added', async () => {
    const { gugu, search, recent } = host();
    await gugu.files.search({ query: '周报', suffixes: ['.MD', '.pptx'], limit: 200 });
    await gugu.files.search();
    await gugu.files.recent({ limit: 1 });
    await gugu.files.recent();
    expect(search.mock.calls.map((call) => (call as unknown[])[0])).toEqual([{ query: '周报', suffixes: ['.md', '.pptx'], limit: 200 }, {}]);
    expect(recent.mock.calls.map((call) => (call as unknown[])[0])).toEqual([{ limit: 1 }, {}]);
  });

  it('what is not one is invalid, and the host is not asked', async () => {
    const { gugu, search, recent } = host();
    for (const options of [{ query: 3 }, { suffixes: ['md'] }, { suffixes: '.md' }, { limit: 0 }, { limit: 201 }, { limit: 2.5 }, 'report']) {
      await expect(gugu.files.search(options)).rejects.toMatchObject({ code: 'invalid' });
    }
    await expect(gugu.files.recent({ limit: 0 })).rejects.toMatchObject({ code: 'invalid' });
    expect(search).not.toHaveBeenCalled();
    expect(recent).not.toHaveBeenCalled();
  });
});
