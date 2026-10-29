// A chat's strip on the task's tab engine (owner 10-25: the two sides aligned at the bottom): the chat first, what is open
// beside it as tabs (owner 10-24: no floor under them, one App's one resource is one tab, how it was opened only decides
// its 上一页), paired with the chat as a task's file with its conversation (spec session-page「并排」).
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import type { ExtensionManifest } from '@shared/extensions/manifest';
import { folderItem, type PanelItem } from './chat-panel-item';
import {
  askChat,
  chatAlone,
  chatBlockContentOf,
  chatLayoutOf,
  closeChatTab,
  closeTopicTab,
  focusedChatTab,
  hideTopicTab,
  openFileIds,
  openPanelItem,
  openTopicTab,
  panelFull,
  panelTabsOf,
  returnToOf,
  setPanelFull,
  showChatOnly,
  showChatTab,
  shownPanelTab,
  takeChatAsk,
  topicTabOf,
  updateFileNames,
} from './chat-layouts';
import { CHAT_TAB_KIND } from './chat-tab-providers';
import { tabFullscreen } from '../../tabs/tab-fullscreen';

const board: PanelItem = { kind: 'kanban.board', title: 'Board' };
const deck: PanelItem = { kind: 'slides.main', itemId: 'deck', typedName: 'deck.pptx', title: 'deck.pptx' };
const file = (id: string): PanelItem => ({ kind: 'workspace.main', itemId: id, title: `${id}.md`, fileName: `${id}.md` });
const kinds = (chatId: string) => panelTabsOf(chatId).map((tab) => tab.item.itemId ?? tab.item.kind);
const pane = (chatId: string) => chatLayoutOf(chatId).groups[0]!.pane;
const strip = (chatId: string) => pane(chatId).tabOrder.map((id) => pane(chatId).entries.get(id)!.kind);

describe('a chat has its own tab first, and nothing else until something is opened', () => {
  it('is the chat alone; its tab is never closed, and stays first', () => {
    expect(strip('alone-1')).toEqual([CHAT_TAB_KIND]);
    expect(chatAlone('alone-1')).toBe(true);
    const chatTab = pane('alone-1').tabOrder[0]!;
    pane('alone-1').requestCloseTab(chatTab);
    pane('alone-1').closeAll();
    expect(strip('alone-1')).toEqual([CHAT_TAB_KIND]);
    openPanelItem('alone-1', board);
    pane('alone-1').reorderTabs(1, 0);
    expect(strip('alone-1')[0], 'a drop before it puts it back first').toBe(CHAT_TAB_KIND);
  });
});

describe('opening beside the chat', () => {
  it('pairs with the chat; opening another takes the pair next to the chat (Chrome Swap), the one before stays a tab', () => {
    openPanelItem('beside-1', board);
    expect(chatAlone('beside-1')).toBe(false);
    expect(shownPanelTab('beside-1')?.item).toMatchObject(board);
    openPanelItem('beside-1', deck);
    expect(kinds('beside-1'), 'the pair sits together: the new one beside the chat, the one it replaced where the new one was').toEqual(['deck', 'kanban.board']);
    expect(shownPanelTab('beside-1')?.item.itemId).toBe('deck');
    expect(panelTabsOf('beside-1').find((tab) => tab.item.kind === 'kanban.board')?.shown).toBe(false);
  });

  it('the same App page opened again is the same tab', () => {
    const first = openPanelItem('beside-2', board);
    openPanelItem('beside-2', deck);
    const again = openPanelItem('beside-2', { ...board });
    expect(again).toBe(first);
    expect(kinds('beside-2')).toEqual(['kanban.board', 'deck']);
    expect(shownPanelTab('beside-2')?.tabId).toBe(first);
  });

  it("one App's one file is one tab through any of its tabs (owner 10-24); another App on it is another tab", () => {
    openPanelItem('beside-3', { kind: 'kanban.file', itemId: 'B', title: '协作看板' });
    openPanelItem('beside-3', { kind: 'kanban.board', itemId: 'B', title: '协作看板' });
    expect(panelTabsOf('beside-3')).toHaveLength(1);
    openPanelItem('beside-3', { kind: 'workspace.main', itemId: 'B', title: '协作看板.board' });
    expect(panelTabsOf('beside-3').map((tab) => tab.item.kind)).toEqual(['workspace.main', 'kanban.board']);
  });

  it('the folder is a tab only once it is opened, opened again it is the same one, and its × lets it go', () => {
    expect(panelTabsOf('beside-4')).toEqual([]);
    const folder = openPanelItem('beside-4', folderItem())!;
    openPanelItem('beside-4', board);
    expect(openPanelItem('beside-4', folderItem())).toBe(folder);
    expect(shownPanelTab('beside-4')?.tabId).toBe(folder);
    closeChatTab('beside-4', folder);
    expect(kinds('beside-4')).toEqual(['kanban.board']);
  });

  it('a tab picked is the one shown beside the chat; the chat picked keeps the pair (as a task conversation)', () => {
    const first = openPanelItem('beside-5', board)!;
    openPanelItem('beside-5', deck);
    showChatTab('beside-5', first);
    expect(shownPanelTab('beside-5')?.tabId).toBe(first);
    showChatOnly('beside-5');
    expect(focusedChatTab('beside-5')?.kind).toBe('chat');
    expect(chatAlone('beside-5'), 'focus moves to the chat, the pair stays').toBe(false);
  });
});

