import { readChatSummary } from '@/lib/chatSummariesBridge';
import { projectGroupsStore } from '@renderer/features/projects/stores/project-groups-store';
import { getProjectStore, projectDisplayName } from '@renderer/features/projects/stores/project-selectors';

/**
 * 一个群在会话页里叫什么(会话里「来自 X」、时间轴上那一格):项目群就是项目名;别的群读咕咕壳的聊天列表那一份
 * (chatSummariesBridge)。认不出来 = null,调用方只说「来自群聊」,❌ 写信封里的群号。
 */
export function chatDisplayName(chatId: string): string | null {
  const projectId = projectGroupsStore.projectOfChat(chatId);
  return (projectId ? projectDisplayName(getProjectStore(projectId)) : null) ?? readChatSummary(chatId)?.name ?? null;
}
