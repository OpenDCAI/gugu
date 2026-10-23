import type { ReactNode } from 'react';
import type { GuardResult } from '@renderer/app/view-registry';

/** Renders nothing of its own: it exists so the view registry can type the chat view's params. */
function ChatViewWrapper({ children }: { children: ReactNode; chatId: string }) {
  return <>{children}</>;
}

/**
 * 看一条对话(gugu-dev#181:对话也是一块,和项目块、会话块同一屏、能拼在一组)。对话由壳画进这屏的对话块
 * (screen-frame 的 ChatSlot),所以这里只有参数和守卫,主区由 Workspace 按「这屏」画 —— 同 projectView。
 */
export const chatView = {
  WrapView: ChatViewWrapper,
  MainPanel: () => null,
  canActivate: (params: unknown): GuardResult => {
    const chatId = typeof params === 'object' && params !== null ? (params as { chatId?: unknown }).chatId : undefined;
    return typeof chatId === 'string' && chatId.length > 0 ? { ok: true } : { ok: false, redirect: 'home' };
  },
};
