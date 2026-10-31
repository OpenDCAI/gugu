import { describe, expect, it } from 'vitest';
import { screenLayout } from '@renderer/app/screen-layout';
import { showGroupParticipant } from '@renderer/features/chats/group-participant-actions';
import { groupParticipantPanes } from '@renderer/features/chats/group-participant-panes';
import { chatLayoutOf, openPanelItem, openTopicTab, panelTabsOf, showChatTab, topicTabOf, yieldChatAuxiliary } from '@renderer/features/chats/chat-tabs/chat-layouts';
const board = { kind: 'kanban.board', title: 'Board' };
const pane = (chatId: string) => chatLayoutOf(chatId).groups[0]!.pane;

describe('participant and topic share the one auxiliary place', () => {
  it('retains the topic tab and restores it beside the group, with no third column', () => {
    const chatId = 'participant-topic';
    screenLayout.show({ kind: 'chat', chatId });
    openTopicTab(chatId, { topicChatId: 'topic', name: 'Topic' });
    const topicId = topicTabOf(chatId)!.tabId;
    showGroupParticipant(chatId, { kind: 'session', projectId: 'p', sessionId: 'participant-a' });
    expect(screenLayout.order).toHaveLength(2);
    expect(pane(chatId).shownTabIds).toEqual([pane(chatId).tabOrder[0]]);
    expect(topicTabOf(chatId)).toMatchObject({ tabId: topicId, shown: false });
    showChatTab(chatId, topicId);
    expect(screenLayout.order).toHaveLength(1);
    expect(topicTabOf(chatId)).toMatchObject({ tabId: topicId, shown: true });
    expect(pane(chatId).shownTabIds).toHaveLength(2);
    expect(groupParticipantPanes.placements.has(chatId)).toBe(false);
  });

  it('lets a folder/App take the same place without closing any retained tab', () => {
    const chatId = 'participant-folder';
    screenLayout.show({ kind: 'chat', chatId });
    openPanelItem(chatId, board);
    const tab = panelTabsOf(chatId)[0]!.tabId;
    yieldChatAuxiliary(chatId);
    showGroupParticipant(chatId, { kind: 'session', projectId: 'p', sessionId: 'participant-b' });
    showChatTab(chatId, tab);
    expect(screenLayout.order).toHaveLength(1);
    expect(panelTabsOf(chatId)).toMatchObject([{ tabId: tab, shown: true }]);
    expect(pane(chatId).shownTabIds).toHaveLength(2);
  });
});

