import {
  collectBackgroundCommandRoster,
  collectSubagentRoster,
  type BackgroundCommandEntry,
  type SubagentRosterEntry,
} from '@gugu/session-chat-ui';
import { findAcpChatStore } from '@renderer/features/sessions/acp/acp-chat-resource-manager';
import { isSubagentDismissed } from './subagent-dismissals';

/**
 * 这条会话里还在跑的子智能体与后台命令 —— 消息列表末尾那一行(`background-tasks`)画的就是它们。
 *
 * 从前它们住在右上角「输出/来源」卡里(那两节的收集逻辑原样挪过来);owner 2026-10-27 把那张卡连同按钮去掉,
 * 后台任务直接放进主对话。
 *
 * 会话页的 store 在 `AcpChatResourceManager` 里。调用方要在 mobx 的反应里读(`autorun` / `observer`)——
 * `transcriptRevision` 是显式读的那一个依赖(❌ `messageCount`:子智能体的调用折进旧轮,条数不变)。
 */
export function collectSubagents(sessionId: string | undefined, fallbackName: string): SubagentRosterEntry[] {
  if (!sessionId) return [];
  const store = findAcpChatStore(sessionId);
  if (!store) return [];
  void store.transcriptRevision;
  const transcript = store.chatState.transcript.state;
  return collectSubagentRoster(
    transcript.committedTurns,
    transcript.activeTurnSnapshot,
    fallbackName
    // 「我不看它了」是显示层的事,所以过滤在这儿、不在 `collectSubagentRoster` 里:
    // 那个函数是纯的,它只该回答「谁还在跑」,不该知道有人按过 ×。
  ).filter((entry) => !isSubagentDismissed(sessionId, entry.id));
}

/**
 * 主智能体自己起的后台命令(#5117)。它不挂住这一轮 —— 轮当场收口、进程照跑,转录里那次调用也早就 completed 了
 * ⇒ 「还有东西在跑」只有列表末尾那一行在说,那一行也是唯一能把它停下来的地方。
 */
export function collectBackgroundCommands(sessionId: string | undefined, fallbackName: string): BackgroundCommandEntry[] {
  if (!sessionId) return [];
  const store = findAcpChatStore(sessionId);
  if (!store) return [];
  void store.messageCount;
  const transcript = store.chatState.transcript.state;
  return collectBackgroundCommandRoster(
    transcript.committedTurns,
    transcript.activeTurnSnapshot,
    fallbackName,
    // 库里读出来的旧轮可能是上一个进程起的命令,随进程没了、永远等不来终态 —— 只留运行时说还在跑的(#6582)。
    store.runningBackgroundTaskIds
    // 「我不看它了」与子智能体共用同一张收起表(键里带条目 id)。
  ).filter((entry) => !isSubagentDismissed(sessionId, entry.id));
}
