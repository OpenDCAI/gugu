import { describe, expect, it, vi } from 'vitest';
import { registerRPCRouter } from '@shared/lib/ipc/rpc';

const clipboardWriteText = vi.hoisted(() => vi.fn());
vi.mock('./service', () => ({ appService: { clipboardWriteText } }));
vi.mock('@main/core/app/session-home-dir', () => ({ legacySessionHomeDir: vi.fn(), migrateLegacySessionHome: vi.fn(), sessionHomeDir: vi.fn() }));
vi.mock('@main/lib/file-logger', () => ({ getDiagnosticLogAttachment: vi.fn() }));
vi.mock('@main/lib/logger', () => ({ log: {} }));
vi.mock('../projects/utils', () => ({ resolveWorkspace: vi.fn() }));
vi.mock('./remote-downloads', () => ({ createRemoteDownloads: vi.fn() }));
vi.mock('./user-library', () => ({ readUserLibrary: vi.fn(), readUserLibraryEntry: vi.fn(), readUserLibraryVolume: vi.fn(), writeUserLibraryEntry: vi.fn() }));
vi.mock('./assistant-app', () => ({ callAssistantApp: vi.fn() }));

import { appController } from './controller';

describe('clipboard RPC failure contract', () => {
  it('rejects the renderer request when the native clipboard rejects', async () => {
    const cause = new Error('Clipboard write permission denied');
    clipboardWriteText.mockRejectedValueOnce(cause);
    const handlers = new Map<string, (event: { sender: { id: number } }, ...args: unknown[]) => unknown>();
    registerRPCRouter({ app: appController }, { handle: (channel, handler) => { handlers.set(channel, handler); } });

    await expect(handlers.get('app.clipboardWriteText')!({ sender: { id: 1 } }, 'file contents')).rejects.toBe(cause);
    expect(clipboardWriteText).toHaveBeenCalledWith('file contents');
  });
});
