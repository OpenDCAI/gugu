import { beforeEach, describe, expect, it, vi } from 'vitest';
import { copyPrUrl } from './pr-url-copy';

const mocks = vi.hoisted(() => ({
  clipboardWriteText: vi.fn(),
  toast: vi.fn(),
}));

vi.mock('@renderer/lib/hooks/use-toast', () => ({
  toast: mocks.toast,
}));

vi.mock('@renderer/lib/ipc', () => ({
  rpc: {
    app: {
      clipboardWriteText: mocks.clipboardWriteText,
    },
  },
}));

describe('copyPrUrl', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.clipboardWriteText.mockResolvedValue({ success: true });
  });

  it('copies the PR URL through the app clipboard service and reports success', async () => {
    await expect(copyPrUrl('https://github.com/example/repo/pull/123')).resolves.toBe(true);

    expect(mocks.clipboardWriteText).toHaveBeenCalledWith(
      'https://github.com/example/repo/pull/123'
    );
    expect(mocks.toast).toHaveBeenCalledWith({ title: 'PR URL copied' });
  });

  it('reports when the clipboard request rejects', async () => {
    mocks.clipboardWriteText.mockRejectedValue(new Error('IPC unavailable'));

    await expect(copyPrUrl('https://github.com/example/repo/pull/123')).resolves.toBe(false);

    expect(mocks.toast).toHaveBeenCalledWith({
      title: 'IPC unavailable',
      variant: 'destructive',
    });
  });
});
