import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * App 引用 pill, the desktop's half (148 17:21): a pill opens its file through the shell's one 「open a group file」 call
 * (`groupFileOpener`); when one App opens it, main tells that App the place right there — the `link` event a gugu link
 * brings, held for the page about to open (each open is a page of its own) — as `openExtensionLinkWith` opens and places.
 */

const userDataDir = mkdtempSync(join(tmpdir(), 'gugu-ext-pill-place-'));
vi.mock('electron', () => ({
  app: { getPath: () => userDataDir },
  ipcMain: { handle: () => undefined, on: () => undefined },
  webContents: { fromId: () => undefined },
}));
vi.mock('@main/lib/logger', () => ({ log: { error: vi.fn(), warn: vi.fn(), debug: vi.fn(), info: vi.fn() } }));

const office = { extensionId: 'office', tabKind: 'office.main', tabTitle: 'Office', app: { name: '咕咕办公' }, onlyTab: true, suffix: '.pptx' };
const board = { ...office, extensionId: 'board', tabKind: 'board.view', app: { name: 'Board' } };
const opener = vi.hoisted(() => ({ choice: null as unknown }));
vi.mock('./app-files', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  groupFile: async (chatId: string, itemId: string) => ({ chatId, itemId, name: 'deck.pptx', typedName: 'deck.pptx' }),
  openerChoice: () => opener.choice,
}));
const placed = vi.hoisted(() => ({ deliverToOpeningPage: vi.fn() }));
vi.mock('./extension-bridge', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  deliverToOpeningPage: placed.deliverToOpeningPage,
}));

const { extensionsController } = await import('./controller');

beforeEach(() => placed.deliverToOpeningPage.mockClear());

describe('a pill opens its file: the App that opens it is told the place (App 引用 pill)', () => {
  it('one App opens it: that App, in that chat, gets the place as a link event for the page about to open', async () => {
    opener.choice = { kind: 'one', candidate: office };
    const answer = await extensionsController.groupFileOpener({ chatId: 'chat-1', itemId: 'item-1', at: { slide: '3', shape: '12', k: '2' } });
    expect(answer).toMatchObject({ success: true, data: { choice: { kind: 'one' } } });
    expect(placed.deliverToOpeningPage).toHaveBeenCalledWith(
      'office',
      // `file`: the file the place is in (#7257), so the page that gets it can tell it is its file's.
      { type: 'link', tab: 'main', path: '', query: { slide: '3', shape: '12', k: '2' }, file: 'item-1' },
      { chat: 'chat-1' },
      // The file it is for: only a page of that file takes it (复核 71c15165 要改 1).
      'item-1',
    );
  });

  it('control: a plain link (no place) tells no App; several to choose from — the person picks — tells none either', async () => {
    opener.choice = { kind: 'one', candidate: office };
    await extensionsController.groupFileOpener({ chatId: 'chat-1', itemId: 'item-1' });
    opener.choice = { kind: 'choose', suffix: '.pptx', candidates: [office, board] };
    await extensionsController.groupFileOpener({ chatId: 'chat-1', itemId: 'item-1', at: { slide: '3' } });
    expect(placed.deliverToOpeningPage).not.toHaveBeenCalled();
  });
});
