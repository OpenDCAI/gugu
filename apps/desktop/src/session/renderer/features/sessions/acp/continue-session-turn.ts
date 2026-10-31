import type { AcpChatStore } from './acp-chat-store';

/**
 * 「继续」是真发送：cancel 后会话还活着，agent 上下文保留了被切断的输出，
 * 发一条新指令接着往下；与取回失败原指令到草稿不同，不能重放可能已执行过的原指令。
 */
export function continueSessionTurn(store: AcpChatStore | null | undefined, text: string): void {
  if (!store) return;
  // The composer's one send: the host queues it behind a running turn (custody), it never steers into one.
  store.submitPrompt(text);
}
