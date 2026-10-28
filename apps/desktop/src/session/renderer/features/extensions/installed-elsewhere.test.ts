import { describe, expect, it, vi } from 'vitest';

vi.mock('@renderer/lib/ipc', () => ({ rpc: {}, rpcOn: () => ({}) }));
const { installedElsewhere } = await import('./installed-elsewhere');

/** I10 (architecture): uninstalled everywhere ⇒ no grant left. Only then are the account's rows cleared. */
const world = (devices: { id: string; isOnline: boolean }[], has: Record<string, string[] | 'broken'>) => ({
  devices: () => devices,
  installed: async (deviceId: string | null) => {
    const ids = has[deviceId ?? 'here'];
    if (ids === 'broken') throw new Error('unreadable');
    return ids ?? [];
  },
});

describe('I10 an App uninstalled from the last of the person’s computers', () => {
  it('none of the others has it: it is gone everywhere', async () => {
    await expect(installedElsewhere('board', null, world([{ id: 'b', isOnline: true }], { b: ['sheet'] }))).resolves.toBe(false);
  });

  it('another online one has it — this computer too, when the uninstall was on another one', async () => {
    await expect(installedElsewhere('board', null, world([{ id: 'b', isOnline: true }], { b: ['board'] }))).resolves.toBe(true);
    await expect(installedElsewhere('board', 'b', world([{ id: 'b', isOnline: true }], { here: ['board'] }))).resolves.toBe(true);
  });

  it('an offline one, or one whose list cannot be read, may have it: the grants stay', async () => {
    await expect(installedElsewhere('board', null, world([{ id: 'b', isOnline: false }], {}))).resolves.toBe(true);
    await expect(installedElsewhere('board', null, world([{ id: 'b', isOnline: true }], { b: 'broken' }))).resolves.toBe(true);
  });
});
