import { groupDisplayName } from '@gugu/core/shared/ui/chatModels';
import { readChatSummary, resolveChatId } from '@/lib/chatSummariesBridge';
import { projectGroupsStore } from '@renderer/features/projects/stores/project-groups-store';
import { getProjectStore, projectDisplayName } from '@renderer/features/projects/stores/project-selectors';

/**
 * 群名以壳的聊天列表为准。同一个群可绑多个本地文件夹，任取一个项目名会把去处写成那个文件夹。
 * 壳还没读到摘要时才用已知项目名。认不出来 = null，调用方只说「来自群聊」。
 */
export function chatDisplayName(chatId: string): string | null {
  chatId = resolveChatId(chatId) ?? chatId;
  const projectId = projectGroupsStore.projectOfChat(chatId);
  const summary = readChatSummary(chatId);
  const name = summary?.name ?? (projectId ? projectDisplayName(getProjectStore(projectId)) : null);
  return name ? groupDisplayName({ name, alias: summary?.alias }) : null;
}
