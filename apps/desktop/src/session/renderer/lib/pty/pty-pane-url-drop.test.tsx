// @vitest-environment jsdom
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PasteFromClipboardHandler } from './use-pty';
import { PtyPane, type RemoteTerminalFiles } from './pty-pane';

const io = vi.hoisted(() => ({ focus: vi.fn(), sendInput: vi.fn() }));
let clipboardPaste: PasteFromClipboardHandler | undefined;
vi.mock('./use-pty', () => ({ usePty: (options: { onPasteFromClipboard?: PasteFromClipboardHandler }) => {
  clipboardPaste = options.onPasteFromClipboard;
  return io;
} }));
vi.mock('./pane-sizing-context', () => ({ usePaneSizingContext: () => ({}), PaneSizingContextProvider: ({ children }: { children: React.ReactNode }) => children }));
vi.mock('@renderer/lib/ipc', () => ({ rpc: { pty: { persistClipboardImage: vi.fn() } } }));
vi.mock('@renderer/lib/chat/local-session-mention-provider', () => ({ createLocalSessionMentionProvider: vi.fn() }));

let root: Root;
let host: HTMLDivElement;
const link = 'gugu-file://123e4567-e89b-42d3-a456-426614174000';
beforeEach(() => {
  vi.clearAllMocks(); clipboardPaste = undefined;
  host = document.createElement('div'); document.body.append(host); root = createRoot(host);
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { readText: async () => link } });
});
afterEach(async () => { await act(async () => root.unmount()); host.remove(); });

async function mount(localPaths: boolean, remoteFiles?: RemoteTerminalFiles) {
  await act(async () => root.render(<PtyPane ptySessionId="pty-url-drop" pty={null!} workspaceId="w" localPaths={localPaths} remoteFiles={remoteFiles} />));
}
function drop(files: File[] = []) {
  const event = new Event('drop', { bubbles: true, cancelable: true });
  Object.defineProperty(event, 'dataTransfer', { value: { files, getData: (type: string) => ['text/plain', 'text/uri-list'].includes(type) ? link : '' } });
  host.querySelector('[data-terminal-container]')!.dispatchEvent(event);
}

describe('terminal resource URL drop', () => {
  it.each([true, false])('writes exactly the existing text paste with localPaths=%s', async (localPaths) => {
    await mount(localPaths);
    await act(async () => drop());
    expect(io.sendInput).toHaveBeenCalledExactlyOnceWith(link);
    io.sendInput.mockClear();
    await act(async () => { clipboardPaste?.(io); });
    await vi.waitFor(() => expect(io.sendInput).toHaveBeenCalledExactlyOnceWith(link));
  });

  it('keeps an operating-system file on the upload path when it also has a URI', async () => {
    const upload = vi.fn(async () => []);
    await mount(false, { platform: 'darwin', upload });
    const file = new File(['image'], 'image.png', { type: 'image/png' });
    await act(async () => drop([file]));
    expect(upload).toHaveBeenCalledExactlyOnceWith([file]);
    expect(io.sendInput).not.toHaveBeenCalled();
  });
});
