// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { folderItem, type PanelItem } from './chat-panel-item';
import { askChat, chatAlone, chatBlockContentOf, chatLayoutOf, chatPaneOf, closeChatTab, closeInfoTab, closeTopicTab, focusedChatTab, infoTabOf, memberTopicOf, openInfoTab, openPanelItem, openTopicTab, panelFull, panelTabsOf, setPanelFull, showChatOnly, showChatTab, takeChatAsk, topicTabOf, updateFileNames } from './chat-layouts';
import { CHAT_INFO_TAB_KIND, CHAT_TAB_KIND } from './chat-tab-providers';
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
  it('opens from the conversation side by side in the one strip; the next one takes the side, closing it brings A back', () => {
    const id = 'pair-chat'; const layout = chatLayoutOf(id);
    const chat = layout.focusedPane.resolvedActiveTabId!;
    const first = openPanelItem(id, file('A'))!;
    expect(layout.pair).toEqual({ pinned: chat, side: first });
    const second = openPanelItem(id, file('B'))!;
    expect(layout.pair).toEqual({ pinned: chat, side: second });
    expect(layout.groups).toHaveLength(2);
    expect(layout.stripTabIds).toEqual([chat, second, first]);
    closeChatTab(id, second);
    expect(layout.pair).toEqual({ pinned: chat, side: first });
    closeChatTab(id, first);
    expect(layout.groups).toHaveLength(1);
  });
  it('explicit new-tab intent leaves the source content unchanged', () => {
    const id = 'explicit-chat'; const folder = openPanelItem(id, folderItem())!;
    const first = openPanelItem(id, file('README'), { from: folder, intent: 'newTab' })!;
    expect(first).not.toBe(folder);
    expect(panelTabsOf(id).find((tab) => tab.tabId === folder)?.item.itemId).toBeUndefined();
    expect(chatLayoutOf(id).groups.flatMap(({ pane }) => pane.tabOrder)).toEqual(expect.arrayContaining([folder, first]));
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
  it('a topic pairs with its group in the group strip; another topic takes its place; closing it leaves the group', () => {
    const id = 'topic-chat'; const layout = chatLayoutOf(id);
    const chat = layout.focusedPane.resolvedActiveTabId!;
    openTopicTab(id, { topicChatId: 'topic-a', name: 'A' });
    const first = topicTabOf(id)!.tabId;
    expect(layout.pair).toEqual({ pinned: chat, side: first });
    openTopicTab(id, { topicChatId: 'topic-b', name: 'B' });
    expect(topicTabOf(id)?.tabId).toBe(first);
    expect(chatPaneOf(id, first)?.navigationOf(first)?.pages).toHaveLength(2);
    closeTopicTab(id);
    expect(layout.groups).toHaveLength(1);
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
  it('the members context follows the focused topic, its information page, and the source chat', () => {
    const id = 'topic-members-focus';
    const topic = { topicChatId: 'topic-members', name: 'Topic' };
    openTopicTab(id, topic);
    const topicTab = topicTabOf(id)!.tabId;
    expect(memberTopicOf(id)).toEqual(topic);
    openInfoTab(id, 'members', memberTopicOf(id));
    expect(infoTabOf(id)?.info.topic).toEqual(topic);
    expect(memberTopicOf(id)).toEqual(topic);
    showChatTab(id, topicTab);
    expect(memberTopicOf(id)).toEqual(topic);
    showChatOnly(id);
    expect(memberTopicOf(id)).toBeNull();
    openInfoTab(id);
    expect(infoTabOf(id)?.info.topic).toBeUndefined();
    expect(memberTopicOf(id)).toBeNull();
  });
  it('does not restore a topic members page without its runtime-only topic tab', () => {
    const id = 'topic-members-persistence';
    const topic = { topicChatId: 'transient-topic-id', name: 'Transient topic' };
    openTopicTab(id, topic);
    openInfoTab(id, 'members', topic);
    expect(JSON.stringify(chatLayoutOf(id).snapshot)).not.toContain(topic.topicChatId);
    showChatOnly(id);
    openInfoTab(id, 'members');
    expect(chatLayoutOf(id).snapshot.groups.flatMap((group) => group.tabManager.tabs).some((tab) => tab.kind === 'extension' && tab.extensionKind === CHAT_INFO_TAB_KIND)).toBe(true);
  });
  it('reuses the information tab when switching from source members to topic members', () => {
    const id = 'topic-members-switch';
    openInfoTab(id, 'members');
    const infoTab = infoTabOf(id)!.tabId;
    openTopicTab(id, { topicChatId: 'topic-members-switch', name: 'Topic' });
    openInfoTab(id, 'members', memberTopicOf(id));
    expect(infoTabOf(id)?.tabId).toBe(infoTab);
    expect(infoTabOf(id)?.info.topic?.topicChatId).toBe('topic-members-switch');
    expect(infoTabOf(id)?.shown).toBe(true);
  });
  it('closing topic members restores the topic on a phone-sized page', () => {
    const id = 'topic-members-phone';
    chatLayoutOf(id).focusedPane.setDimensions(390, 620);
    openTopicTab(id, { topicChatId: 'topic-members-phone', name: 'Topic' });
    const topicTab = topicTabOf(id)!.tabId;
    openInfoTab(id, 'members', memberTopicOf(id));
    closeInfoTab(id);
    expect(focusedChatTab(id)).toEqual({ tabId: topicTab, kind: 'topic' });
    expect(infoTabOf(id)).toBeNull();
  });
  it('each chat receives only its latest ask once', () => {
    askChat('asked', { app: 'workspace' }); askChat('asked', { itemId: 'README', from: 'origin' });
    expect(takeChatAsk('asked')).toEqual({ itemId: 'README', from: 'origin' });
    expect(takeChatAsk('asked')).toBeNull();
  });
});
