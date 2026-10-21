import type { AcpChatResourceManager } from './acp-chat-resource-manager';

/**
 * 对话页签(acp-chat / side-chat)的 provider 从这里取会话的对话资源，真实现由任务页入口装上(@@@tab-views 同一处)。
 * AcpChatResourceManager → AcpChatStore 连着整套对话引擎(@gugu/session-chat-ui:markdown、mermaid、shiki 高亮):
 * provider 直接 import 它,咕咕主界面(手机也是)启动时就够得着这一大坨 —— 手机从来不开这两种页签。
 * 桌面上任务页入口在启动时就求值，比任何页签 initialize 都早;没装就是装置出错，当场抛。
 */
type GetAcpChatResources = (sessionId: string, projectId: string) => AcpChatResourceManager;

let get: GetAcpChatResources | null = null;

export function installAcpChatResources(fn: GetAcpChatResources): void {
  get = fn;
}

export function acpChatResources(sessionId: string, projectId: string): AcpChatResourceManager {
  if (!get) throw new Error('acp chat resources are not installed (session-tab-views installs them at task-page boot)');
  return get(sessionId, projectId);
}
