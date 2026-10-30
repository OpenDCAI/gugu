import type { AcpChatStore } from './acp-chat-store';

/**
 * 「继续」是真发送：cancel 后会话还活着，agent 上下文保留了被切断的输出，
 * 发一条新指令接着往下；与取回失败原指令到草稿不同，不能重放可能已执行过的原指令。
 */
export function continueSessionTurn(store: AcpChatStore | null | undefined, text: string): void {
  if (!store) return;
  // 这颗按钮长在已经结算的行上，后面又起了一轮时那行仍留在屏幕里。
  // 与 composer 同一规则：空闲 submit、在跑 queue。无条件 submit 会把指令塞进正在跑的会话。
  if (store.affordances.isWorking) store.queuePrompt(text);
  else store.submitPrompt(text);
}