describe('leaving a tab', () => {
  it('a file opened from the folder goes back to the folder', () => {
    const folder = openPanelItem('exit-1', folderItem())!;
    const item = openPanelItem('exit-1', file('101'), { returnTo: folder })!;
    expect(returnToOf('exit-1', item)).toBe(folder);
    closeChatTab('exit-1', item);
    expect(shownPanelTab('exit-1')?.tabId).toBe(folder);
    expect(panelTabsOf('exit-1')).toHaveLength(1);
  });

  it('keeps its 上一页 after switching tabs, and does not revive one the person closed', () => {
    const app = openPanelItem('exit-2', board)!;
    const first = openPanelItem('exit-2', file('103'), { returnTo: app })!;
    const second = openPanelItem('exit-2', file('104'), { returnTo: first })!;
    showChatTab('exit-2', app);
    showChatTab('exit-2', second);
    closeChatTab('exit-2', second);
    expect(shownPanelTab('exit-2')?.tabId).toBe(first);
    closeChatTab('exit-2', app);
    expect(returnToOf('exit-2', first), 'its 上一页 is gone').toBeNull();
    closeChatTab('exit-2', first);
    expect(panelTabsOf('exit-2'), 'nothing beside the chat: it is alone').toEqual([]);
    expect(chatAlone('exit-2')).toBe(true);
  });

  it('closing hands back what it was opened from (a link\'s message), once', () => {
    const restore = vi.fn();
    const tab = openPanelItem('exit-3', file('107'), { restore })!;
    closeChatTab('exit-3', tab);
    expect(restore).toHaveBeenCalledTimes(1);
    expect(panelTabsOf('exit-3')).toEqual([]);
    const again = openPanelItem('exit-3', file('107'))!;
    closeChatTab('exit-3', again);
    expect(restore, 'a later open of the same file hands back nothing').toHaveBeenCalledTimes(1);
  });

  it('closing a tab not shown keeps the one shown', () => {
    const source = openPanelItem('exit-4', board)!;
    const shown = openPanelItem('exit-4', file('111'), { returnTo: source })!;
    closeChatTab('exit-4', source);
    expect(shownPanelTab('exit-4')?.tabId).toBe(shown);
  });
});

describe('filling the block (the old 「全屏」) is the pair separated', () => {
  it('fills the block, and back beside the chat', () => {
    const tab = openPanelItem('full-1', board)!;
    expect(panelFull('full-1', tab)).toBe(false);
    setPanelFull('full-1', tab, true);
    expect(panelFull('full-1', tab)).toBe(true);
    setPanelFull('full-1', tab, false);
    expect(panelFull('full-1', tab)).toBe(false);
    expect(chatAlone('full-1')).toBe(false);
  });

  it.each([false, true])('fullscreen preserves whether the panel is separated (separated=%s)', (separated) => {
    const chatId = `full-pair-projection-${separated}`;
    const tab = openPanelItem(chatId, board)!;
    if (separated) setPanelFull(chatId, tab, true);
    const host = pane(chatId);
    const saved = JSON.stringify(chatLayoutOf(chatId).snapshot);
    const pair = host.livePair && { ...host.livePair };
    try {
      host.tabFill(tab)!.toggle();
      expect(tabFullscreen.isOn(host, tab)).toBe(true);
      expect(host.shownTabIds).toEqual([tab]);
      expect(panelFull(chatId, tab)).toBe(separated);
      expect(host.livePair).toEqual(pair);
      expect(JSON.stringify(chatLayoutOf(chatId).snapshot)).toBe(saved);
    } finally {
      tabFullscreen.exit();
    }
    expect(panelFull(chatId, tab)).toBe(separated);
    expect(JSON.stringify(chatLayoutOf(chatId).snapshot)).toBe(saved);
  });

  it('keeps an intact pair when the block temporarily fits only one page', () => {
    const chatId = 'full-pair-narrow';
    const tab = openPanelItem(chatId, board)!;
    const host = pane(chatId);
    const saved = JSON.stringify(chatLayoutOf(chatId).snapshot);
    host.setDimensions(200, 900);
    expect(host.shownTabIds).toEqual([tab]);
    expect(panelFull(chatId, tab)).toBe(false);
    host.setDimensions(1600, 900);
    expect(host.shownTabIds).toHaveLength(2);
    expect(JSON.stringify(chatLayoutOf(chatId).snapshot)).toBe(saved);
  });
});

