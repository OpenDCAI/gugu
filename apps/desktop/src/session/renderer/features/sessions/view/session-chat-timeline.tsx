import { observer } from 'mobx-react-lite';
import type { ReactNode } from 'react';
import { usePaneContext } from '@renderer/features/tabs/pane-context';
import { cn } from '@renderer/utils/utils';
import type { AcpChatTabResource } from '../acp/acp-chat-tab-resource';
import { SessionTimeline, useSessionTimelinePresence } from './session-timeline';

/**
 * 对话左缘那列时间线刻度(#4874,owner 2026-09-03:常驻)。原来画在聊天栏外框上;对话成了会话的一枚页签之后
 * (#7052),它跟着对话本身走:这一格正在看哪条通用模式的会话,就画哪条的刻度。左边那条 24px 车道只在真有刻度可画时
 * 预留 —— 还没开跑的会话不留空槽(编程模式的会话不走这里,它没有刻度)。右边留同样宽:对话列和输入框照旧在这一块里
 * 居中,和项目群、新建会话页的输入框在同一个位置(gugu-dev#181 核对 21:只留左边时整列右偏 12px)。
 */
export const SessionChatTimeline = observer(function SessionChatTimeline({ children }: { children: ReactNode }) {
  const { pane } = usePaneContext();
  const activeTab = pane.resolvedTabs.find((tab) => tab.isActive && tab.kind === 'acp-chat');
  const sessionId = activeTab ? (activeTab.resource as AcpChatTabResource).store.sessionId : undefined;
  const hasTimeline = useSessionTimelinePresence(sessionId);
  return (
    // 「聚焦输入框」找的是 [data-region="composer"]:只有真在这一格前面的对话才挂这个标记,❌ 每一格藏着的那份也挂。
    <div className={cn('relative h-full min-h-0', hasTimeline && 'bg-background-secondary-1 px-6')} data-region={activeTab ? 'composer' : undefined}>
      {hasTimeline && sessionId && <SessionTimeline sessionId={sessionId} />}
      {children}
    </div>
  );
});
