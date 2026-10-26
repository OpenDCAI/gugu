import { describe, expect, it, vi } from 'vitest';
import { ExtensionGuestBinding } from './extension-guest-binding';

const pending = () => {
  let resolve!: (value: { success: boolean }) => void;
  const promise = new Promise<{ success: boolean }>((done) => { resolve = done; });
  return { promise, resolve };
};

const target = { tabId: 'tab', sessionId: 'session' };

describe('App guest binding belongs to the live webContents (#7514)', () => {
  it('reclaims an unchanged binding without another IPC call, while a changed target is retargeted', async () => {
    const bind = vi.fn().mockResolvedValue({ success: true });
    const retarget = vi.fn().mockResolvedValue({ success: true });
    const lifecycle = new ExtensionGuestBinding({ bind, retarget });
    lifecycle.ready(8);
    await lifecycle.aim(target);
    await lifecycle.aim({ ...target });
    expect(bind).toHaveBeenCalledOnce();
    expect(retarget).not.toHaveBeenCalled();
    await lifecycle.aim({ ...target, itemId: 'file' });
    expect(retarget).toHaveBeenCalledExactlyOnceWith(8, { ...target, itemId: 'file' });
  });

  it('ignores a destroyed guest completing its bind after another guest is ready', async () => {
    const old = pending();
    const next = pending();
    const bind = vi.fn().mockReturnValueOnce(old.promise).mockReturnValueOnce(next.promise);
    const retarget = vi.fn();
    const lifecycle = new ExtensionGuestBinding({ bind, retarget });
    lifecycle.ready(10);
    const first = lifecycle.aim(target);
    await Promise.resolve();
    lifecycle.reset();
    lifecycle.ready(20);
    const second = lifecycle.aim(target);
    await Promise.resolve();
    old.resolve({ success: true });
    expect(await first).toBeNull();
    expect(lifecycle.boundWebContentsId).toBeNull();
    expect(bind.mock.calls.map(([id]) => id)).toEqual([10, 20]);
    expect(retarget).not.toHaveBeenCalled();
    next.resolve({ success: true });
    expect(await second).toMatchObject({ webContentsId: 20, success: true });
    expect(lifecycle.boundWebContentsId).toBe(20);
  });

  it('binds a recreated guest even when the same DOM webview remains', async () => {
    const bind = vi.fn().mockResolvedValue({ success: true });
    const retarget = vi.fn().mockResolvedValue({ success: true });
    const lifecycle = new ExtensionGuestBinding({ bind, retarget });
    lifecycle.ready(1);
    await lifecycle.aim(target);
    lifecycle.ready(2);
    expect(lifecycle.boundWebContentsId).toBeNull();
    await lifecycle.aim(target);
    expect(bind.mock.calls.map(([id]) => id)).toEqual([1, 2]);
    expect(retarget).not.toHaveBeenCalled();
  });

  it('orders retarget after the initial bind, without binding twice', async () => {
    const first = pending();
    const bind = vi.fn().mockReturnValue(first.promise);
    const retarget = vi.fn().mockResolvedValue({ success: true });
    const lifecycle = new ExtensionGuestBinding({ bind, retarget });
    lifecycle.ready(7);
    const initial = lifecycle.aim(target);
    await Promise.resolve();
    const moved = lifecycle.aim({ ...target, tabId: 'other' });
    expect(retarget).not.toHaveBeenCalled();
    first.resolve({ success: true });
    await Promise.all([initial, moved]);
    expect(bind).toHaveBeenCalledTimes(1);
    expect(retarget).toHaveBeenCalledExactlyOnceWith(7, { ...target, tabId: 'other' });
  });

  it('does not serialize different pages behind a pending page bind', async () => {
    const slow = pending();
    const first = new ExtensionGuestBinding({ bind: () => slow.promise, retarget: vi.fn() });
    const second = new ExtensionGuestBinding({ bind: vi.fn().mockResolvedValue({ success: true }), retarget: vi.fn() });
    first.ready(1);
    const delayed = first.aim(target);
    second.ready(2);
    await second.aim(target);
    expect(second.boundWebContentsId).toBe(2);
    expect(first.boundWebContentsId).toBeNull();
    slow.resolve({ success: true });
    await delayed;
  });
});
