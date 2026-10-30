import { useCallback, useContext, useSyncExternalStore, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { useReportChatOnScreen } from '@/lib/onScreenChat';
import { chatPartSlotKey, chatSlotKey, readShellSlots, type ChatPart } from '@/lib/shellSlots';
import { PageShownContext } from '@renderer/app/recent-session-pages';
import { TabLayerShownContext } from '@renderer/features/tabs/retained-tab-content';
import { isEmbedVisible, subscribeEmbedVisibility } from './portal-container';

/**
 * 留一个格子给壳画一个对话(gugu-dev#181:项目块里的项目群、对话块),壳那边是 components/ChatSlotHost.tsx。
 * 格子挂上就登记,摘掉就注销;格子里的东西归壳的那棵树管,这一侧 ❌ 往里放子元素。
 */
export function ChatSlot({ chatId, className }: { chatId: string; className?: string }) {
  // 这一格真摆在屏上(不在藏着的保留页 / 页签层里,任务页这一框也没被藏):报给壳,通知与「看见即已读」认它(lib/onScreenChat)。
  const pageShown = useContext(PageShownContext);
  const layerShown = useContext(TabLayerShownContext);
  const embedVisible = useSyncExternalStore(subscribeEmbedVisibility, isEmbedVisible);
  useReportChatOnScreen(pageShown && layerShown && embedVisible ? chatId : null);
  const ref = useCallback((element: HTMLDivElement | null) => readShellSlots()?.setSlot(chatSlotKey(chatId), element), [chatId]);
  return <div ref={ref} className={className} data-chat-slot={chatId} />;
}

/** 页签条上留给这个对话的一格(右端那排图标 / 对话块页签上的头像和名字),壳把群聊组件的那一部分画进来。 */
export function ChatPartSlot({ chatId, part, className }: { chatId: string; part: ChatPart; className?: string }) {
  const ref = useCallback((element: HTMLSpanElement | null) => readShellSlots()?.setSlot(chatPartSlotKey(part, chatId), element), [chatId, part]);
  return <span ref={ref} className={className} data-chat-part={part} />;
}

/** Keep the project home in its renderer context, inside the empty conversation column. */
export function ChatEmptyContent({ chatId, children }: { chatId: string; children: ReactNode }) {
  const slots = readShellSlots();
  const target = useSyncExternalStore(
    (listener) => slots?.subscribeSlots(listener) ?? (() => {}),
    () => slots?.getSlots().get(chatPartSlotKey('empty', chatId)) ?? null,
    () => null,
  );
  return target ? createPortal(children, target) : null;
}