describe('the topic beside its group', () => {
  it('is a tab paired with the group; another topic takes its place; its × lets it go, the panels stay', () => {
    openPanelItem('topic-1', board);
    openTopicTab('topic-1', { topicChatId: 'topic-a', name: 'A' });
    expect(topicTabOf('topic-1')).toMatchObject({ topic: { topicChatId: 'topic-a', name: 'A' }, shown: true });
    expect(panelTabsOf('topic-1')[0]?.shown, 'the panel tab gave the pair to the topic').toBe(false);
    openTopicTab('topic-1', { topicChatId: 'topic-b', name: 'B' });
    expect(topicTabOf('topic-1')?.topic.topicChatId).toBe('topic-b');
    expect(strip('topic-1').filter((kind) => kind === 'chat-topic')).toHaveLength(1);
    closeTopicTab('topic-1');
    expect(topicTabOf('topic-1')).toBeNull();
    openTopicTab('topic-1', { topicChatId: 'topic-c', name: 'C' });
    hideTopicTab('topic-1');
    expect(topicTabOf('topic-1'), 'put away (its row clicked again): off the screen and the strip').toBeNull();
    expect(kinds('topic-1')).toEqual(['kanban.board']);
  });
});

describe('renamed files already open', () => {
  const installed: ExtensionManifest[] = [JSON.parse(readFileSync(resolve('apps/desktop/preinstalled-apps/workspace/manifest.json'), 'utf8'))];

  it('updates every chat having it open, keeping the tab, its 上一页 and the one shown', () => {
    const folder = openPanelItem('rename-source', folderItem())!;
    const tab = openPanelItem('rename-source', { ...file('rename-file'), title: 'old', fileName: 'old.md', typedName: 'old.md' }, { returnTo: folder })!;
    openPanelItem('rename-topic', { ...file('rename-file'), title: 'old', fileName: 'old.md' });
    expect(openFileIds().has('rename-file')).toBe(true);
    updateFileNames([{ id: 'rename-file', filename: 'new.md', content_type: 'text/markdown' }], installed);
    const renamed = panelTabsOf('rename-source').find((candidate) => candidate.tabId === tab)!;
    expect(renamed.item).toMatchObject({ itemId: 'rename-file', title: 'new', fileName: 'new.md', typedName: 'new.md' });
    expect(returnToOf('rename-source', tab)).toBe(folder);
    expect(shownPanelTab('rename-source')?.tabId).toBe(tab);
    expect(panelTabsOf('rename-topic')[0]?.item.title).toBe('new');
  });

  it('does not revive a closed file when a metadata read finishes afterwards', () => {
    const tab = openPanelItem('rename-closed', file('closed-rename'))!;
    closeChatTab('rename-closed', tab);
    expect(openFileIds().has('closed-rename')).toBe(false);
    updateFileNames([{ id: 'closed-rename', filename: 'new.md', content_type: 'text/markdown' }], installed);
    expect(panelTabsOf('rename-closed')).toEqual([]);
  });
});

describe('a tab of its own: a block, a window', () => {
  it('an App tab is a block of its own (that chat\'s page, or its file\'s); the host\'s preview is not', () => {
    const page = openPanelItem('own-1', board)!;
    const doc = openPanelItem('own-1', deck)!;
    const preview = openPanelItem('own-1', { kind: null, itemId: 'raw', title: 'raw.bin' })!;
    expect(chatBlockContentOf('own-1', page)).toEqual({ kind: 'chat-app', chatId: 'own-1', tabKind: 'kanban.board', title: 'Board' });
    expect(chatBlockContentOf('own-1', doc)).toEqual({ kind: 'chat-app', chatId: 'own-1', tabKind: 'slides.main', title: 'deck.pptx', itemId: 'deck' });
    expect(chatBlockContentOf('own-1', preview)).toBeNull();
  });

  it('in a window it is still the chat\'s: listed there, shown, closed from there', () => {
    const tab = openPanelItem('window-1', board)!;
    const windowPane = chatLayoutOf('window-1').detachToWindow(tab);
    expect(windowPane).not.toBeNull();
    expect(panelTabsOf('window-1')).toMatchObject([{ tabId: tab, shown: true, inWindow: true }]);
    expect(chatAlone('window-1')).toBe(true);
    closeChatTab('window-1', tab);
    expect(panelTabsOf('window-1')).toEqual([]);
  });
});

describe('asking a chat', () => {
  it('one channel for Apps and files: the last ask is taken once', () => {
    askChat('ask-1', { app: 'kanban' });
    askChat('ask-1', { itemId: 'F1', at: { slide: '3' } });
    expect(takeChatAsk('ask-1')).toEqual({ itemId: 'F1', at: { slide: '3' } });
    expect(takeChatAsk('ask-1')).toBeNull();
  });
});
