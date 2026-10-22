import { useCallback } from 'react';
import { chatSlotKey, readShellSlots } from '@/lib/shellSlots';

/**
 * 留一个格子给壳画一个对话(gugu-dev#181:项目块里的项目群、对话块),壳那边是 components/ChatSlotHost.tsx。
 * 格子挂上就登记,摘掉就注销;格子里的东西归壳的那棵树管,这一侧 ❌ 往里放子元素。
 */
export function ChatSlot({ chatId, className }: { chatId: string; className?: string }) {
  const ref = useCallback((element: HTMLDivElement | null) => readShellSlots()?.setSlot(chatSlotKey(chatId), element), [chatId]);
  return <div ref={ref} className={className} data-chat-slot={chatId} />;
}
