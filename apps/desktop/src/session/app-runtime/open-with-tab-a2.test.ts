import { describe, expect, it, vi } from 'vitest';
import { createGugu } from './create-gugu';

const CHAT = '33333333-3333-4333-8333-3333333333a2';
const FILE = '44444444-4444-4444-8444-4444444444a2';

/**
 * A2 (data-lens 评审): `gugu.files.openWith(file, { tab })` — the runtime passes `tab` to the host as the page gave it;
 * whether it names this App's own tab that claims the file is the host's to say (main, the phone's outer page), never
 * the page's. The other options as before.
 */
describe('gugu.files.openWith: { tab } reaches the host (A2 T10)', () => {
  const host = () => {
    const openWith = vi.fn(async () => undefined);
    const gugu = createGugu(
      { appFiles: { openWith, download: vi.fn(async () => undefined), watch: vi.fn(async () => undefined) }, reportError: vi.fn(async () => undefined) } as never,
      { files: async () => ({}) as never },
    ) as unknown as { files: { openWith: (file: unknown, options?: unknown) => Promise<unknown> } };
    return { gugu, openWith };
  };

  it('T10: { tab } goes to the host with the file; with at and peek, all three', async () => {
    const { gugu, openWith } = host();
    await gugu.files.openWith({ chat: CHAT, id: FILE }, { tab: 'explore' });
    await gugu.files.openWith({ chat: CHAT, id: FILE }, { tab: 'explore', at: { sheet: 'Q3' }, peek: true });
    expect(openWith.mock.calls.map((call) => (call as unknown as [Record<string, unknown>])[0])).toEqual([
      { ref: { chat: CHAT, id: FILE }, tab: 'explore' },
      { ref: { chat: CHAT, id: FILE }, tab: 'explore', at: { sheet: 'Q3' }, peek: true },
    ]);
  });

  it.each(['', null, 42])('passes an invalid tab %s to the trusted host instead of silently choosing another opener', async (tab) => {
    const { gugu, openWith } = host();
    await gugu.files.openWith({ chat: CHAT, id: FILE }, { tab });
    expect(openWith).toHaveBeenCalledExactlyOnceWith({ ref: { chat: CHAT, id: FILE }, tab });
  });

  it('control: without tab, the host is asked as before', async () => {
    const { gugu, openWith } = host();
    await gugu.files.openWith({ chat: CHAT, id: FILE });
    await gugu.files.openWith({ chat: CHAT, id: FILE }, { ask: true });
    expect(openWith.mock.calls.map((call) => (call as unknown as [Record<string, unknown>])[0])).toEqual([
      { ref: { chat: CHAT, id: FILE } },
      { ref: { chat: CHAT, id: FILE }, ask: true },
    ]);
  });

  it.each(['preview', 'pinned', 'invalid', null])('folder redesign intent %s is carried unchanged to the trusted host', async (intent) => {
    const { gugu, openWith } = host();
    await gugu.files.openWith({ chat: CHAT, id: FILE }, { intent });
    expect(openWith).toHaveBeenCalledExactlyOnceWith({ ref: { chat: CHAT, id: FILE }, intent });
  });
});
