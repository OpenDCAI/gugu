import { beforeEach, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  path: '',
  persist: vi.fn(),
  toast: vi.fn(),
}));

vi.mock('@renderer/lib/ipc', () => ({ rpc: { pty: { persistDroppedBlob: mocks.persist } } }));
vi.mock('@renderer/lib/hooks/use-toast', () => ({ toast: mocks.toast }));
vi.mock('@renderer/localization/locale-store', () => ({
  translateSessionMessage: (key: string, values: Record<string, unknown>) => `${key}:${String(values.name)}`,
}));
vi.mock('../electron-api', () => ({ electronApi: () => ({ getPathForFile: () => mocks.path }) }));

const { resolveDroppedFile } = await import('./terminal-image-injection');

const shot = () => new File([new Uint8Array([1, 2, 3])], 'shot.png', { type: 'image/png' });

beforeEach(() => {
  mocks.path = '';
  mocks.persist.mockReset();
  mocks.toast.mockReset();
});

it('hands the terminal the person’s own file as it is', async () => {
  mocks.path = '/Users/me/Desktop/shot.png';
  expect(await resolveDroppedFile(shot())).toBe('/Users/me/Desktop/shot.png');
  expect(mocks.persist).not.toHaveBeenCalled();
});

// #985:别的 App 私有目录里的文件，agent 之后去读会让 macOS 弹授权框;终端里敲的是咕咕自己存的那一份。
it('keeps a copy of a file from another app’s container and hands the terminal the copy', async () => {
  mocks.path = '/Users/me/Library/Containers/com.wiheads.paste/Data/tmp/images/shot.png';
  mocks.persist.mockResolvedValue({ success: true, data: { path: '/var/folders/xx/T/gugu-drop-1-shot.png' } });
  expect(await resolveDroppedFile(shot())).toBe('/var/folders/xx/T/gugu-drop-1-shot.png');
  expect(mocks.persist).toHaveBeenCalledWith(expect.objectContaining({ name: 'shot.png', mimeType: 'image/png' }));
  expect(mocks.toast).not.toHaveBeenCalled();
});

it('hands a dropped folder over by its path, wherever it is, because it has no bytes to copy', async () => {
  mocks.path = '/tmp/repro';
  expect(await resolveDroppedFile(new File([], 'repro'), true)).toBe('/tmp/repro');
  expect(mocks.persist).not.toHaveBeenCalled();
  expect(mocks.toast).not.toHaveBeenCalled();
});

it('says so on the spot when the copy cannot be kept, instead of falling back to the original path', async () => {
  mocks.path = '/Users/me/Library/Containers/com.wiheads.paste/Data/tmp/images/shot.png';
  mocks.persist.mockResolvedValue({ success: false, error: { message: 'disk full' } });
  expect(await resolveDroppedFile(shot())).toBeNull();
  expect(mocks.toast).toHaveBeenCalledWith(expect.objectContaining({ title: 'terminal.fileCopyFailed:shot.png', tier: 'error' }));
});
