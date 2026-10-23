/**
 * 哪些群是项目群(gugu-dev#181:项目群搬进项目页,对话页只剩人和用户群)。写端在这里,读端是聊天页的列表
 * (lib/projectGroupChatsBridge.ts,类型与键只从这里 type-import)。
 *
 * 两棵树同一文档、各是一个 bundle:❌ 让聊天页 import projectGroupsStore(那边拿到的是一份永远没启动的副本)。
 * 形状沿用 window 全局对象那一套;再加一个 window 事件,谁先起来都接得上 —— 聊天页先渲染时桥还不在,事件一来再读。
 */
export const PROJECT_GROUP_CHATS_BRIDGE_KEY = '__GUGU_PROJECT_GROUP_CHATS__' as const;
export const PROJECT_GROUP_CHATS_EVENT = 'gugu:project-group-chats' as const;

/** 这台电脑与连着的每台机器上、各个本地项目绑的群(同一个群可能被几台机器上的项目绑着,这里只列一次)。 */
export type ProjectGroupChatsBridge = { readonly chatIds: ReadonlySet<string> };

export function publishProjectGroupChats(chatIds: Iterable<string>): void {
  if (typeof window === 'undefined') return;
  const bridge: ProjectGroupChatsBridge = { chatIds: new Set(chatIds) };
  (window as unknown as Record<string, unknown>)[PROJECT_GROUP_CHATS_BRIDGE_KEY] = bridge;
  window.dispatchEvent(new Event(PROJECT_GROUP_CHATS_EVENT));
}
