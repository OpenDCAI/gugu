// A chat's strip on the task's tab engine (owner 10-25: the two sides aligned at the bottom): the chat first, what is open
// beside it as tabs (owner 10-24: no floor under them, one App's one resource is one tab, how it was opened only decides
// its 上一页), paired with the chat as a task's file with its conversation (spec session-page「并排」).
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import type { ExtensionManifest } from '@shared/extensions/manifest';
import type { MessageItem } from '@gugu/core/shared/types/chat';
import { folderItem, type PanelItem } from './chat-panel-item';
import {
  askChat,
  chatTabView,
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
import { CHAT_TAB_KIND, CHAT_PANEL_TAB_KIND } from './chat-tab-providers';
import { tabFullscreen } from '../../tabs/tab-fullscreen';
import { groupParticipantPanes } from '../group-participant-panes';
import { runInAction } from 'mobx';

const board: PanelItem = { kind: 'kanban.board', title: 'Board' };
const deck: PanelItem = { kind: 'slides.main', itemId: 'deck', typedName: 'deck.pptx', title: 'deck.pptx' };
const file = (id: string): PanelItem => ({ kind: 'workspace.file', itemId: id, title: `${id}.md`, fileName: `${id}.md` });
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
    openPanelItem('beside-3', { kind: 'workspace.file', itemId: 'B', title: '协作看板.board' });
    expect(panelTabsOf('beside-3').map((tab) => tab.item.kind)).toEqual(['workspace.file', 'kanban.board']);
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

// The layout invariants (S1–S10 are the scenarios they answer):
// 1. Rank sets left and right: the group < a topic < content (file, App, info); a pair the person arranged keeps it.
// 2. Content opens beside the conversation it came from: its message's, else the one focused (a link), else the group.
// 3. At most two halves; fullscreen, a narrow block and yielding to a participant change only what is drawn.
// 4. Closing a half goes back to before it opened: its 上一页, else its source conversation as rule 1–2 place it.
// 5. Only the person's gestures write preferences (separate → that kind stops pairing; a manual side is kept).
describe('layout scenarios', () => {
  const from = (id: string, chatId: string): PanelItem => ({ ...file(id), message: { id: `message-${chatId}`, chat_id: chatId } as MessageItem });
  const withTopic = (id: string) => {
    openTopicTab(id, { topicChatId: `${id}-topic`, name: 'Topic' });
    return { main: pane(id).tabOrder[0]!, topic: topicTabOf(id)!.tabId };
  };
  const snapshot = (id: string) => JSON.stringify(chatLayoutOf(id).snapshot);

  it('S1 the group opens a file: the group left, the file right', () => {
    const tab = openPanelItem('s1', from('a', 's1'))!;
    expect(pane('s1').shownTabIds).toEqual([pane('s1').tabOrder[0], tab]);
    expect(returnToOf('s1', tab), 'what the group opens beside itself has no 上一页 (owner 10-24)').toBeNull();
  });

  it('S2 a topic opens a file (attachment or link): the topic left, the file right; the group stays a tab', () => {
    const { main, topic } = withTopic('s2');
    expect(pane('s2').shownTabIds).toEqual([main, topic]);
    const attachment = openPanelItem('s2', from('a', 's2-topic'))!;
    expect(pane('s2').shownTabIds).toEqual([topic, attachment]);
    expect(pane('s2').tabOrder[0]).toBe(main);
    pane('s2').setActiveTab(topic);
    const link = openPanelItem('s2', file('linked'))!;
    expect(pane('s2').shownTabIds, 'a link carries no message: the topic it was clicked in').toEqual([topic, link]);
  });

  it('S3 another topic takes the topic\'s place; a file of the one gone opens beside the group', () => {
    withTopic('s3');
    openTopicTab('s3', { topicChatId: 's3-other', name: 'Other' });
    expect(strip('s3').filter((kind) => kind === 'chat-topic')).toHaveLength(1);
    const tab = openPanelItem('s3', from('a', 's3-topic'))!;
    expect(pane('s3').shownTabIds).toEqual([pane('s3').tabOrder[0], tab]);
    const other = topicTabOf('s3')!.tabId;
    expect(openPanelItem('s3', from('a', 's3-other'))).toBe(tab);
    expect(pane('s3').shownTabIds, 'the same file, now from the open topic: beside it').toEqual([other, tab]);
  });

  it('S4 fullscreen and filling the block change only what is drawn: out of it, the same pair, sides and save', () => {
    const { topic } = withTopic('s4');
    const tab = openPanelItem('s4', from('a', 's4-topic'))!;
    const host = pane('s4');
    const [pair, saved] = [host.livePair, snapshot('s4')];
    try {
      host.tabFill(tab, true)!.toggle();
      expect(host.shownTabIds).toEqual([tab]);
      expect([host.livePair, snapshot('s4')]).toEqual([pair, saved]);
    } finally {
      tabFullscreen.exit();
    }
    setPanelFull('s4', tab, true);
    expect(panelFull('s4', tab)).toBe(true);
    expect(host.shownTabIds).toEqual([tab]);
    expect([host.livePair, snapshot('s4'), host.splitDeclinedKinds.size]).toEqual([pair, saved, 0]);
    setPanelFull('s4', tab, false);
    expect(host.shownTabIds).toEqual([topic, tab]);
    expect(panelFull('s4', tab)).toBe(false);
  });

  it('S5 closing a file: back to its 上一页, else to its source conversation as it is placed', () => {
    const folder = openPanelItem('s5', folderItem())!;
    const fromFolder = openPanelItem('s5', file('101'), { returnTo: folder })!;
    closeChatTab('s5', fromFolder);
    expect(shownPanelTab('s5')?.tabId).toBe(folder);
    closeChatTab('s5', folder);
    expect(chatAlone('s5'), 'the group\'s own file: the group alone').toBe(true);
    const { main, topic } = withTopic('s5');
    const tab = openPanelItem('s5', from('a', 's5-topic'))!;
    closeChatTab('s5', tab);
    expect(pane('s5').shownTabIds, 'a topic\'s file: the topic beside the group again').toEqual([main, topic]);
    expect(focusedChatTab('s5')?.tabId).toBe(topic);
  });

  it('S6 closing a topic: the group alone; a file of it left open goes beside the group', () => {
    withTopic('s6');
    hideTopicTab('s6');
    expect(topicTabOf('s6'), 'put away (its row clicked again): off the screen and the strip').toBeNull();
    expect(chatAlone('s6')).toBe(true);
    withTopic('s6');
    const tab = openPanelItem('s6', from('a', 's6-topic'))!;
    closeTopicTab('s6');
    expect(pane('s6').shownTabIds).toEqual([pane('s6').tabOrder[0], tab]);
  });

  it('S7 a block too narrow for two: the focused half only, the pair kept; wide again, both', () => {
    const { topic } = withTopic('s7');
    const tab = openPanelItem('s7', from('a', 's7-topic'))!;
    const saved = snapshot('s7');
    pane('s7').setDimensions(200, 900);
    expect(pane('s7').shownTabIds).toEqual([tab]);
    expect(panelFull('s7', tab)).toBe(false);
    pane('s7').setDimensions(1600, 900);
    expect(pane('s7').shownTabIds).toEqual([topic, tab]);
    expect(snapshot('s7')).toBe(saved);
  });

  it('S8 a participant beside the group: the group alone while it is there; a tab picked brings the pair back', () => {
    const { topic } = withTopic('s8');
    const tab = openPanelItem('s8', from('a', 's8-topic'))!;
    const pair = pane('s8').livePair;
    runInAction(() => groupParticipantPanes.placements.set('s8', { source: { kind: 'chat', chatId: 's8' }, target: { kind: 'chat', chatId: 'agent' } }));
    expect(pane('s8').shownTabIds).toEqual([pane('s8').tabOrder[0]]);
    expect([pane('s8').livePair, pane('s8').splitDeclinedKinds.size]).toEqual([pair, 0]);
    showChatTab('s8', tab);
    expect(groupParticipantPanes.placements.has('s8')).toBe(false);
    expect(pane('s8').shownTabIds).toEqual([topic, tab]);
    // A tab outside the pair picked while yielded: it takes the pair's other half, as it would with nothing yielded.
    const other = openPanelItem('s8', from('b', 's8'))!;
    showChatTab('s8', tab);
    const [main] = pane('s8').shownTabIds;
    expect(pane('s8').shownTabIds).toEqual([main, tab]);
    runInAction(() => groupParticipantPanes.placements.set('s8', { source: { kind: 'chat', chatId: 's8' }, target: { kind: 'chat', chatId: 'agent' } }));
    showChatTab('s8', other);
    expect(pane('s8').shownTabIds).toEqual([main, other]);
  });

  it('S9a separated by the person: that kind opens as a tab of its own, until they pair it again', () => {
    openPanelItem('s9a', from('a', 's9a'));
    pane('s9a').separatePair();
    expect([...pane('s9a').splitDeclinedKinds]).toEqual([CHAT_PANEL_TAB_KIND]);
    const tab = openPanelItem('s9a', from('b', 's9a'))!;
    expect(pane('s9a').livePair).toBeNull();
    expect(pane('s9a').shownTabIds).toEqual([tab]);
    setPanelFull('s9a', tab, false);
    expect(chatAlone('s9a'), 'a message to reveal: the group comes forward, the choice stays').toBe(true);
    expect([...pane('s9a').splitDeclinedKinds]).toEqual([CHAT_PANEL_TAB_KIND]);
    pane('s9a').splitBeside(tab, 'right');
    expect(pane('s9a').splitDeclinedKinds.size).toBe(0);
  });

  it('S9b sides the person set stay when another page takes the other half', () => {
    openPanelItem('s9b', from('a', 's9b'));
    const main = pane('s9b').tabOrder[0]!;
    pane('s9b').splitBeside(main, 'right');
    const next = openPanelItem('s9b', from('b', 's9b'))!;
    expect(pane('s9b').shownTabIds).toEqual([next, main]);
  });

  it('S10 a restart brings back the pair, the person\'s sides and choices; an unarranged save is placed by rank', () => {
    const tab = openPanelItem('s10', from('a', 's10'))!;
    const main = pane('s10').tabOrder[0]!;
    pane('s10').splitBeside(main, 'right');
    pane('s10').splitDeclinedKinds.add('chat-info');
    pane('s10').solo(tab);
    const saved = chatLayoutOf('s10').snapshot;
    const restart = () => chatTabView.createPaneLayoutStore({ viewId: 'chat:s10-again', place: { kind: 'chat', chatId: 's10' } }, { singleStrip: true });
    const again = restart();
    again.restoreSnapshot(saved);
    const host = again.groups[0]!.pane;
    expect(host.livePair).toMatchObject({ anchor: pane('s10').livePair!.anchor, sideAt: pane('s10').livePair!.sideAt, userPlaced: true });
    expect([...host.splitDeclinedKinds]).toEqual(['chat-info']);
    expect(host.soloTabId, 'what is drawn is not saved').toBeNull();
    const legacy = restart();
    const pairSaved = saved.groups[0]!.tabManager.pair!;
    legacy.restoreSnapshot({ ...saved, groups: [{ ...saved.groups[0]!, tabManager: { ...saved.groups[0]!.tabManager, pair: { anchorTabId: main, sideTabId: pairSaved.anchorTabId === main ? pairSaved.sideTabId : pairSaved.anchorTabId, sideAt: 'left' } } }] });
    expect(legacy.groups[0]!.pane.livePair?.sideAt, 'a side saved before 11-04 without the person\'s mark: by rank').toBe('right');
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
