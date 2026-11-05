import type { ScreenBlockContent } from '@renderer/app/screen-layout';
import { screenLayout } from '@renderer/app/screen-layout';
import { auxWindows } from '@renderer/app/aux-windows';
import { returnToScreen } from '@renderer/app/screen-layout-actions';
import { sidebarStore } from '@renderer/lib/stores/app-state';
import { projectGroupsStore } from '@renderer/features/projects/stores/project-groups-store';
import { yieldChatAuxiliary } from './chat-tabs/chat-layouts';
import { groupParticipantPanes } from './group-participant-panes';

function sourceContent(chatId: string): ScreenBlockContent {
  // A shared group may have several project bindings. Its sidebar representative can change while
  // the previous project is still on screen; placement belongs to that visible group, not the row.
  for (const id of screenLayout.order) {
    const content = screenLayout.blocks.get(id);
    if (content?.kind === 'project' && projectGroupsStore.chatIdOf(content.projectId) === chatId) return content;
    if (content?.kind === 'chat' && content.chatId === chatId) return content;
  }
  const projectId = projectGroupsStore.projectOfChat(chatId);
  return projectId ? { kind: 'project', projectId: sidebarStore.rowProjectIdOf(projectId) } : { kind: 'chat', chatId };
}

/** Commit only once a real workspace exists; nothing navigates away from the group while it is loading. */
export function showGroupParticipant(sourceChatId: string, target: ScreenBlockContent): void {
  const source = sourceContent(sourceChatId);
  const sourceId = screenLayout.blockOf(source);
  if (!sourceId) return;
  const windowed = target.kind === 'session' ? auxWindows.windowOfSession(target.sessionId) : undefined;
  if (windowed) {
    windowed.handle?.focus();
    return;
  }
  const previous = groupParticipantPanes.placements.get(sourceChatId);
  if (!previous && !screenLayout.canPlaceAt(target, sourceId)) throw new Error('No room to open this conversation beside the group');
  const blockElement = (id: string | undefined) => id && typeof document !== 'undefined'
    ? document.querySelector<HTMLElement>(`[data-screen-block="${id}"]`) : null;
  const extent = (blockElement(sourceId)?.getBoundingClientRect().width ?? 0)
    + (previous ? blockElement(screenLayout.blockOf(previous.target))?.getBoundingClientRect().width ?? 0 : 0);
  // Preserve topic/file/App tabs, while yielding their visible half to the participant's own workspace.
  yieldChatAuxiliary(sourceChatId);
  if (!groupParticipantPanes.show(sourceChatId, source, target, extent)) throw new Error('No room to open this conversation beside the group');
  returnToScreen();
}
