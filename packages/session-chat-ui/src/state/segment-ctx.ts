import type { ChatContext } from '@session-chat/chat-context';
import type { ChatCaches } from '@session-chat/core/caches';
import { isDoubleColumnLayout } from '@session-chat/core/layout/preset';
import type { SegmentCtx } from '@session-chat/core/units';
import type { ChatState } from './chat-state';
import { turnDiscardedId } from './flatten';

/**
 * The one SegmentCtx the transcript is flattened with. The engine renders with it and find searches with it,
 * so what find reaches and what the transcript paints cannot drift apart.
 */
export function segmentCtxFor(context: ChatContext, state: ChatState, caches: ChatCaches, active: boolean): SegmentCtx {
  return {
    caches,
    expanded: (_id: string) => false,
    active,
    // #4874 双栏视图把一轮的过程行折起来；读 theme() 让布局切换重建 committed tier。
    // ⚠️ 不再有 `!active`：正在跑的那一轮同样折（#4981 #12），只是头上换成会微光的
    // 「工作中」标签 —— 与上游 tool-timeline 的 activeLabel / restingLabel 一致。
    foldTurnProcess: isDoubleColumnLayout(context.theme.layout),
    isTurnProcessExpanded: (id: string) => state.viewState.isCollapsed(id),
    // 「丢弃」与折叠共用同一套 per-id 开关，只是换一个 id 命名空间 —— 收尾行那颗按钮身上挂的是
    // `data-collapse-id`，于是它走的就是 ChatRoot 既有的那条点击委派，❌ 不新开一条通路。
    isTurnDiscarded: (id: string) => state.viewState.isCollapsed(turnDiscardedId(id)),
    plan: () => state.session.state.plan,
    translate: context.translate,
    pendingToolCallIds: () => state.session.state.pendingToolCallIds,
    permissionFor: (toolCallId: string) =>
      state.session.state.permissions.find((request) => request.toolCall.toolCallId === toolCallId),
    terminalOutputText: (terminalId: string) => state.session.state.terminalOutputText(terminalId),
    terminalExitStatus: (terminalId: string) => state.session.state.terminalExitStatus(terminalId),
    // 这条会话此刻的状态 —— 只有 active 档会读它(flatten 在那一档的末尾发出这一行)。
    condition: () => state.session.state.condition,
  };
}
