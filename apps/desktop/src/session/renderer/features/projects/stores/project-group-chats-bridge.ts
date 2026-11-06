/**
 * 哪些群是项目群(gugu-dev#181:项目群搬进项目页,对话页只剩人和用户群)。写端在这里,读端是聊天页的列表
 * (lib/projectGroupChatsBridge.ts,类型与键只从这里 type-import)。
 *
 * 两棵树同一文档、各是一个 bundle:❌ 让聊天页 import projectGroupsStore(那边拿到的是一份永远没启动的副本)。
 * 形状沿用 window 全局对象那一套;再加一个 window 事件,谁先起来都接得上 —— 聊天页先渲染时桥还不在,事件一来再读。
 */
export const PROJECT_GROUP_CHATS_BRIDGE_KEY = '__GUGU_PROJECT_GROUP_CHATS__' as const;
export const PROJECT_GROUP_CHATS_EVENT = 'gugu:project-group-chats' as const;

/** 项目页和聊天页共用的项目群读数(同群只列一次)。 */
export type ProjectGroupChatsBridge = {
  /** 项目页有对应行的群;聊天页只隐藏这一份。 */
  readonly chatIds: ReadonlySet<string>;
  /** 所有已知绑定的成员,不受项目行显隐影响。 */
  readonly projectMemberIds: ReadonlyMap<string, readonly string[]>;
  /** agent → 它那条会话,只列是某台机器上的会话的 agent。 */
  readonly agentSessions: ReadonlyMap<string, AgentSession>;
};

export type AgentSession = { readonly projectId: string; readonly sessionId: string };

export function publishProjectGroupChats(chatIds: Iterable<string>, projectMemberIds: ReadonlyMap<string, readonly string[]>, agentSessions: ReadonlyMap<string, AgentSession>): void {
  if (typeof window === 'undefined') return;
  const bridge: ProjectGroupChatsBridge = { chatIds: new Set(chatIds), projectMemberIds, agentSessions };
  (window as unknown as Record<string, unknown>)[PROJECT_GROUP_CHATS_BRIDGE_KEY] = bridge;
  window.dispatchEvent(new Event(PROJECT_GROUP_CHATS_EVENT));
}
