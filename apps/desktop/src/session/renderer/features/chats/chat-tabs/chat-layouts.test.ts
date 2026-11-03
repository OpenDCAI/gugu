import { describe, expect, it } from 'vitest';
import { folderItem, type PanelItem } from './chat-panel-item';
import { askChat, chatAlone, chatBlockContentOf, chatLayoutOf, chatPaneOf, closeChatTab, closeTopicTab, focusedChatTab, openPanelItem, openTopicTab, panelFull, panelTabsOf, setPanelFull, showChatOnly, showChatTab, takeChatAsk, topicTabOf, updateFileNames } from './chat-layouts';
import { CHAT_TAB_KIND } from './chat-tab-providers';
import { tabFullscreen } from '../../tabs/tab-fullscreen';

const file = (id: string): PanelItem => ({ kind: 'workspace.main', itemId: id, title: `${id}.md`, fileName: `${id}.md` });
const board: PanelItem = { kind: 'kanban.board', title: 'Board' };
const count = (id: string) => chatLayoutOf(id).groups.reduce((sum, { pane }) => sum + pane.tabOrder.length, 0);

describe('chat navigation uses the same page history and real panes as tasks', () => {
  it.each(['dm', 'group'])('keeps the folder context and real layout while browsing in %s', (kind) => {
    const id = `history-${kind}`;
    const layout = chatLayoutOf(id);
    const chat = layout.focusedPane.resolvedActiveTabId!;
    const folder = openPanelItem(id, folderItem(), { from: chat, intent: 'newTab' })!;
    const before = JSON.stringify(layout.layout);
    const pane = chatPaneOf(id, folder)!;
    pane.setPageViewState(folder, { scrollTop: 315, picked: ['config'] });
    expect(openPanelItem(id, file('README'), { from: folder })).toBe(folder);
    expect(count(id)).toBe(2);
    expect(JSON.stringify(layout.layout)).toBe(before);
    expect(panelTabsOf(id).find((tab) => tab.tabId === folder)?.item.itemId).toBe('README');
    pane.go(folder, -1);
    expect(pane.navigationOf(folder)?.pages[0].viewState).toEqual({ scrollTop: 315, picked: ['config'] });
    pane.go(folder, 1);
    expect(panelTabsOf(id).find((tab) => tab.tabId === folder)?.item.itemId).toBe('README');
  });
  it('repeated ordinary private file cards focus one existing tab in a narrow pane', () => {
    const id = 'private-repeat-card'; const layout = chatLayoutOf(id);
    layout.focusedPane.setDimensions(390, 620);
    const conversation = layout.focusedPane.resolvedActiveTabId!;
    const first = openPanelItem(id, file('same-file'))!;
    const order = [...layout.focusedPane.tabOrder];
    showChatOnly(id);
    expect(openPanelItem(id, file('same-file'))).toBe(first);
    expect(layout.focusedPane.resolvedActiveTabId).toBe(first);
    expect(layout.focusedPane.tabOrder).toEqual(order);
    // Explicit new-tab remains an explicit request, and another conversation is isolated.
    expect(openPanelItem(id, file('same-file'), { intent: 'newTab', from: conversation })).not.toBe(first);
    expect(openPanelItem('another-private-repeat-card', file('same-file'))).not.toBe(first);
  });
  it('opens from the conversation into one reusable actual companion', () => {
    const id = 'companion-chat'; const layout = chatLayoutOf(id);
    const chat = layout.focusedPane.resolvedActiveTabId!;
    const first = openPanelItem(id, file('A'))!;
    const companion = layout.activePaneId;
    expect(layout.groups).toHaveLength(2);
    expect(openPanelItem(id, file('B'))).toBe(first);
    expect(layout.activePaneId).toBe(companion);
    expect(layout.groups[0].pane.entries.get(chat)?.companionPaneId).toBe(companion);
    closeChatTab(id, first);
    expect(layout.groups).toHaveLength(1);
    expect(layout.focusedPane.entries.get(chat)?.companionPaneId).toBeUndefined();
  });
  it('explicit new-tab intent leaves the source content unchanged', () => {
    const id = 'explicit-chat'; const folder = openPanelItem(id, folderItem())!;
    const first = openPanelItem(id, file('README'), { from: folder, intent: 'newTab' })!;
    expect(first).not.toBe(folder);
    expect(panelTabsOf(id).find((tab) => tab.tabId === folder)?.item.itemId).toBeUndefined();
    expect(chatPaneOf(id, first)?.tabOrder.indexOf(first)).toBe(chatPaneOf(id, folder)!.tabOrder.indexOf(folder) + 1);
  });
  it('closing an inactive page does not change the focused page; closing restores a link once', () => {
    const id = 'close-chat'; let restored = 0;
    const first = openPanelItem(id, board, { restore: () => restored++ })!;
    const next = openPanelItem(id, file('README'), { from: first, intent: 'newTab' })!;
    closeChatTab(id, first);
    expect(focusedChatTab(id)?.tabId).toBe(next);
    closeChatTab(id, first);
    expect(restored).toBe(1);
  });
  it('showing the conversation and fullscreen leave its companion tree intact', () => {
    const id = 'visibility-chat'; const layout = chatLayoutOf(id); const page = openPanelItem(id, board)!;
    const before = JSON.stringify(layout.layout);
    setPanelFull(id, page, true); expect(panelFull(id, page)).toBe(true);
    setPanelFull(id, page, false); expect(tabFullscreen.target).toBeNull();
    showChatOnly(id); expect(focusedChatTab(id)?.kind).toBe('chat');
    showChatTab(id, page); expect(focusedChatTab(id)?.kind).toBe('panel');
    expect(JSON.stringify(layout.layout)).toBe(before);
    expect(chatAlone(id)).toBe(false);
  });
  it('a topic navigates the companion and closing it leaves the source group', () => {
    const id = 'topic-chat'; const layout = chatLayoutOf(id);
    openTopicTab(id, { topicChatId: 'topic-a', name: 'A' });
    const first = topicTabOf(id)!.tabId;
    openTopicTab(id, { topicChatId: 'topic-b', name: 'B' });
    expect(topicTabOf(id)?.tabId).toBe(first);
    expect(chatPaneOf(id, first)?.navigationOf(first)?.pages).toHaveLength(2);
    closeTopicTab(id);
    expect(layout.groups.some(({ pane }) => pane.entriesOfKind(CHAT_TAB_KIND).length > 0)).toBe(true);
  });
  it('a file name refresh keeps the same context and does not revive a closed tab', () => {
    const id = 'rename-chat'; const page = openPanelItem(id, file('README'))!;
    updateFileNames([{ id: 'README', filename: 'renamed.md', content_type: 'text/markdown' }], []);
    expect(panelTabsOf(id).find((tab) => tab.tabId === page)?.item.fileName).toBe('renamed.md');
    expect(chatBlockContentOf(id, page)?.itemId).toBe('README');
    closeChatTab(id, page);
    updateFileNames([{ id: 'README', filename: 'later.md', content_type: 'text/markdown' }], []);
    expect(panelTabsOf(id)).toEqual([]);
  });
  it('each chat receives only its latest ask once', () => {
    askChat('asked', { app: 'workspace' }); askChat('asked', { itemId: 'README', from: 'origin' });
    expect(takeChatAsk('asked')).toEqual({ itemId: 'README', from: 'origin' });
    expect(takeChatAsk('asked')).toBeNull();
  });
});
